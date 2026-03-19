import type { ChatMessage, LLMConfig, ContentPart, ToolCall } from './types';
import type { ToolDefinition } from './tool-definitions';

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

function stripImageContent(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const textOnly = (msg.content as ContentPart[]).filter(
        (part) => part.type === 'text'
      );
      if (textOnly.length === 0) {
        return { ...msg, content: '' };
      }
      if (textOnly.length === 1) {
        return { ...msg, content: textOnly[0].text };
      }
      return { ...msg, content: textOnly };
    }
    return msg;
  });
}

export async function chatCompletion(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  config: LLMConfig
): Promise<ChatCompletionResponse> {
  const processedMessages = config.visionEnabled
    ? messages
    : stripImageContent(messages);

  const body = JSON.stringify({
    model: config.modelName,
    messages: processedMessages,
    tools,
    tool_choice: 'auto',
    max_tokens: config.maxTokens,
    temperature: config.temperature,
  });

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(
        `${config.apiBaseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body,
        }
      );

      if (response.status === 401 || response.status === 403) {
        const errorBody = await response.text();
        throw new Error(
          `Authentication failed (${response.status}): ${errorBody}. Check your API key in extension settings.`
        );
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_RETRIES) {
          const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }
        const errorBody = await response.text();
        throw new Error(
          `API request failed after ${MAX_RETRIES + 1} attempts (${response.status}): ${errorBody}`
        );
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(
          `API request failed (${response.status}): ${errorBody}`
        );
      }

      const data: ChatCompletionResponse = await response.json();
      return data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry auth errors or non-retryable errors
      if (
        lastError.message.startsWith('Authentication failed') ||
        lastError.message.startsWith('API request failed (')
      ) {
        throw lastError;
      }

      // Network errors: retry with backoff
      if (attempt < MAX_RETRIES) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
    }
  }

  throw lastError ?? new Error('LLM request failed after retries');
}
