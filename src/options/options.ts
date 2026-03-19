// --- Provider presets ---

interface ProviderPreset {
  apiBaseUrl: string;
  modelName: string;
  maxTokens: number;
  temperature: number;
  visionEnabled: boolean;
  screenshotDetail: 'low' | 'high';
  supportsVision: boolean;
  infoText: string;
}

const PRESETS: Record<string, ProviderPreset> = {
  minimax: {
    apiBaseUrl: 'https://api.minimax.io/v1',
    modelName: 'MiniMax-M2.5',
    maxTokens: 131072,
    temperature: 0.2,
    visionEnabled: true,
    screenshotDetail: 'low',
    supportsVision: true,
    infoText: 'MiniMax-M2.5 \u00b7 200K context \u00b7 196K max output \u00b7 $0.30/1M in',
  },
  openai: {
    apiBaseUrl: 'https://api.openai.com/v1',
    modelName: 'gpt-4o',
    maxTokens: 4096,
    temperature: 0.2,
    visionEnabled: true,
    screenshotDetail: 'low',
    supportsVision: true,
    infoText: 'gpt-4o \u00b7 128K context \u00b7 16K max output \u00b7 Vision supported',
  },
  anthropic: {
    apiBaseUrl: 'https://api.anthropic.com/v1/',
    modelName: 'claude-sonnet-4-6',
    maxTokens: 8192,
    temperature: 0.2,
    visionEnabled: true,
    screenshotDetail: 'low',
    supportsVision: true,
    infoText: 'claude-sonnet-4-6 \u00b7 200K context \u00b7 64K max output \u00b7 OpenAI compat',
  },
  google: {
    apiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    modelName: 'gemini-2.5-flash',
    maxTokens: 8192,
    temperature: 0.2,
    visionEnabled: true,
    screenshotDetail: 'low',
    supportsVision: true,
    infoText: 'gemini-2.5-flash \u00b7 1M context \u00b7 65K max output \u00b7 OpenAI compat',
  },
  openrouter: {
    apiBaseUrl: 'https://openrouter.ai/api/v1',
    modelName: 'minimax/minimax-m2.5',
    maxTokens: 131072,
    temperature: 0.2,
    visionEnabled: true,
    screenshotDetail: 'low',
    supportsVision: true,
    infoText: 'Any model via OpenRouter \u00b7 Unified API \u00b7 openrouter.ai',
  },
};

const DEFAULTS = {
  preset: 'minimax',
  apiBaseUrl: 'https://api.minimax.io/v1',
  apiKey: '',
  modelName: 'MiniMax-M2.5',
  maxTokens: 131072,
  temperature: 0.2,
  screenshotDetail: 'low' as const,
  visionEnabled: true,
  maxIterations: 50,
  actionDelayMs: 500,
};

// --- DOM elements ---
const form = document.getElementById('config-form') as HTMLFormElement;
const presetSelect = document.getElementById('providerPreset') as HTMLSelectElement;
const presetInfo = document.getElementById('preset-info') as HTMLSpanElement;
const apiBaseUrlInput = document.getElementById('apiBaseUrl') as HTMLInputElement;
const apiKeyInput = document.getElementById('apiKey') as HTMLInputElement;
const modelNameInput = document.getElementById('modelName') as HTMLInputElement;
const maxTokensInput = document.getElementById('maxTokens') as HTMLInputElement;
const temperatureInput = document.getElementById('temperature') as HTMLInputElement;
const screenshotDetailSelect = document.getElementById('screenshotDetail') as HTMLSelectElement;
const visionEnabledInput = document.getElementById('visionEnabled') as HTMLInputElement;
const maxIterationsInput = document.getElementById('maxIterations') as HTMLInputElement;
const actionDelayInput = document.getElementById('actionDelay') as HTMLInputElement;
const statusMsg = document.getElementById('status-msg') as HTMLSpanElement;

