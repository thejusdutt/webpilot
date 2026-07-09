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
const themeBtn = document.getElementById('theme-btn');

let port = null;
let running = false;
let thinkingEl = null;
let replaying = false;

// ---------- theme ----------

const ICON_MOON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"/></svg>';
const ICON_SUN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19"/></svg>';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  themeBtn.innerHTML = theme === 'dark' ? ICON_SUN : ICON_MOON;
}

async function initTheme() {
  const { settings } = await chrome.storage.local.get('settings');
  applyTheme(settings?.theme || 'light');
}

themeBtn.addEventListener('click', async () => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  settings.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  await chrome.storage.local.set({ settings });
  // applyTheme runs via the storage.onChanged listener below
});

// ---------- port ----------

function connect() {
  port = chrome.runtime.connect({ name: 'webpilot-panel' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => { port = null; });
}

function ensurePort() {
  if (!port) connect();
  return port;
}

// ---------- log rendering ----------

function addEntry(cls, text) {
  welcome?.remove();
  const div = document.createElement('div');
  div.className = `entry ${cls}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function showThinking() {
  if (replaying) return;
  hideThinking();
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'entry thinking';
  thinkingEl.innerHTML = 'working <span class="dots"><span></span><span></span><span></span></span>';
  log.appendChild(thinkingEl);
  log.scrollTop = log.scrollHeight;
}

function hideThinking() {
  thinkingEl?.remove();
  thinkingEl = null;
}

function setRunning(v) {
  running = v;
  runBtn.classList.toggle('hidden', v);
  stopBtn.classList.toggle('hidden', !v);
  taskInput.disabled = v;
  document.querySelectorAll('.chip').forEach((c) => { c.disabled = v; });
  if (!v) { hidePrompt(); hideThinking(); }
}

const trim = (s, n = 70) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

/** Human-friendly one-liner for a tool call (minimal, no emoji noise). */
function describeAction(name, args = {}) {
  switch (name) {
    case 'click': return `Click [${args.index}]`;
    case 'type_text': return `Type “${trim(args.text)}” → [${args.index}]${args.press_enter ? ' + Enter' : ''}`;
    case 'select_option': return `Select “${trim(args.value, 50)}” → [${args.index}]`;
    case 'set_checkbox': return `${args.checked ? 'Check' : 'Uncheck'} [${args.index}]`;
    case 'scroll': return `Scroll ${args.direction}`;
    case 'navigate': return `Open ${trim(args.url, 60)}`;
    case 'go_back': return 'Go back';
    case 'wait': return `Wait ${args.seconds}s`;
    case 'read_page': return 'Read page text';
    case 'screenshot': return 'Take screenshot';
    case 'upload_file': return `Attach resume → [${args.index}]`;
    case 'ask_user': return 'Ask you a question';
    default: return `${name}(${JSON.stringify(args)})`;
  }
}

function onMessage(msg) {
  if (['thought', 'action', 'result', 'error', 'done', 'screenshot'].includes(msg.type)) hideThinking();
  switch (msg.type) {
    case 'hello':
      // Panel (re)opened — per-tab panels reload on every tab switch, so the
      // service worker replays the buffered run log to restore the view.
      if (msg.events?.length) {
        log.innerHTML = '';
        replaying = true;
        for (const e of msg.events) onMessage(e);
        replaying = false;
      }
      setRunning(msg.running);
      if (msg.running) showThinking();
      if (msg.prompt) (msg.prompt.kind === 'confirm' ? showConfirm : showAsk)(msg.prompt.text);
      break;
    case 'started':
      setRunning(true);
      break;
    case 'status':
      addEntry('status', msg.text);
      break;
    case 'step':
      addEntry('step', `Step ${msg.step} of ${msg.maxSteps}`);
      showThinking();
      break;
    case 'thought':
      addEntry('thought', msg.text);
      break;
    case 'action':
      addEntry('action', describeAction(msg.name, msg.args));
      break;
    case 'result':
      addEntry(`result${msg.isError ? ' error' : ''}`, msg.text.split('\n')[0].slice(0, 300));
      break;
    case 'screenshot': {
      const div = addEntry('shot', '');
      const img = document.createElement('img');
      img.src = msg.dataUrl;
      img.alt = 'screenshot';
      div.appendChild(img);
      break;
    }
    case 'ask':
      showAsk(msg.text);
      break;
    case 'confirm':
      showConfirm(msg.text);
      break;
    case 'error':
      addEntry('error', msg.text);
      break;
    case 'done':
      addEntry(msg.success ? 'done-ok' : 'done-fail', msg.text);
      setRunning(false);
      break;
  }
}

// ---------- ask / confirm ----------

function hidePrompt() {
  promptArea.classList.add('hidden');
  promptControls.innerHTML = '';
}

const promptKind = document.getElementById('prompt-kind');

function showAsk(question) {
  promptKind.textContent = 'Question';
  promptKind.className = '';
  promptText.textContent = question;
  promptControls.innerHTML = '';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Your answer…';
  const send = document.createElement('button');
  send.className = 'primary';
  send.style.flex = '0 0 auto';
  send.textContent = 'Send';
  const submit = () => {
    const answer = input.value.trim();
    if (!answer) return;
    addEntry('status', `You: ${answer}`);
    ensurePort().postMessage({ type: 'user_answer', answer });
    hidePrompt();
    showThinking();
  };
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  promptControls.append(input, send);
  promptArea.classList.remove('hidden');
  input.focus();
}

function showConfirm(text) {
  promptKind.textContent = 'Approval needed';
  promptKind.className = 'danger';
  promptText.textContent = text;
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
    showThinking();
  });
  no.addEventListener('click', () => {
    addEntry('status', 'You denied the action.');
    ensurePort().postMessage({ type: 'user_answer', answer: 'no' });
    hidePrompt();
    showThinking();
  });
  promptControls.append(yes, no);
  promptArea.classList.remove('hidden');
}

// ---------- task control ----------

async function startTask(task) {
  if (running || !task) return;
  // The background echoes the task back as a status event (so it also
  // survives panel reloads) — no local entry needed.
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

// ---------- badge + storage sync ----------

async function refreshBadge() {
  const { settings } = await chrome.storage.local.get('settings');
  const provider = settings?.activeProvider || 'openrouter';
  const model = settings?.providers?.[provider]?.model || '';
  modelBadge.textContent = model ? `${provider} · ${model}` : provider;
  if (settings?.autonomousMode) {
    modelBadge.textContent = `autonomous · ${modelBadge.textContent}`;
    modelBadge.classList.add('danger');
    modelBadge.title = 'Autonomous mode is ON — no confirmations, no questions (change in Settings)';
  } else {
    modelBadge.classList.remove('danger');
    modelBadge.title = 'Active provider · model';
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) {
    refreshBadge();
    applyTheme(changes.settings.newValue?.theme || 'light');
  }
});

connect();
initTheme();
refreshBadge();
