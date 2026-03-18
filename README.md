# Browser Use Extension

A Manifest V3 Chrome extension that brings AI-powered browser automation to any tab. Type a natural language instruction in the side panel, and an autonomous agent takes over — reading the page, reasoning about what to do, and executing actions through Chrome's DevTools Protocol. It connects to any OpenAI-compatible API endpoint.

**Inspired by** [OpenClaw's browser automation tool](https://docs.openclaw.ai/tools/browser) — this extension mirrors its architecture: accessibility-tree snapshots with numbered refs, CDP-based actions, and a deterministic agent loop. Built as a standalone, installable Chrome extension rather than a server-side dependency.

## How It Works

The extension runs an agentic loop in the background service worker:

```
User prompt (side panel)
    |
    v
Attach chrome.debugger to active tab
    |
    v
+-- Take hybrid snapshot --------------------------------+
|   Accessibility.getFullAXTree  -->  text with [e1] refs |
|   Page.captureScreenshot       -->  viewport PNG         |
+---------------------------------------------------------+
    |
    v
Send snapshot + conversation history + tool schemas to LLM
    |
    v
LLM responds with tool_calls  (click, type, navigate, ...)
    |
    v
Execute each tool via CDP commands (Input, DOM, Page, ...)
    |
    v
Page changed?  -->  auto re-snapshot
    |
    v
Loop until LLM responds with text (task complete) or max iterations
```

### Dual-Channel Page Understanding

Each observation sent to the LLM contains two representations of the page:

1. **Accessibility tree text** — a structured, indented tree of interactive and content elements, each tagged with a ref like `[e1]`, `[e2]`. The LLM uses these refs to target elements in tool calls.

   ```
   Page: "Search Flights" | URL: https://travel.example.com/search

   [e1] heading "Search Flights"
   [e2] textbox "From" value="New York"
   [e3] textbox "To"
   [e4] button "Search"
   [e5] link "Advanced Options"
   ```

2. **Viewport screenshot** — a base64 PNG of the visible page, sent as an OpenAI vision `image_url` content block. This helps the LLM understand layout, images, icons, and visual states that the accessibility tree misses.

Together, the text provides actionable structure and the screenshot provides visual context.

### Ref-Based Element Targeting

When the agent needs to click a button or type into an input, it references elements by their snapshot ref (e.g., `click({ref: "e4"})`). The extension resolves the ref to a `backendNodeId`, calls `DOM.getBoxModel` to get the element's content quad, computes the center point, and dispatches mouse events at those coordinates. Refs are ephemeral — rebuilt on every snapshot, since the DOM changes across navigations.

## Available Tools (22)

The LLM has access to these tools via OpenAI function-calling format:

| Category | Tools | Description |
|----------|-------|-------------|
| **Observation** | `snapshot`, `screenshot` | Capture page state (a11y tree + refs, or viewport PNG) |
| **Interaction** | `click`, `type`, `press`, `hover`, `scroll`, `drag` | Mouse and keyboard actions on ref'd elements |
| **Forms** | `select`, `fill` | Dropdown selection, batch form fill (text, checkbox, radio, select) |
| **Navigation** | `navigate`, `wait` | Go to URL, wait for text/selector/URL/JS condition |
| **Execution** | `evaluate` | Run arbitrary JavaScript in page context |
| **Tabs** | `tab_list`, `tab_open`, `tab_close`, `tab_focus` | Multi-tab management |
| **Cookies** | `cookies_get`, `cookies_set`, `cookies_clear` | Read/write/clear cookies via CDP Network domain |
| **Environment** | `set_viewport`, `pdf` | Viewport emulation, PDF export |

## Getting Started

### Prerequisites

- **Chrome 118+** (required for `chrome.debugger` to keep the service worker alive during automation)
- **Node.js** (for building)
- An API key for any OpenAI-compatible endpoint (OpenAI, Anthropic via proxy, Ollama, etc.)

### Install and Build

```bash
git clone <repo-url>
cd browser-use-extension-from-openclaw
npm install
npm run build
```

### Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `dist/` directory

The extension icon appears in the toolbar. Click it to open the side panel.

### Configure

1. Click the gear icon in the side panel (or right-click the extension icon → Options)
2. Enter your API settings:
   - **API Base URL** — defaults to `https://api.openai.com/v1`, works with any OpenAI-compatible endpoint
   - **API Key** — your Bearer token
   - **Model Name** — e.g., `gpt-4o`, `gpt-4.1`, or any vision-capable model
   - **Vision Enabled** — uncheck for non-vision models (screenshots will be stripped)
   - **Screenshot Detail** — `low` (faster, fewer tokens) or `high` (pixel-level precision)
3. Click Save

### Use

1. Navigate to any page in Chrome
2. Open the side panel (click extension icon)
3. Type an instruction: *"Go to google.com and search for 'browser automation'"*
4. Watch the agent work — actions and results stream into the chat log
5. Click **Stop** to interrupt at any time

## Architecture

```
src/
  background/
    service-worker.ts       Entry point — port connection, module init, message routing
    agent-loop.ts           Core orchestration — snapshot → LLM → action cycle
    cdp-manager.ts          chrome.debugger wrapper — async CDP command interface
    snapshot-engine.ts      Hybrid snapshot — a11y tree text + viewport screenshot
    action-executor.ts      22-tool dispatcher — ref resolution → CDP commands
    llm-client.ts           OpenAI-compatible chat completion client with retry
    tool-definitions.ts     Function-calling schemas for all 22 tools
    types.ts                Shared TypeScript interfaces
  sidepanel/
    index.html              Chat UI markup
    panel.ts                Port connection, message rendering, user input
    panel.css               Chat styling
  options/
    index.html              Config form markup
    options.ts              Load/save/validate settings
    options.css              Form styling
```

### Module Dependency Graph

```
service-worker.ts
  ├── CDPManager           (singleton, shared)
  ├── SnapshotEngine       (uses CDPManager)
  ├── ActionExecutor       (uses CDPManager)
  └── AgentLoop            (uses all three + LLMClient + ToolDefinitions)
```

### Communication

The side panel connects to the service worker via `chrome.runtime.connect` with a persistent port (name: `"agent-panel"`). All messages flow through this port as typed `PanelMessage` objects — a discriminated union on the `type` field:

| Direction | Message Type | Purpose |
|-----------|-------------|---------|
| Panel → SW | `user_prompt` | User's natural language instruction |
| Panel → SW | `stop` | Interrupt the agent loop |
| SW → Panel | `status` | Agent state: `thinking`, `acting`, `idle`, `error` |
| SW → Panel | `action` | Tool being executed (name + args) |
| SW → Panel | `action_result` | Tool result (success/failure + data) |
| SW → Panel | `agent_message` | LLM's text response (task complete) |
| SW → Panel | `error` | Error message |
| SW → Panel | `snapshot_preview` | Collapsible a11y tree preview |

### Service Worker Lifecycle

Manifest V3 service workers are normally terminated after 30 seconds of inactivity. This extension stays alive during automation because `chrome.debugger` sessions (Chrome 118+) keep the service worker running. Between tasks, conversation history is persisted to `chrome.storage.session` to survive restarts.

### Storage

| Key | Storage | Contents |
|-----|---------|----------|
| `llmConfig` | `chrome.storage.local` | API base URL, key, model, max tokens, temperature, vision settings |
| `agentConfig` | `chrome.storage.local` | Max iterations, action delay |
| `agentConversation` | `chrome.storage.session` | Serialized conversation history (survives SW restart) |

API keys are stored unencrypted in `chrome.storage.local`. This is noted in the options UI.

## Development

```bash
npm run dev        # Vite dev server with HMR via @crxjs/vite-plugin
npm run build      # Production build → dist/
npm run typecheck   # tsc --noEmit
```

During development, load the `dist/` directory as an unpacked extension. The `@crxjs/vite-plugin` provides hot module replacement — changes to UI files update in real time. Service worker changes require clicking the extension's reload button on `chrome://extensions`.

### Build System

**Vite + @crxjs/vite-plugin (v2 beta)** — the plugin reads `manifest.json` from the project root (which uses source paths like `src/background/service-worker.ts`), rewrites them for the build output, generates a service worker loader, and handles HTML entry points for the side panel and options page. Output goes to `dist/`.

### Tech Stack

- **TypeScript** — strict mode, ES2022 target, bundler module resolution
- **Vite 5** — build and dev server
- **Vanilla HTML/CSS/TS** — no UI framework
- **Zero runtime dependencies** — only `devDependencies` for build tooling (`vite`, `@crxjs/vite-plugin`, `typescript`, `@types/chrome`)
- **Chrome APIs** — `chrome.debugger`, `chrome.tabs`, `chrome.sidePanel`, `chrome.storage`, `chrome.runtime`

### CDP Domains Used

| Domain | Methods | Purpose |
|--------|---------|---------|
| `Accessibility` | `enable`, `getFullAXTree` | Page snapshots |
| `Page` | `enable`, `navigate`, `captureScreenshot`, `printToPDF` | Navigation, screenshots, PDF |
| `DOM` | `getBoxModel`, `resolveNode`, `focus`, `scrollIntoViewIfNeeded` | Element resolution |
| `Input` | `dispatchMouseEvent`, `dispatchKeyEvent`, `insertText` | Click, type, press, hover, drag |
| `Runtime` | `evaluate`, `callFunctionOn` | JS execution, wait predicates, form helpers |
| `Network` | `enable`, `getCookies`, `setCookie`, `deleteCookies` | Cookie management |
| `Emulation` | `setDeviceMetricsOverride` | Viewport emulation |

## How This Was Built

This extension was designed spec-first and built autonomously:

1. **Design spec** ([`docs/superpowers/specs/2026-03-18-browser-use-extension-kernel-design.md`](docs/superpowers/specs/2026-03-18-browser-use-extension-kernel-design.md)) — a detailed architecture document covering every component, CDP domain, message format, and data flow.

2. **PRD** ([`tasks/prd-browser-use-extension-kernel.md`](tasks/prd-browser-use-extension-kernel.md)) — the spec was decomposed into 27 atomic user stories (US-001 through US-027), ordered by dependency, each with precise acceptance criteria.

3. **Ralph loop** — an autonomous AI agent ([`scripts/ralph/CLAUDE.md`](scripts/ralph/CLAUDE.md)) iterated through the user stories one at a time. Each iteration: pick the highest-priority incomplete story, implement it, run `typecheck`, commit, update progress. The `prd.json` file tracks story completion state, and `progress.txt` captures implementation learnings from each iteration.

The entire codebase — from scaffolding to end-to-end integration — was produced by 27 sequential Ralph iterations, each building on the previous. The commit history (`git log --oneline`) maps 1:1 to user stories.

## Limitations and Non-Goals (v1)

- No automated test suite — manual testing by loading the unpacked extension
- No multi-model switching within a session
- No conversation export/import
- No proxy/auth configuration beyond API key
- No rate limiting or cost tracking
- No recording/replay of action sequences
- No content scripts — all interaction is via CDP through `chrome.debugger`
- `Accessibility.getFullAXTree` is experimental CDP — stable in practice but may change
- The `evaluate` tool runs arbitrary JS in page context (same power as the browser console)

## License

See [LICENSE](LICENSE) for details.
