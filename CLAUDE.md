# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Chrome extension (Manifest V3) for AI-powered browser automation via natural language. Users type a task in the side panel, and an agentic loop uses CDP (Chrome DevTools Protocol) to observe and act on the page. Inspired by OpenClaw's browser automation approach.

## Commands

```bash
npm run dev        # Start Vite dev server with HMR + @crxjs/vite-plugin
npm run build      # Production build → dist/
npm run typecheck  # tsc --noEmit (no tests exist yet)
```

Load the extension in Chrome: `chrome://extensions` → Developer mode → "Load unpacked" → select `dist/`.

## Architecture

### Agentic Loop (core flow)

```
User prompt → service-worker.ts → AgentLoop.start()
  ├── Attach chrome.debugger (CDP 1.3)
  ├── SnapshotEngine → a11y tree text + viewport PNG
  ├── LLM call (OpenAI chat/completions with tool_use)
  ├── If tool_calls → ActionExecutor dispatches via CDP
  ├── If page changed → auto re-snapshot
  └── Loop until LLM responds with text (no tool_calls) or max iterations
```

### Key Modules (`src/background/`)

- **`service-worker.ts`** — Entry point. Manages port connection to side panel, instantiates modules, routes messages.
- **`agent-loop.ts`** — Core orchestration. Maintains conversation history (OpenAI chat format), calls LLM, dispatches tools, tracks page changes. Emits events (status/action/error/message) via callbacks.
- **`cdp-manager.ts`** — Thin wrapper around `chrome.debugger`. Handles attach/detach, sends CDP commands, tracks attached tabs. Enables `Accessibility`, `Page`, `Network` domains on attach.
- **`snapshot-engine.ts`** — Produces hybrid snapshots: accessibility tree text (with `[e1]`, `[e2]` refs for interactive/content elements) + base64 PNG screenshot. Uses `Accessibility.getFullAXTree` and `Page.captureScreenshot`.
- **`action-executor.ts`** — Translates tool calls into CDP commands. Element targeting via ref → `backendNodeId` → `DOM.getBoxModel` center-point. Supports click, type, navigate, scroll, hover, drag, select, fill, wait, evaluate, tab management, cookies, viewport, PDF.
- **`tool-definitions.ts`** — OpenAI function-calling schemas for all 22 tools. These are sent to the LLM as the `tools` parameter.
- **`llm-client.ts`** — OpenAI-compatible chat completion client with retry/backoff. Strips images when vision is disabled.
- **`types.ts`** — All shared types: RefMap, HybridSnapshot, ActionResult, LLMConfig, ChatMessage variants, PanelMessage union, AgentState.

### UI (`src/sidepanel/`, `src/options/`)

- **Side panel** — Chat UI connected via persistent `chrome.runtime.Port` (name: `"agent-panel"`). Sends `user_prompt`/`stop` messages, receives status/action/error/agent_message/snapshot_preview.
- **Options page** — Config form for LLM settings (API base URL, key, model, max tokens, temperature, vision, screenshot detail) and agent settings (max iterations, action delay). Persisted in `chrome.storage.local` under keys `llmConfig` and `agentConfig`.

### Build System

Vite + `@crxjs/vite-plugin` (beta). The plugin reads `manifest.json` directly and handles service worker bundling, HTML entry points, and HMR. Output goes to `dist/`.

## Important Patterns

- **Ref-based element targeting**: Snapshot assigns refs like `[e1]` to interactive/content elements. The `RefMap` maps ref strings to `RefEntry` objects containing `backendNodeId`. Actions resolve refs through the map, then use `DOM.getBoxModel` content quad center-point for mouse coordinates.
- **Conversation persistence**: Agent state is saved to `chrome.storage.session` for service worker survival across restarts.
- **Page change detection**: After tool calls, the agent compares URL/title before vs after. If changed (or action is in `PAGE_CHANGE_ACTIONS` set), it automatically takes a fresh snapshot.
- **No content scripts**: All page interaction happens through CDP via the background service worker.
- **Config is loaded fresh** each time a user prompt is received (not cached across prompts).

## Tech Constraints

- Chrome 118+ minimum (debugger API keeps service worker alive)
- `Accessibility.getFullAXTree` is experimental CDP — may need graceful error handling
- API keys stored in `chrome.storage.local` (not encrypted)
- Vanilla TypeScript, no framework (no React/Vue/etc.)
