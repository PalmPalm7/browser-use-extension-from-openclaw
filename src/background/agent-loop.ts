import { CDPManager } from './cdp-manager';
import { SnapshotEngine } from './snapshot-engine';
import { ActionExecutor } from './action-executor';
import { chatCompletion } from './llm-client';
import { toolDefinitions } from './tool-definitions';
import type {
  AgentState,
  ChatMessage,
  AssistantMessage,
  ToolMessage,
  UserMessage,
  ContentPart,
  LLMConfig,
  ActionResult,
  HybridSnapshot,
} from './types';

const PAGE_CHANGE_ACTIONS = new Set([
  'navigate', 'click', 'tab_focus', 'tab_open',
]);

const SYSTEM_PROMPT = `You are a browser automation agent. You control a Chrome browser to accomplish the user's task.

You can see the page in two ways:
1. An accessibility snapshot showing interactive elements with refs like [e1], [e2], etc. Use these refs to interact with elements.
2. A screenshot of the current viewport for visual context — helps you understand layout, images, icons, and visual states.

Use the text snapshot for finding elements and their refs. Use the screenshot to understand what the page looks like visually. Together they give you a complete picture.

Instructions:
- Use snapshot to understand the page before acting
- Use refs from the most recent snapshot (they change on navigation)
- Take a new snapshot after navigation or major page changes
- The screenshot shows the viewport only; scroll to see more content
- When the task is complete, respond with a text message summarizing what was done
- If you get stuck, describe the problem and ask the user for guidance`;

type StatusCallback = (status: 'thinking' | 'acting' | 'idle' | 'error') => void;
type ActionCallback = (tool: string, args: Record<string, unknown>) => void;
type ActionResultCallback = (tool: string, result: ActionResult) => void;
type MessageCallback = (text: string) => void;
type ErrorCallback = (text: string) => void;
type SnapshotPreviewCallback = (text: string) => void;

export class AgentLoop {
  private cdp: CDPManager;
  private snapshotEngine: SnapshotEngine;
  private actionExecutor: ActionExecutor;
  private config: LLMConfig;

  private state: AgentState = {
    status: 'idle',
    conversationHistory: [],
    currentTabId: null,
    iteration: 0,
    maxIterations: 50,
    actionDelayMs: 500,
  };

  private _onStatus: StatusCallback | null = null;
  private _onAction: ActionCallback | null = null;
  private _onActionResult: ActionResultCallback | null = null;
  private _onMessage: MessageCallback | null = null;
  private _onError: ErrorCallback | null = null;
  private _onSnapshotPreview: SnapshotPreviewCallback | null = null;

  constructor(
    cdp: CDPManager,
    snapshotEngine: SnapshotEngine,
    actionExecutor: ActionExecutor,
    config: LLMConfig,
  ) {
    this.cdp = cdp;
    this.snapshotEngine = snapshotEngine;
    this.actionExecutor = actionExecutor;
    this.config = config;
  }

  setConfig(config: LLMConfig): void {
    this.config = config;
  }

  onStatus(cb: StatusCallback): void { this._onStatus = cb; }
  onAction(cb: ActionCallback): void { this._onAction = cb; }
  onActionResult(cb: ActionResultCallback): void { this._onActionResult = cb; }
  onMessage(cb: MessageCallback): void { this._onMessage = cb; }
  onError(cb: ErrorCallback): void { this._onError = cb; }
  onSnapshotPreview(cb: SnapshotPreviewCallback): void { this._onSnapshotPreview = cb; }

  getStatus(): AgentState['status'] {
    return this.state.status;
  }

  async start(userPrompt: string, tabId: number): Promise<void> {
    this.state.status = 'running';
    this.state.currentTabId = tabId;
    this.state.iteration = 0;
    this.emitStatus('thinking');

    try {
      // Attach debugger
      await this.cdp.attach(tabId);

      // Take initial snapshot
      const snapshot = await this.snapshotEngine.takeSnapshot(tabId);
      this.actionExecutor.setRefMap(snapshot.refMap);
      this.emitSnapshotPreview(snapshot.text);

      // Build initial conversation
      this.state.conversationHistory = [
        { role: 'system', content: SYSTEM_PROMPT },
        this.buildObservationMessage(snapshot),
        { role: 'user', content: userPrompt },
      ];

      // Main agent loop
      await this.runLoop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emitError(msg);
      this.state.status = 'error';
      this.emitStatus('error');
    }

    // Persist conversation for service worker survival
    await this.persistConversation();
  }

  async stop(): Promise<void> {
    this.state.status = 'idle';
    this.emitStatus('idle');
    await this.persistConversation();
  }

