# Browser Use Extension Kernel — Design Spec

## Overview

A Manifest V3 Chrome extension that replicates OpenClaw's browser automation capabilities as a standalone, installable plugin. The extension connects to any OpenAI-compatible API and takes natural language commands from a side panel chat UI, then autonomously navigates the browser using an agentic tool-use loop.

**Scope:** This is the "kernel" — core automation engine and minimal UI. Advanced UX, use-case-specific features, and multi-API management are out of scope for v1.

**Inspiration:** [OpenClaw Browser Tool](https://docs.openclaw.ai/tools/browser) — the extension mirrors its architecture: accessibility-tree snapshots with numbered refs, CDP-based actions, and a deterministic agent loop.

## Architecture

### Components

```
browser-use-extension/
  manifest.json                    ← Manifest V3 config
  src/
    background/
      service-worker.ts            ← Entry point, message routing
      cdp-manager.ts               ← chrome.debugger wrapper
      snapshot-engine.ts           ← Accessibility tree → refs
      action-executor.ts           ← Execute actions via CDP
      llm-client.ts                ← OpenAI-compatible API client
      agent-loop.ts                ← Snapshot → LLM → action cycle
      tool-definitions.ts          ← Tool schemas for the LLM
      types.ts                     ← Shared type definitions
    sidepanel/
      index.html                   ← Side panel markup
      panel.ts                     ← Chat UI logic
      panel.css                    ← Minimal styling
    options/
      index.html                   ← Options page markup
      options.ts                   ← Settings logic
      options.css                  ← Minimal styling
```

### Data Flow

```
User types prompt in Side Panel
    |
    v
Side Panel connects to Service Worker via chrome.runtime.connect (persistent port)
    |
    v
Service Worker starts Agent Loop:
    1. Attach to active tab via chrome.debugger.attach
    2. Take snapshot: Accessibility.getFullAXTree via CDP
    3. Build ref map: assign e1, e2, e3... to interactive/named nodes
    4. Format snapshot as text for LLM
    5. Send snapshot + conversation history + tool definitions to LLM API
    6. LLM responds with tool_calls (click, type, navigate, etc.)
    7. Execute each tool call via CDP commands (Input, DOM, Page domains)
    8. Collect results, take fresh snapshot if page changed
    9. Send tool results + new snapshot back to LLM
    10. Repeat until LLM returns text response (no tool calls) or user stops
    |
    v
Side Panel receives real-time status updates via port.onMessage
```

### Manifest

Complete `manifest.json` structure:

```json
{
  "manifest_version": 3,
  "name": "Browser Use",
  "version": "0.1.0",
  "description": "AI-powered browser automation via natural language",
  "permissions": [
    "debugger",
    "activeTab",
    "tabs",
    "sidePanel",
    "storage"
  ],
  "host_permissions": [
    "https://*/*",
    "http://*/*"
  ],
  "background": {
    "service_worker": "service-worker.js"
  },
  "side_panel": {
    "default_path": "sidepanel/index.html"
  },
  "options_page": "options/index.html",
  "action": {
    "default_title": "Browser Use",
    "default_icon": {
      "16": "icons/16.png",
      "48": "icons/48.png",
      "128": "icons/128.png"
    }
  },
  "icons": {
    "16": "icons/16.png",
    "48": "icons/48.png",
    "128": "icons/128.png"
  }
}
```

**Permissions:**
- `debugger` — CDP access via `chrome.debugger` (core of all browser automation)
- `activeTab` — access the current tab
- `tabs` — list/open/close/focus tabs
- `sidePanel` — persistent side panel UI
- `storage` — persist API settings

**Host permissions:**
- `https://*/*` and `http://*/*` — required for the service worker to make cross-origin `fetch()` calls to the LLM API. Without these, API calls fail. The broad wildcard triggers a permission warning at install; this is acceptable since the extension needs to reach any user-configured API endpoint.

**Minimum Chrome version:** 118+ (required for `chrome.debugger` to keep the service worker alive during debugging sessions).

## Component Details

### 1. CDP Manager (`cdp-manager.ts`)

Wraps `chrome.debugger` into a clean async interface. Equivalent to OpenClaw's `cdp.helpers.ts`.

**API:**

```typescript
class CDPManager {
  // Lifecycle
  attach(tabId: number): Promise<void>
  detach(tabId: number): Promise<void>
  detachAll(): Promise<void>
  isAttached(tabId: number): boolean

  // Commands
  send<T>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T>

  // Events
  onEvent(callback: (tabId: number, method: string, params: unknown) => void): void
  onDetach(callback: (tabId: number, reason: string) => void): void
}
```

**Implementation notes:**
- Uses `chrome.debugger.attach(target, "1.3")` (CDP protocol version 1.3)
- Wraps callback-based `chrome.debugger` APIs in Promises
- Tracks attached tabs to avoid double-attach errors
- Auto-detaches on tab close or navigation away
- Listens to `chrome.debugger.onEvent` for CDP events (console, network, etc.)
- Listens to `chrome.debugger.onDetach` to clean up state

**Domain initialization:** After attaching to a tab, the CDP Manager must enable required domains before use:
```
Accessibility.enable()   — required for stable AXNodeId values in getFullAXTree
Page.enable()            — required for Page events (loadEventFired, frameStoppedLoading)
Network.enable()         — required when using cookie features
```
This happens automatically in the `attach()` method.

**Note on Accessibility domain:** The `Accessibility` CDP domain (including `getFullAXTree`) is marked as **Experimental** in the CDP protocol spec. In practice, Chrome ships these methods and they are widely used. The implementation should handle unexpected response shapes gracefully in case of future changes.

**CDP domains used:**

| Domain | Methods | Purpose |
|--------|---------|---------|
| `Accessibility` | `getFullAXTree` | Page snapshots |
| `Page` | `navigate`, `captureScreenshot`, `printToPDF`, `enable` | Navigation, screenshots, PDF |
| `DOM` | `getDocument`, `querySelector`, `getBoxModel`, `resolveNode`, `focus`, `scrollIntoViewIfNeeded`, `describeNode` | Element resolution, focus, scroll |
| `Input` | `dispatchMouseEvent`, `dispatchKeyEvent`, `insertText` | Click, type, press, hover, drag |
| `Runtime` | `evaluate`, `callFunctionOn` | JS execution, wait predicates, select/fill helpers |
| `Network` | `getCookies`, `setCookie`, `deleteCookies`, `enable` | Cookie management |
| `Emulation` | `setDeviceMetricsOverride`, `setGeolocationOverride`, `setTimezoneOverride`, `setLocaleOverride` | Device/environment emulation |

### 2. Snapshot Engine (`snapshot-engine.ts`)

Builds a **hybrid snapshot** combining an accessibility tree (text) with a page screenshot (image). This dual-channel approach is how both Claude Code's Chrome extension (screenshot-first) and OpenClaw (snapshot-first) achieve reliable page understanding. The text snapshot provides structured, actionable refs; the screenshot provides visual context that catches layout, images, charts, and UI states the accessibility tree misses.

**How it works:**

1. Call `Accessibility.getFullAXTree` via CDP Manager → text snapshot with refs
2. Call `Page.captureScreenshot` via CDP Manager → viewport screenshot as base64 PNG
3. Walk the accessibility tree, filter out irrelevant nodes
4. Assign refs (`e1`, `e2`, `e3`...) based on role categories
5. Build compact text representation for the LLM
6. Store ref→node mapping for action resolution
7. Return both the text snapshot and screenshot as a `HybridSnapshot`

```typescript
interface HybridSnapshot {
  text: string;              // Formatted accessibility tree with refs
  screenshotBase64: string;  // Viewport screenshot as base64 PNG
  refMap: RefMap;             // ref → node mapping for actions
  metadata: {
    url: string;
    title: string;
    truncated: boolean;
    totalElements: number;
    visibleElements: number;
  };
}
```

The agent receives **both** the text snapshot (as text content) and the screenshot (as an image content block) in each observation. The text provides the refs for actions; the screenshot helps the LLM understand visual layout, recognize images/icons, and handle cases where the accessibility tree is incomplete.

**Ref assignment rules (matching OpenClaw):**

```typescript
const INTERACTIVE_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton',
  'switch', 'tab', 'textbox', 'treeitem'
]);

const CONTENT_ROLES = new Set([
  'heading', 'img', 'listitem', 'cell', 'row', 'table', 'list',
  'paragraph', 'blockquote', 'code', 'contentinfo', 'navigation',
  'banner', 'main', 'complementary', 'form', 'region', 'alert',
  'dialog', 'status', 'tooltip'
]);

// INTERACTIVE_ROLES → always get a ref
// CONTENT_ROLES → get a ref when they have a name
// Everything else (generic, group, div) → skipped
```

**Output format (sent to LLM):**

```
Page: "Search Flights — TravelSite" | URL: https://travel.example.com/search

[e1] heading "Search Flights"
[e2] textbox "From" value="New York"
[e3] textbox "To"
[e4] textbox "Date"
[e5] button "Search"
[e6] link "Advanced Options"
[e7] navigation "Main Menu"
  [e8] link "Home"
  [e9] link "My Trips"
  [e10] link "Account"
```

**Ref map (internal state):**

```typescript
interface RefEntry {
  backendNodeId: number;    // CDP backend node ID (stable across calls)
  nodeId?: number;          // CDP DOM node ID (may change)
  role: string;
  name: string;
  value?: string;
  properties?: Record<string, unknown>;
}

type RefMap = Map<string, RefEntry>;  // "e1" → RefEntry
```

**Key behaviors:**
- Ref map is rebuilt on every snapshot call (refs are ephemeral, not stable across navigations)
- Tree is indented to show hierarchy (2 spaces per level)
- Values are shown for inputs (textbox, combobox, etc.)
- Max depth and max chars are configurable to stay within LLM context limits
- Focused/checked/disabled states are annotated

### 3. Action Executor (`action-executor.ts`)

Executes browser actions using the ref map from the snapshot. Equivalent to OpenClaw's `pw-tools-core.interactions.ts` + `agent.act.ts`.

**Core pattern for ref-based actions:**

```
1. Look up ref in RefMap → get backendNodeId
2. DOM.resolveNode({backendNodeId}) → get objectId (for Runtime.callFunctionOn)
3. DOM.getBoxModel({backendNodeId}) → get BoxModel
4. Extract center from content quad:
     const quad = boxModel.model.content;  // [x1,y1, x2,y2, x3,y3, x4,y4]
     const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
     const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
5. Dispatch input events at (x, y)
```

**Note:** `DOM.getBoxModel` returns `{model: {content, padding, border, margin, width, height}}` where each geometry field is a `Quad` — an array of 8 numbers representing 4 corner points as `[x1,y1, x2,y2, x3,y3, x4,y4]`. This center-point calculation is used by `click`, `hover`, and `drag`.

**Action implementations:**

#### click(ref, options?)
```
DOM.scrollIntoViewIfNeeded({backendNodeId})
DOM.getBoxModel({backendNodeId}) → extract center (x, y) from content quad
Input.dispatchMouseEvent({type: "mouseMoved", x, y})
Input.dispatchMouseEvent({type: "mousePressed", x, y, button: "left", clickCount: 1})
Input.dispatchMouseEvent({type: "mouseReleased", x, y, button: "left", clickCount: 1})
```
Options: `doubleClick` (clickCount: 2), `button` (left/right/middle), `modifiers` (Alt/Control/Meta/Shift)

#### type(ref, text, options?)
```
DOM.focus({backendNodeId})
# Clear existing value if needed:
Runtime.callFunctionOn({objectId, function: "function(){this.value='';this.dispatchEvent(new Event('input',{bubbles:true}))}"})
# Type text:
Input.insertText({text})
# If submit flag:
Input.dispatchKeyEvent({type: "keyDown", key: "Enter", code: "Enter"})
Input.dispatchKeyEvent({type: "keyUp", key: "Enter", code: "Enter"})
```
Options: `submit` (press Enter after typing), `slowly` (dispatch individual keyDown/keyUp per character)

#### navigate(url)
```
Page.navigate({url})
# Wait for page load via Page.loadEventFired or polling
```

#### screenshot(options?)
```
Page.captureScreenshot({format: "png"})
→ returns base64 string
```
Options: `fullPage` (capture entire scrollable area via `captureBeyondViewport: true`), `clip` (capture specific region)
Note: PNG is lossless; `quality` parameter only applies to JPEG format.

#### press(key)
```
Input.dispatchKeyEvent({type: "keyDown", key, code})
Input.dispatchKeyEvent({type: "keyUp", key, code})
```
Key mapping: Enter, Tab, Escape, ArrowUp/Down/Left/Right, Backspace, Delete, etc.

#### scroll(ref)
```
DOM.scrollIntoViewIfNeeded({backendNodeId})
```

#### hover(ref)
```
DOM.getBoxModel({backendNodeId}) → extract center (x, y) from content quad
Input.dispatchMouseEvent({type: "mouseMoved", x, y})
```

#### drag(startRef, endRef)
```
getBoxModel(startRef) → extract center (x1, y1) from content quad
getBoxModel(endRef) → extract center (x2, y2) from content quad
Input.dispatchMouseEvent({type: "mousePressed", x: x1, y: y1, button: "left"})
# Move in steps for realistic drag:
for step in interpolate(x1,y1 → x2,y2):
  Input.dispatchMouseEvent({type: "mouseMoved", x: step.x, y: step.y})
Input.dispatchMouseEvent({type: "mouseReleased", x: x2, y: y2, button: "left"})
```

#### select(ref, values)
```
DOM.resolveNode({backendNodeId}) → objectId
Runtime.callFunctionOn({objectId, function: selectHelperFn, arguments: values})
# Helper selects matching <option> elements and dispatches change event
```

#### fill(fields)
```
For each {ref, type, value} in fields:
  if type == "checkbox" or "radio": click if current state != desired
  if type == "select": select(ref, [value])
  else: type(ref, value)
```

#### wait(conditions)
```
Poll via Runtime.evaluate:
  - text: document.body.innerText.includes(text)
  - textGone: !document.body.innerText.includes(text)
  - selector: document.querySelector(selector) !== null
  - url: location.href matches pattern
  - fn: evaluate custom JS predicate
  - loadState: listen for Page.loadEventFired / Page.frameStoppedLoading
Timeout after configurable ms (default 10000)
```

#### evaluate(fn, ref?)
```
If ref provided:
  DOM.resolveNode({backendNodeId}) → objectId
  Runtime.callFunctionOn({objectId, functionDeclaration: fn})
Else:
  Runtime.evaluate({expression: fn})
```

#### Tab operations
```
tab_list:   chrome.tabs.query({})
tab_open:   chrome.tabs.create({url}) → attach debugger to new tab
tab_close:  chrome.tabs.remove(tabId) → detach debugger
tab_focus:  chrome.tabs.update(tabId, {active: true}) → attach debugger if needed
```

#### Cookies
```
cookies_get:   Network.getCookies({urls: [currentUrl]})
cookies_set:   Network.setCookie({name, value, url, ...})
cookies_clear: Network.deleteCookies({name, url})
```

#### Emulation
```
set_viewport:  Emulation.setDeviceMetricsOverride({width, height, deviceScaleFactor, mobile})
set_device:    Lookup preset → setDeviceMetricsOverride + setUserAgentOverride
set_geo:       Emulation.setGeolocationOverride({latitude, longitude, accuracy})
set_timezone:  Emulation.setTimezoneOverride({timezoneId})
set_locale:    Emulation.setLocaleOverride({locale})
```

#### PDF
```
Page.printToPDF({}) → base64 string → download via blob URL
```

### 4. LLM Client (`llm-client.ts`)

Connects to any OpenAI-compatible chat completions endpoint.

**Configuration (persisted in chrome.storage.local):**

```typescript
interface LLMConfig {
  apiBaseUrl: string;      // e.g., "https://api.openai.com/v1"
  apiKey: string;          // Bearer token
  modelName: string;       // e.g., "gpt-4o"
  maxTokens: number;       // Response limit (default: 4096)
  temperature: number;     // Generation temperature (default: 0.2)
  screenshotDetail: 'low' | 'high';  // Vision detail level (default: 'low')
}
```

**Vision support:** The LLM client sends multi-part messages containing both text and image content blocks (OpenAI vision format). This requires a vision-capable model (e.g., `gpt-4o`, `claude-sonnet-4-20250514` via proxy, `llava` on Ollama). If the model does not support vision, the screenshot is silently omitted and only the text snapshot is sent.

**API call:**

```typescript
async function chatCompletion(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  config: LLMConfig
): Promise<ChatCompletionResponse> {
  const response = await fetch(`${config.apiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: config.modelName,
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: config.maxTokens,
      temperature: config.temperature
    })
  });
  return response.json();
}
```

**Error handling:**
- Retry with exponential backoff on 429 (rate limit) and 5xx errors
- Max 3 retries
- Surface clear error messages to the side panel on auth failures (401/403)

### 5. Agent Loop (`agent-loop.ts`)

Orchestrates the snapshot → LLM → action cycle. The core agentic engine.

**State:**

```typescript
interface AgentState {
  status: 'idle' | 'running' | 'paused' | 'error';
  conversationHistory: ChatMessage[];
  currentTabId: number | null;
  iteration: number;
  maxIterations: number;       // Default: 50
  actionDelayMs: number;       // Default: 500ms between actions
}
```

**System prompt template:**

```
You are a browser automation agent. You control a Chrome browser to accomplish the user's task.

