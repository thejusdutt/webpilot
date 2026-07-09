// sidepanel.js — chat-style UI over a long-lived port to the service worker.

const log = document.getElementById('log');
const welcome = document.getElementById('welcome');
const taskInput = document.getElementById('task-input');
const runBtn = document.getElementById('run-btn');
const stopBtn = document.getElementById('stop-btn');
const promptArea = document.getElementById('prompt-area');
const promptText = document.getElementById('prompt-text');
const promptControls = document.getElementById('prompt-controls');
const modelBadge = document.getElementById('model-badge');

let port = null;
let running = false;

function connect() {
  port = chrome.runtime.connect({ name: 'webpilot-panel' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    // Service worker went idle; reconnect on next interaction.
    port = null;
  });
}

function ensurePort() {
  if (!port) connect();
  return port;
}

function addEntry(cls, text) {
  welcome?.remove();
  const div = document.createElement('div');
  div.className = `entry ${cls}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function setRunning(v) {
  running = v;
  runBtn.classList.toggle('hidden', v);
  stopBtn.classList.toggle('hidden', !v);
  taskInput.disabled = v;
  if (!v) hidePrompt();
}

function fmtArgs(args) {
  if (!args || !Object.keys(args).length) return '';
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v.length > 60 ? v.slice(0, 60) + '…' : v) : JSON.stringify(v)}`)
    .join(', ');
}

function onMessage(msg) {
  switch (msg.type) {
    case 'hello':
      setRunning(msg.running);
      break;
    case 'started':
      setRunning(true);
      break;
    case 'status':
      addEntry('status', msg.text);
      break;
    case 'step':
      addEntry('step', `Step ${msg.step} / ${msg.maxSteps}`);
      break;
    case 'thought':
      addEntry('thought', msg.text);
      break;
    case 'action':
      addEntry('action', `→ ${msg.name}(${fmtArgs(msg.args)})`);
      break;
    case 'result':
      addEntry(`result${msg.isError ? ' error' : ''}`, msg.text.split('\n')[0].slice(0, 300));
      break;
    case 'ask':
      showAsk(msg.text);
      break;
    case 'confirm':
      showConfirm(msg.text);
      break;
    case 'error':
      addEntry('error', `⚠ ${msg.text}`);
      break;
    case 'done':
      addEntry(msg.success ? 'done-ok' : 'done-fail', `${msg.success ? '✓' : '✕'} ${msg.text}`);
      setRunning(false);
      break;
  }
}

function hidePrompt() {
  promptArea.classList.add('hidden');
  promptControls.innerHTML = '';
}

function showAsk(question) {
  promptText.textContent = `❓ ${question}`;
  promptControls.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Your answer…';
  const send = document.createElement('button');
  send.className = 'secondary';
  send.textContent = 'Send';
  const submit = () => {
    const answer = input.value.trim();
    if (!answer) return;
    addEntry('status', `You: ${answer}`);
    ensurePort().postMessage({ type: 'user_answer', answer });
    hidePrompt();
  };
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  promptControls.append(input, send);
  promptArea.classList.remove('hidden');
  input.focus();
}

function showConfirm(text) {
  promptText.textContent = `🛑 ${text}`;
  promptControls.innerHTML = '';
  const yes = document.createElement('button');
  yes.className = 'primary';
  yes.textContent = 'Allow';
  const no = document.createElement('button');
  no.className = 'danger';
  no.textContent = 'Deny';
  yes.addEventListener('click', () => {
    addEntry('status', 'You approved the action.');
    ensurePort().postMessage({ type: 'user_answer', answer: 'yes' });
    hidePrompt();
  });
  no.addEventListener('click', () => {
    addEntry('status', 'You denied the action.');
    ensurePort().postMessage({ type: 'user_answer', answer: 'no' });
    hidePrompt();
  });
  promptControls.append(yes, no);
  promptArea.classList.remove('hidden');
}

async function startTask(task) {
  if (running || !task) return;
  addEntry('status', `Task: ${task}`);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  ensurePort().postMessage({ type: 'start', task, tabId: tab?.id });
}

runBtn.addEventListener('click', () => {
  const task = taskInput.value.trim();
  if (!task) { taskInput.focus(); return; }
  startTask(task);
});

taskInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runBtn.click();
});

stopBtn.addEventListener('click', () => {
  ensurePort().postMessage({ type: 'stop' });
  addEntry('status', 'Stopping…');
});

document.getElementById('settings-btn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    taskInput.value = chip.dataset.task;
    startTask(chip.dataset.task);
  });
});

async function refreshBadge() {
  const { settings } = await chrome.storage.local.get('settings');
  const provider = settings?.activeProvider || 'openrouter';
  const model = settings?.providers?.[provider]?.model || '';
  modelBadge.textContent = model ? `${provider} · ${model}` : provider;
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) refreshBadge();
});

connect();
refreshBadge();