// --- Apply preset values to form ---
function applyPreset(key: string): void {
  const preset = PRESETS[key];
  if (!preset) {
    presetInfo.textContent = '';
    visionEnabledInput.disabled = false;
    return;
  }

  apiBaseUrlInput.value = preset.apiBaseUrl;
  modelNameInput.value = preset.modelName;
  maxTokensInput.value = String(preset.maxTokens);
  temperatureInput.value = String(preset.temperature);
  screenshotDetailSelect.value = preset.screenshotDetail;
  visionEnabledInput.checked = preset.visionEnabled;
  visionEnabledInput.disabled = !preset.supportsVision;
  presetInfo.textContent = preset.infoText;
}

// --- Update preset info without changing form values ---
function updatePresetInfo(key: string): void {
  const preset = PRESETS[key];
  presetInfo.textContent = preset?.infoText ?? '';
  visionEnabledInput.disabled = preset ? !preset.supportsVision : false;
}

// --- Preset change handler ---
presetSelect.addEventListener('change', () => {
  applyPreset(presetSelect.value);
});

// --- Load config from storage and populate form ---
async function loadConfig(): Promise<void> {
  const stored = await chrome.storage.local.get(['llmConfig', 'agentConfig']);
  const llm = stored.llmConfig || {};
  const agent = stored.agentConfig || {};

  presetSelect.value = llm.preset ?? DEFAULTS.preset;
  apiBaseUrlInput.value = llm.apiBaseUrl ?? DEFAULTS.apiBaseUrl;
  apiKeyInput.value = llm.apiKey ?? DEFAULTS.apiKey;
  modelNameInput.value = llm.modelName ?? DEFAULTS.modelName;
  maxTokensInput.value = String(llm.maxTokens ?? DEFAULTS.maxTokens);
  temperatureInput.value = String(llm.temperature ?? DEFAULTS.temperature);
  screenshotDetailSelect.value = llm.screenshotDetail ?? DEFAULTS.screenshotDetail;
  visionEnabledInput.checked = llm.visionEnabled ?? DEFAULTS.visionEnabled;
  maxIterationsInput.value = String(agent.maxIterations ?? DEFAULTS.maxIterations);
  actionDelayInput.value = String(agent.actionDelayMs ?? DEFAULTS.actionDelayMs);

  updatePresetInfo(presetSelect.value);
}

// --- Validation ---
function validate(): string | null {
  const url = apiBaseUrlInput.value.trim();
  if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
    return 'API Base URL must start with http:// or https://';
  }

  const maxTokens = Number(maxTokensInput.value);
  if (!Number.isFinite(maxTokens) || maxTokens < 1) {
    return 'Max Tokens must be a positive number';
  }

  const temp = Number(temperatureInput.value);
  if (!Number.isFinite(temp) || temp < 0 || temp > 2) {
    return 'Temperature must be between 0 and 2';
  }

  const maxIter = Number(maxIterationsInput.value);
  if (!Number.isFinite(maxIter) || maxIter < 1) {
    return 'Max Iterations must be a positive number';
  }

  const delay = Number(actionDelayInput.value);
  if (!Number.isFinite(delay) || delay < 0) {
    return 'Action Delay must be 0 or greater';
  }

  return null;
}

// --- Show status message ---
function showStatus(text: string, isError = false): void {
  statusMsg.textContent = text;
  statusMsg.className = isError ? 'status-msg error' : 'status-msg';
  if (!isError) {
    setTimeout(() => { statusMsg.textContent = ''; }, 2000);
  }
}

// --- Save handler ---
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const error = validate();
  if (error) {
    showStatus(error, true);
    return;
  }

  const llmConfig = {
    preset: presetSelect.value,
    apiBaseUrl: apiBaseUrlInput.value.trim() || DEFAULTS.apiBaseUrl,
    apiKey: apiKeyInput.value,
    modelName: modelNameInput.value.trim() || DEFAULTS.modelName,
    maxTokens: Number(maxTokensInput.value),
    temperature: Number(temperatureInput.value),
    screenshotDetail: screenshotDetailSelect.value,
    visionEnabled: visionEnabledInput.checked,
  };

  const agentConfig = {
    maxIterations: Number(maxIterationsInput.value),
    actionDelayMs: Number(actionDelayInput.value),
  };

  await chrome.storage.local.set({ llmConfig, agentConfig });
  showStatus('Saved');
});

// --- Init ---
loadConfig();
