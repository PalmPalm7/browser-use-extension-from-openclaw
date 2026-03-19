import type { PanelMessage } from '../background/types';

// --- DOM elements ---

const messageLog = document.getElementById('message-log') as HTMLDivElement;
const promptInput = document.getElementById('prompt-input') as HTMLInputElement;
const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
const statusText = document.getElementById('status-text') as HTMLSpanElement;
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;

// --- Port connection ---

let port: chrome.runtime.Port | null = null;

function connect(): void {
  port = chrome.runtime.connect({ name: 'agent-panel' });

  port.onMessage.addListener((msg: PanelMessage) => {
    handleMessage(msg);
  });

  port.onDisconnect.addListener(() => {
    port = null;
    appendMessage('Connection lost. Reopen the panel to reconnect.', 'error');
    setInputEnabled(true);
    updateStatus('idle');
  });
}

// --- Message handling ---

function handleMessage(msg: PanelMessage): void {
  switch (msg.type) {
    case 'status':
      updateStatus(msg.status);
      break;

    case 'action':
      appendMessage(`${msg.tool}(${JSON.stringify(msg.args)})`, 'action');
      break;

    case 'action_result': {
      const text = msg.success
        ? `OK${msg.data !== undefined ? ': ' + JSON.stringify(msg.data) : ''}`
        : `FAIL: ${msg.error ?? 'unknown error'}`;
      appendActionResult(text, msg.success);
      break;
    }

    case 'agent_message':
      appendMessage(msg.text, 'agent');
      break;

    case 'error':
      appendMessage(msg.text, 'error');
      break;

    case 'snapshot_preview':
      appendSnapshotPreview(msg.text);
      break;
  }
}

// --- UI helpers ---

function appendMessage(text: string, type: 'user' | 'agent' | 'action' | 'error'): void {
  const div = document.createElement('div');
  div.classList.add('message');

  switch (type) {
    case 'user':
      div.classList.add('message-user');
      break;
    case 'agent':
      div.classList.add('message-agent');
      break;
    case 'action':
      div.classList.add('message-action');
      break;
    case 'error':
      div.classList.add('message-error');
      break;
  }

  div.textContent = text;
  messageLog.appendChild(div);
  scrollToBottom();
}

function appendActionResult(text: string, success: boolean): void {
  const div = document.createElement('div');
  div.classList.add('message', 'message-action-result');
  if (!success) {
    div.classList.add('failure');
  }
  div.textContent = text;
  messageLog.appendChild(div);
  scrollToBottom();
}

function appendSnapshotPreview(text: string): void {
  const div = document.createElement('div');
  div.classList.add('message', 'message-snapshot');

  const toggle = document.createElement('span');
  toggle.classList.add('snapshot-toggle');
  toggle.textContent = '> Snapshot preview';

  const content = document.createElement('div');
  content.classList.add('snapshot-content');
  content.textContent = text;

  toggle.addEventListener('click', () => {
    content.classList.toggle('open');
    toggle.textContent = content.classList.contains('open')
      ? 'v Snapshot preview'
      : '> Snapshot preview';
  });

  div.appendChild(toggle);
  div.appendChild(content);
  messageLog.appendChild(div);
  scrollToBottom();
}

function updateStatus(status: 'thinking' | 'acting' | 'idle' | 'error'): void {
  statusText.className = 'status-text';

  switch (status) {
    case 'thinking':
      statusText.textContent = 'Thinking...';
      statusText.classList.add('thinking');
      stopBtn.hidden = false;
      setInputEnabled(false);
      break;
    case 'acting':
      statusText.textContent = 'Acting...';
      statusText.classList.add('acting');
      stopBtn.hidden = false;
      setInputEnabled(false);
      break;
    case 'error':
      statusText.textContent = 'Error';
      statusText.classList.add('error');
      stopBtn.hidden = true;
      setInputEnabled(true);
      break;
    case 'idle':
      statusText.textContent = 'Idle';
      stopBtn.hidden = true;
      setInputEnabled(true);
      break;
  }
}

function setInputEnabled(enabled: boolean): void {
  promptInput.disabled = !enabled;
  sendBtn.disabled = !enabled;
  if (enabled) {
    promptInput.focus();
  }
}

function scrollToBottom(): void {
  messageLog.scrollTop = messageLog.scrollHeight;
}

// --- User actions ---

function sendPrompt(): void {
  const text = promptInput.value.trim();
  if (!text || !port) return;

  port.postMessage({ type: 'user_prompt', text });
  appendMessage(text, 'user');
  promptInput.value = '';
  setInputEnabled(false);
}

// --- Event listeners ---

sendBtn.addEventListener('click', sendPrompt);

promptInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});

stopBtn.addEventListener('click', () => {
  if (port) {
    port.postMessage({ type: 'stop' });
  }
});

settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// --- Initialize ---

connect();