  private async runLoop(): Promise<void> {
    while (
      this.state.status === 'running' &&
      this.state.iteration < this.state.maxIterations
    ) {
      this.state.iteration++;

      // Check if stopped before LLM call
      if (this.state.status !== 'running') break;

      this.emitStatus('thinking');

      let response;
      try {
        response = await chatCompletion(
          this.state.conversationHistory,
          toolDefinitions,
          this.config,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.emitError(`LLM error: ${msg}`);
        this.state.status = 'error';
        this.emitStatus('error');
        return;
      }

      const message = response.choices[0]?.message;
      if (!message) {
        this.emitError('LLM returned empty response');
        this.state.status = 'error';
        this.emitStatus('error');
        return;
      }

      // Text response with no tool calls — task complete
      if (message.content && !message.tool_calls?.length) {
        this.emitMessage(message.content);
        this.state.conversationHistory.push({
          role: 'assistant',
          content: message.content,
        } as AssistantMessage);
        this.state.status = 'idle';
        this.emitStatus('idle');
        return;
      }

      // Process tool calls
      if (message.tool_calls?.length) {
        // Add assistant message with tool_calls to history
        this.state.conversationHistory.push({
          role: 'assistant',
          content: message.content,
          tool_calls: message.tool_calls,
        } as AssistantMessage);

        this.emitStatus('acting');

        let pageChanged = false;
        const tabId = this.state.currentTabId!;

        // Get URL/title before actions for change detection
        let prevUrl = '';
        let prevTitle = '';
        try {
          const pageInfo = await this.getPageInfo(tabId);
          prevUrl = pageInfo.url;
          prevTitle = pageInfo.title;
        } catch {
          // May fail if page is in a transitional state
        }

        for (const toolCall of message.tool_calls) {
          // Check if stopped before each action
          if (this.state.status !== 'running') break;

          const toolName = toolCall.function.name;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            // Handle malformed JSON from LLM
          }

          this.emitAction(toolName, args);

          let result: ActionResult;

          if (toolName === 'snapshot') {
            // Snapshot is handled by the agent loop itself
            try {
              const snapshot = await this.snapshotEngine.takeSnapshot(tabId);
              this.actionExecutor.setRefMap(snapshot.refMap);
              this.emitSnapshotPreview(snapshot.text);
              result = { success: true, data: { text: snapshot.text } };
            } catch (err) {
              result = {
                success: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          } else {
            result = await this.actionExecutor.execute(tabId, toolName, args);
          }

          this.emitActionResult(toolName, result);

          // Add tool result to conversation
          const toolMessage: ToolMessage = {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          };
          this.state.conversationHistory.push(toolMessage);

          // Track if this action likely changed the page
          if (PAGE_CHANGE_ACTIONS.has(toolName)) {
            pageChanged = true;
          }

          // Action delay
          if (this.state.actionDelayMs > 0) {
            await new Promise((r) => setTimeout(r, this.state.actionDelayMs));
          }
        }

        // Check URL/title after actions for page change detection
        if (!pageChanged) {
          try {
            const pageInfo = await this.getPageInfo(tabId);
            if (pageInfo.url !== prevUrl || pageInfo.title !== prevTitle) {
              pageChanged = true;
            }
          } catch {
            // May fail during navigation
          }
        }

        // Take fresh snapshot if page changed
        if (pageChanged && this.state.status === 'running') {
          try {
            const snapshot = await this.snapshotEngine.takeSnapshot(tabId);
            this.actionExecutor.setRefMap(snapshot.refMap);
            this.emitSnapshotPreview(snapshot.text);
            this.state.conversationHistory.push(
              this.buildObservationMessage(snapshot),
            );
          } catch (err) {
            // Snapshot after navigation can fail — not fatal
            const msg = err instanceof Error ? err.message : String(err);
            this.emitError(`Snapshot failed: ${msg}`);
          }
        }
      }
    }

    // Max iterations reached
    if (
      this.state.status === 'running' &&
      this.state.iteration >= this.state.maxIterations
    ) {
      this.emitError(`Max iterations reached (${this.state.maxIterations})`);
      this.state.status = 'idle';
      this.emitStatus('idle');
    }
  }

  private buildObservationMessage(snapshot: HybridSnapshot): UserMessage {
    const content: ContentPart[] = [
      {
        type: 'text',
        text: snapshot.text,
      },
      {
        type: 'image_url',
        image_url: {
          url: `data:image/png;base64,${snapshot.screenshotBase64}`,
          detail: this.config.screenshotDetail,
        },
      },
    ];

    return { role: 'user', content };
  }

  private async getPageInfo(
    tabId: number,
  ): Promise<{ url: string; title: string }> {
    const result = await this.cdp.send<{ result: { value: string } }>(
      tabId,
      'Runtime.evaluate',
      {
        expression:
          'JSON.stringify({url: location.href, title: document.title})',
        returnByValue: true,
      },
    );
    return JSON.parse(result.result.value) as { url: string; title: string };
  }

  private async persistConversation(): Promise<void> {
    try {
      // Serialize conversation — RefMap (Map) can't be directly stored
      const serializable = this.state.conversationHistory.map((msg) => ({
        ...msg,
      }));
      await chrome.storage.session.set({
        agentConversation: serializable,
        agentIteration: this.state.iteration,
        agentTabId: this.state.currentTabId,
      });
    } catch {
      // storage.session may not be available — non-fatal
    }
  }

  private emitStatus(status: 'thinking' | 'acting' | 'idle' | 'error'): void {
    this._onStatus?.(status);
  }

  private emitAction(tool: string, args: Record<string, unknown>): void {
    this._onAction?.(tool, args);
  }

  private emitActionResult(tool: string, result: ActionResult): void {
    this._onActionResult?.(tool, result);
  }

  private emitMessage(text: string): void {
    this._onMessage?.(text);
  }

  private emitError(text: string): void {
    this._onError?.(text);
  }

  private emitSnapshotPreview(text: string): void {
    this._onSnapshotPreview?.(text);
  }
}