You can see the page in two ways:
1. An accessibility snapshot showing interactive elements with refs like [e1], [e2], etc. Use these refs to interact with elements.
2. A screenshot of the current viewport for visual context — helps you understand layout, images, icons, and visual states.

Use the text snapshot for finding elements and their refs. Use the screenshot to understand what the page looks like visually. Together they give you a complete picture.

Available tools: [tool definitions injected here]

Instructions:
- Use snapshot to understand the page before acting
- Use refs from the most recent snapshot (they change on navigation)
- Take a new snapshot after navigation or major page changes
- The screenshot shows the viewport only; scroll to see more content
- When the task is complete, respond with a text message summarizing what was done
- If you get stuck, describe the problem and ask the user for guidance
```

**Hybrid observation format (sent to LLM):**

Each observation is a multi-part message using the OpenAI content array format:

```typescript
{
  role: 'user',
  content: [
    {
      type: 'text',
      text: `Current page: ${url}\nTitle: ${title}\n\n${snapshotText}`
    },
    {
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${screenshotBase64}`,
        detail: 'low'  // 'low' for speed/tokens, 'high' for detail
      }
    }
  ]
}
```

The `detail` parameter defaults to `'low'` (faster, fewer tokens) but can be configured to `'high'` in settings for tasks that need pixel-level precision. This follows the OpenAI vision API format, which is also supported by compatible endpoints (Anthropic via proxy, Ollama with vision models, etc.).

**Loop logic:**

```
function runAgentLoop(userPrompt):
  state.status = 'running'
  state.iteration = 0

  # Initial hybrid snapshot (text + screenshot)
  snapshot = snapshotEngine.takeHybridSnapshot(state.currentTabId)

  # Build initial messages
  state.conversationHistory = [
    {role: 'system', content: buildSystemPrompt()},
    buildObservationMessage(snapshot),   # multi-part: text snapshot + screenshot image
    {role: 'user', content: userPrompt}
  ]

  while state.status == 'running' && state.iteration < state.maxIterations:
    state.iteration++

    # Call LLM
    response = llmClient.chatCompletion(state.conversationHistory, toolDefinitions)

    # Check for text response (task complete)
    if response.message.content && !response.message.tool_calls:
      sendToSidePanel({type: 'agent_message', text: response.message.content})
      state.status = 'idle'
      break

    # Process tool calls
    if response.message.tool_calls:
      state.conversationHistory.push(response.message)  # assistant message with tool_calls

      for toolCall in response.message.tool_calls:
        sendToSidePanel({type: 'action', tool: toolCall.function.name, args: toolCall.function.arguments})

        # Execute action
        result = actionExecutor.execute(toolCall.function.name, JSON.parse(toolCall.function.arguments))

        # Add tool result to conversation
        state.conversationHistory.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        })

        await sleep(state.actionDelayMs)

      # Take fresh hybrid snapshot if page likely changed
      if pageChanged:
        newSnapshot = snapshotEngine.takeHybridSnapshot(state.currentTabId)
        state.conversationHistory.push(buildObservationMessage(newSnapshot))

  if state.iteration >= state.maxIterations:
    sendToSidePanel({type: 'error', text: 'Max iterations reached'})
    state.status = 'idle'
```

**Stopping the loop:**
- User clicks "Stop" in side panel → sends stop message → sets `state.status = 'idle'`
- Loop checks status before each LLM call and each action execution

**Page change detection:**
After executing actions, compare current URL/title with previous. If changed, or if the action was `navigate`, `click` (on a link), `tab_focus`, or `tab_open`, take a fresh snapshot.

### 6. Tool Definitions (`tool-definitions.ts`)

OpenAI function-calling format tool schemas sent to the LLM.

**Full tool list:**

```typescript
const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'snapshot',
      description: 'Take a snapshot of the current page to see its accessibility tree with element refs. Call this after navigation or when you need to see the current page state.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click on an element identified by its ref from the snapshot.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot (e.g., "e5")' },
          doubleClick: { type: 'boolean', description: 'Double-click instead of single click' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button' },
          modifiers: { type: 'array', items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift'] } }
        },
        required: ['ref']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'type',
      description: 'Type text into an input element identified by its ref.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref from snapshot' },
          text: { type: 'string', description: 'Text to type' },
          submit: { type: 'boolean', description: 'Press Enter after typing' },
          slowly: { type: 'boolean', description: 'Type one character at a time (for sites that need key events)' }
        },
        required: ['ref', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate the current tab to a URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to navigate to' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Capture a screenshot of the current page. Returns base64-encoded PNG. Use when you need to visually inspect the page.',
      parameters: {
        type: 'object',
        properties: {
          fullPage: { type: 'boolean', description: 'Capture the full scrollable page' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'press',
      description: 'Press a keyboard key.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key to press (e.g., "Enter", "Tab", "Escape", "ArrowDown")' }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Scroll an element into view.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref to scroll into view' }
        },
        required: ['ref']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'hover',
      description: 'Hover over an element.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref to hover over' }
        },
        required: ['ref']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'drag',
      description: 'Drag from one element to another.',
      parameters: {
        type: 'object',
        properties: {
          startRef: { type: 'string', description: 'Ref of element to drag from' },
          endRef: { type: 'string', description: 'Ref of element to drag to' }
        },
        required: ['startRef', 'endRef']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'select',
      description: 'Select option(s) in a dropdown/select element.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Ref of the select element' },
          values: { type: 'array', items: { type: 'string' }, description: 'Option values to select' }
        },
        required: ['ref', 'values']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fill',
      description: 'Batch fill multiple form fields at once.',
      parameters: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ref: { type: 'string' },
                type: { type: 'string', enum: ['text', 'checkbox', 'radio', 'select'] },
                value: { type: 'string' }
              },
              required: ['ref', 'type', 'value']
            }
          }
        },
        required: ['fields']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: 'Wait for a condition before continuing.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Wait for this text to appear on the page' },
          textGone: { type: 'string', description: 'Wait for this text to disappear' },
          selector: { type: 'string', description: 'Wait for this CSS selector to exist' },
          url: { type: 'string', description: 'Wait for URL to match (supports glob patterns)' },
          fn: { type: 'string', description: 'Wait for this JS expression to return truthy' },
          timeoutMs: { type: 'number', description: 'Timeout in ms (default: 10000)' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'evaluate',
      description: 'Execute JavaScript in the page context.',
      parameters: {
        type: 'object',
        properties: {
          fn: { type: 'string', description: 'JavaScript expression or function to evaluate' },
          ref: { type: 'string', description: 'Optional: element ref to pass as argument to the function' }
        },
        required: ['fn']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'tab_list',
      description: 'List all open browser tabs.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'tab_open',
      description: 'Open a new tab with the given URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL to open' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'tab_close',
      description: 'Close a tab by its ID.',
      parameters: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID from tab_list' }
        },
        required: ['tabId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'tab_focus',
      description: 'Focus/switch to a tab by its ID.',
      parameters: {
        type: 'object',
        properties: {
          tabId: { type: 'number', description: 'Tab ID from tab_list' }
        },
        required: ['tabId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cookies_get',
      description: 'Get cookies for the current page.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cookies_set',
      description: 'Set a cookie.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          value: { type: 'string' },
          domain: { type: 'string' },
          path: { type: 'string' },
          secure: { type: 'boolean' },
          httpOnly: { type: 'boolean' }
        },
        required: ['name', 'value']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cookies_clear',
      description: 'Clear cookies for the current page.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_viewport',
      description: 'Set the browser viewport size.',
      parameters: {
        type: 'object',
        properties: {
          width: { type: 'number' },
          height: { type: 'number' }
        },
        required: ['width', 'height']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pdf',
      description: 'Export the current page as a PDF.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }
]
```

### 7. Side Panel (`sidepanel/`)

Minimal chat interface for the kernel. Just enough to drive the agent.

**Elements:**
- **Message log** — scrollable area showing:
  - User prompts (right-aligned, distinct color)
  - Agent actions (monospace, shows tool name + args)
  - Agent responses (left-aligned)
  - Errors (red)
- **Input area** — text field + send button (disabled when agent is running)
- **Status bar** — shows: idle | thinking (waiting for LLM) | acting (executing tool) | error
- **Stop button** — visible when agent is running, sends stop signal
- **Settings gear** — opens options page

**Communication (persistent port):**

Uses `chrome.runtime.connect` for a persistent bidirectional channel (not `sendMessage` per-message):

```typescript
// Side panel connects on open:
const port = chrome.runtime.connect({ name: 'agent-panel' });

// Send prompt:
port.postMessage({ type: 'user_prompt', text: '...' });

// Receive updates:
port.onMessage.addListener((msg) => { /* handle status, actions, etc. */ });

// Service worker listens:
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'agent-panel') { /* register panel port */ }
});

// Clean shutdown when side panel closes:
port.onDisconnect.addListener(() => { /* stop agent loop, cleanup */ });
```

**Message types (both directions):**
- `{type: 'user_prompt', text: string}` — user sends a prompt
- `{type: 'stop'}` — user stops the agent loop
- `{type: 'status', status: 'thinking' | 'acting' | 'idle' | 'error'}` — agent status
- `{type: 'action', tool: string, args: object}` — agent is executing a tool
- `{type: 'action_result', tool: string, success: boolean, data?: unknown, error?: string}` — tool result
- `{type: 'agent_message', text: string}` — agent's final response
- `{type: 'error', text: string}` — error message
- `{type: 'snapshot_preview', text: string}` — truncated snapshot for display

### 8. Options Page (`options/`)

Simple form to configure the LLM connection.

**Fields:**
- API Base URL (text input, placeholder: `https://api.openai.com/v1`)
- API Key (password input)
- Model Name (text input, placeholder: `gpt-4o`)
- Max Tokens (number input, default: 4096)
- Temperature (number input, default: 0.2)
- Screenshot Detail (select: `low` | `high`, default: `low`) — controls vision token usage
- Vision Enabled (checkbox, default: true) — disable to skip screenshots for non-vision models
- Max Iterations (number input, default: 50)
- Action Delay (number input in ms, default: 500)

**Storage:** `chrome.storage.local` for non-sensitive settings (base URL, model name, max tokens, temperature). API key stored in `chrome.storage.local` with a note in the UI that it is stored unencrypted on disk.

## Build System

- **TypeScript** — all source code
- **Vite** with `@crxjs/vite-plugin` — bundles TypeScript, handles manifest, hot reload during development
- **No UI framework** — vanilla HTML/CSS/TypeScript for side panel and options page
- **No runtime dependencies** — pure browser APIs + fetch

**Build output:**
```
dist/
  manifest.json
  service-worker.js
  sidepanel/index.html + panel.js + panel.css
  options/index.html + options.js + options.css
  icons/ (16, 48, 128 px)
```

**Dev workflow:**
```bash
npm install
npm run dev      # Vite dev server with HMR, load unpacked from dist/
npm run build    # Production build
```

## Security Considerations

- **API key storage:** Keys are stored in `chrome.storage.local` (unencrypted on disk). `chrome.storage.sync` is not encrypted. A future improvement could use `chrome.storage.session` (in-memory, cleared on restart) with an opt-in "remember key" toggle that falls back to `storage.local`.
- **`evaluate` tool:** Executes arbitrary JS in the page context. This is disabled by default in settings. When enabled, the system prompt warns the LLM about the security implications. The tool can access cookies, localStorage, and make network requests as the page's origin.
- The debugger permission shows a banner to the user — this is a feature (transparency).
- No content scripts needed — all interaction via CDP through chrome.debugger.
- No external dependencies = no supply chain risk.
- **Cross-origin fetch:** Service workers can make cross-origin `fetch()` calls only when `host_permissions` are declared in the manifest (which we do). This is what enables reaching any user-configured LLM API endpoint.

### Service Worker Lifecycle

Manifest V3 service workers are terminated after 30 seconds of inactivity and have a 5-minute maximum runtime. However:

- **Chrome 118+** keeps the service worker alive while a `chrome.debugger` session is attached. Since the agent loop always has the debugger attached during operation, the service worker survives for the duration of the task.
- **Between tasks:** When the debugger is detached and the service worker could be terminated, conversation history is persisted to `chrome.storage.session` so it survives restart.
- **On unexpected termination:** The `chrome.debugger.onDetach` event fires if the debugger disconnects. The service worker handles this by saving state and notifying the side panel.

### Action Result Format

All tool executions return a structured result for the LLM:

```typescript
interface ActionResult {
  success: boolean;
  data?: unknown;      // Action-specific return value
  error?: string;      // Human-readable error for the LLM to reason about
}
```

This gives the LLM clear feedback on failures (e.g., "ref e5 not found — element may have changed, take a new snapshot") so it can recover.

### Snapshot Size Management

Complex pages can produce accessibility trees exceeding LLM context limits. Mitigation:
- Configurable `maxDepth` (default: 10) and `maxChars` (default: 30000) for snapshots
- Depth-first traversal with a character budget, prioritizing interactive elements
- If truncated, the snapshot includes a note: `[truncated — {N} more elements not shown]`
- The agent can request a scoped snapshot of a specific subtree via the `evaluate` tool if needed

## Out of Scope (v1)

- Multi-model support / model switching within a session
- Conversation export/import
- Extension marketplace publishing
- Proxy/auth configuration for the LLM API
- Rate limiting / cost tracking
- Recording/replay of action sequences
- Advanced prompt templates / persona system
