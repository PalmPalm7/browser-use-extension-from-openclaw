import { CDPManager } from './cdp-manager';
import { SnapshotEngine } from './snapshot-engine';
import { ActionExecutor } from './action-executor';
import { AgentLoop } from './agent-loop';
import type { AgentConfig, LLMConfig, PanelMessage } from './types';

// --- Module instantiation ---
const cdp = new CDPManager();
const snapshotEngine = new SnapshotEngine(cdp);
const actionExecutor = new ActionExecutor(cdp);

const DEFAULT_CONFIG: LLMConfig = {
  apiBaseUrl: 'https://api.minimax.io/v1',
  apiKey: '',
  modelName: 'MiniMax-M2.5',
  maxTokens: 131072,
  temperature: 1.0,
  screenshotDetail: 'low',
  visionEnabled: false,
};

async function loadConfig(): Promise<LLMConfig> {
  const stored = await chrome.storage.local.get('llmConfig');
  if (stored.llmConfig) {
    return { ...DEFAULT_CONFIG, ...stored.llmConfig } as LLMConfig;
  }
  return DEFAULT_CONFIG;
}

async function loadAgentConfig(): Promise<AgentConfig> {
  const stored = await chrome.storage.local.get('agentConfig');
  return {
    maxIterations: stored.agentConfig?.maxIterations ?? 50,
    actionDelayMs: stored.agentConfig?.actionDelayMs ?? 500,
  };
}

let agentLoop: AgentLoop | null = null;
let panelPort: chrome.runtime.Port | null = null;

function sendToPanel(message: PanelMessage): void {
  try {
    panelPort?.postMessage(message);
  } catch {
    // Port may be disconnected
  }
}

function wireAgentCallbacks(loop: AgentLoop): void {
  loop.onStatus((status) => {
    sendToPanel({ type: 'status', status });
  });

  loop.onAction((tool, args) => {
    sendToPanel({ type: 'action', tool, args });
  });

  loop.onActionResult((tool, result) => {
    sendToPanel({
      type: 'action_result',
      tool,
      success: result.success,
      data: result.data,
      error: result.error,
    });
  });

  loop.onMessage((text) => {
    sendToPanel({ type: 'agent_message', text });
  });

  loop.onError((text) => {
    sendToPanel({ type: 'error', text });
  });

  loop.onSnapshotPreview((text) => {
    sendToPanel({ type: 'snapshot_preview', text });
  });
}

// --- Port connection handling ---
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'agent-panel') return;

  panelPort = port;

  port.onMessage.addListener(async (msg: PanelMessage) => {
    if (msg.type === 'user_prompt') {
      // Load latest config each time
      const config = await loadConfig();
      const agentConfig = await loadAgentConfig();

      // Create a fresh agent loop with latest config
      agentLoop = new AgentLoop(cdp, snapshotEngine, actionExecutor, config, agentConfig);
      wireAgentCallbacks(agentLoop);

      // Get the active tab
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });

      if (!tab?.id) {
        sendToPanel({ type: 'error', text: 'No active tab found' });
        sendToPanel({ type: 'status', status: 'idle' });
        return;
      }

      // Start the agent loop (runs asynchronously)
      agentLoop.start(msg.text, tab.id).catch((err) => {
        const text = err instanceof Error ? err.message : String(err);
        sendToPanel({ type: 'error', text });
        sendToPanel({ type: 'status', status: 'idle' });
      });
    }

    if (msg.type === 'stop') {
      if (agentLoop) {
        await agentLoop.stop();
      }
    }
  });

  port.onDisconnect.addListener(() => {
    // Stop agent loop if panel disconnects
    if (agentLoop && agentLoop.getStatus() === 'running') {
      agentLoop.stop();
    }
    panelPort = null;
  });
});

// --- Side panel behavior ---
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
