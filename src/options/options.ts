const DEFAULTS = {
  apiBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  modelName: 'gpt-4o',
  maxTokens: 4096,
  temperature: 0.2,
  screenshotDetail: 'low' as const,
  visionEnabled: true,
  maxIterations: 50,
  actionDelayMs: 500,
};

// --- DOM elements ---
const form = document.getElementById('config-form') as HTMLFormElement;
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

// --- Load config from storage and populate form ---
async function loadConfig(): Promise<void> {
  const stored = await chrome.storage.local.get(['llmConfig', 'agentConfig']);
  const llm = stored.llmConfig || {};
  const agent = stored.agentConfig || {};

  apiBaseUrlInput.value = llm.apiBaseUrl ?? DEFAULTS.apiBaseUrl;
  apiKeyInput.value = llm.apiKey ?? DEFAULTS.apiKey;
  modelNameInput.value = llm.modelName ?? DEFAULTS.modelName;
  maxTokensInput.value = String(llm.maxTokens ?? DEFAULTS.maxTokens);
  temperatureInput.value = String(llm.temperature ?? DEFAULTS.temperature);
  screenshotDetailSelect.value = llm.screenshotDetail ?? DEFAULTS.screenshotDetail;
  visionEnabledInput.checked = llm.visionEnabled ?? DEFAULTS.visionEnabled;
  maxIterationsInput.value = String(agent.maxIterations ?? DEFAULTS.maxIterations);
  actionDelayInput.value = String(agent.actionDelayMs ?? DEFAULTS.actionDelayMs);
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
