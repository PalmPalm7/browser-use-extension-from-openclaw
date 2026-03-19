// --- Snapshot types ---

export interface RefEntry {
  backendNodeId: number;
  nodeId?: number;
  role: string;
  name: string;
  value?: string;
  properties?: Record<string, unknown>;
}

export type RefMap = Map<string, RefEntry>;

export interface HybridSnapshot {
  text: string;
  screenshotBase64: string;
  refMap: RefMap;
  metadata: {
    url: string;
    title: string;
    truncated: boolean;
    totalElements: number;
    visibleElements: number;
  };
}

// --- Action types ---

export interface ActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// --- LLM types ---

export interface LLMConfig {
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
  maxTokens: number;
  temperature: number;
  screenshotDetail: 'low' | 'high';
  visionEnabled: boolean;
}

// --- Chat message types (OpenAI chat completion format) ---

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageUrlContent {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'low' | 'high' | 'auto';
  };
}

export type ContentPart = TextContent | ImageUrlContent;

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

export interface SystemMessage {
  role: 'system';
  content: string;
}

export interface UserMessage {
  role: 'user';
  content: string | ContentPart[];
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ToolMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

// --- Agent state ---

export interface AgentState {
  status: 'idle' | 'running' | 'paused' | 'error';
  conversationHistory: ChatMessage[];
  currentTabId: number | null;
  iteration: number;
  maxIterations: number;
  actionDelayMs: number;
}

// --- Panel message types ---

export interface UserPromptMessage {
  type: 'user_prompt';
  text: string;
}

export interface StopMessage {
  type: 'stop';
}

export interface StatusMessage {
  type: 'status';
  status: 'thinking' | 'acting' | 'idle' | 'error';
}

export interface ActionMessage {
  type: 'action';
  tool: string;
  args: Record<string, unknown>;
}

export interface ActionResultMessage {
  type: 'action_result';
  tool: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface AgentTextMessage {
  type: 'agent_message';
  text: string;
}

export interface ErrorMessage {
  type: 'error';
  text: string;
}

export interface SnapshotPreviewMessage {
  type: 'snapshot_preview';
  text: string;
}

export type PanelMessage =
  | UserPromptMessage
  | StopMessage
  | StatusMessage
  | ActionMessage
  | ActionResultMessage
  | AgentTextMessage
  | ErrorMessage
  | SnapshotPreviewMessage;
