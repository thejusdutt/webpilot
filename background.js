// background.js — agent orchestrator. Runs the observe → think → act loop:
// snapshot the page, call the configured LLM with browser tools, execute the
// returned tool calls in the tab, feed results back, repeat.

import { chat, listModels, PROVIDERS } from './providers.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS = {
  activeProvider: 'openrouter',
  providers: {},           // { [id]: { apiKey, model, baseUrl } }
  maxSteps: 40,
  confirmBeforeSubmit: true,
  visionMode: false,       // attach a screenshot to every step (vision models only)
  theme: 'light',          // side panel / options appearance
  profile: {
    fullName: '', email: '', phone: '', location: '',
    linkedin: '', website: '', workAuthorization: '',
    salaryExpectation: '', noticePeriod: '', extraNotes: '',
  },
  resume: null,            // { fileName, mimeType, base64 }
};

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return {
    ...DEFAULT_SETTINGS,
    ...(settings || {}),
    profile: { ...DEFAULT_SETTINGS.profile, ...(settings?.profile || {}) },
  };
}

// ---------------------------------------------------------------------------
// Tool definitions (canonical OpenAI-style JSON schema; providers.js converts
// to Anthropic input_schema as needed)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'click',
    description: 'Click an interactive element by its index from the current page state. Use for buttons, links, tabs, radio buttons, dropdown triggers.',
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer', description: 'Element index from the page state' } },
      required: ['index'],
    },
  },
  {
    name: 'type_text',
    description: 'Clear a text input / textarea / contenteditable and type the given text into it.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer' },
        text: { type: 'string' },
        press_enter: { type: 'boolean', description: 'Press Enter after typing (e.g. to submit a search)' },
      },
      required: ['index', 'text'],
    },
  },
  {
    name: 'select_option',
    description: 'Choose an option in a native <select> dropdown by visible label or value. For custom (div-based) dropdowns, use click instead.',
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer' }, value: { type: 'string', description: 'Option label or value to select' } },
      required: ['index', 'value'],
    },
  },
  {
    name: 'set_checkbox',
    description: 'Check or uncheck a checkbox / toggle / radio input.',
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer' }, checked: { type: 'boolean' } },
      required: ['index', 'checked'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll the page to reveal more elements. The next page state reflects the new viewport.',
    parameters: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] } },
      required: ['direction'],
    },
  },
  {
    name: 'navigate',
    description: 'Navigate the current tab to a URL.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'go_back',
    description: 'Go back one page in browser history.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'wait',
    description: 'Wait for the page to load or update (max 10 seconds). Use when content is still loading.',
    parameters: {
      type: 'object',
      properties: { seconds: { type: 'number' } },
      required: ['seconds'],
    },
  },
  {
    name: 'read_page',
    description: 'Read the visible text content of the page. Use to understand job descriptions, form instructions, error messages, or confirmation text.',
    parameters: {
      type: 'object',
      properties: { max_chars: { type: 'integer', description: 'Default 6000' } },
    },
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of the current viewport and attach it as an image. Use when the DOM element list is not enough to understand the page: canvas widgets, image content, visual layout questions, or to double-check what the user actually sees. Requires a vision-capable model.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'upload_file',
    description: "Attach the user's stored resume/CV file to a file input element. Only works on <input type=file> elements.",
    parameters: {
      type: 'object',
      properties: { index: { type: 'integer' } },
      required: ['index'],
    },
  },
  {
    name: 'ask_user',
    description: 'Ask the user a question and wait for their answer. Use whenever required information is missing from the task and profile (e.g. an application question you cannot answer truthfully), or before an irreversible step you are unsure about. NEVER invent personal information.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
  },
  {
    name: 'done',
    description: 'Finish the task. Call when the task is complete, or when it cannot be completed.',
    parameters: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        summary: { type: 'string', description: 'What was accomplished, or why the task could not be completed' },
      },
      required: ['success', 'summary'],
    },
  },
];

function buildSystemPrompt(settings) {
  const p = settings.profile;
  const profileLines = [
    ['Full name', p.fullName], ['Email', p.email], ['Phone', p.phone],
    ['Location', p.location], ['LinkedIn', p.linkedin], ['Website/Portfolio', p.website],
    ['Work authorization', p.workAuthorization], ['Salary expectation', p.salaryExpectation],
    ['Notice period', p.noticePeriod],
  ].filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`);
  if (p.extraNotes) profileLines.push(`- Additional notes / answers to common questions:\n${p.extraNotes}`);
  if (settings.resume) profileLines.push(`- Resume file available: "${settings.resume.fileName}" (use upload_file on file inputs)`);

  return `You are WebPilot, a careful browser automation agent running inside the user's Chrome browser. You complete tasks like filling forms, applying to jobs, and navigating websites by calling tools.

HOW IT WORKS
- After every action you receive the result plus a fresh <page_state> block: the URL, title, scroll position, and a numbered list of interactive elements.
- Element indexes are ONLY valid for the most recent page state. After any click, navigation, or scroll, indexes may change — always use the latest state.
- Elements marked (off-screen) exist but are outside the viewport; you can still interact with them (they will be scrolled into view automatically).
- If the elements you need are not listed, scroll, or use read_page to understand the page.
- If the DOM state is not enough (canvas widgets, images, visual layout), use the screenshot tool — the screenshot arrives as an image you can see.

RULES
1. Work step by step. Prefer one or two actions per turn, then re-check the page state.
2. Fill forms using the USER PROFILE below. NEVER fabricate personal data, qualifications, or answers. If a required field is not covered by the profile or task, call ask_user.
3. For job applications: read the form carefully, fill every required field, attach the resume with upload_file where a CV/resume upload exists, and answer screening questions truthfully from the profile.
4. Before clicking a final submit button, double-check that all required fields are filled and the values are correct.
5. If the same action fails twice, try a different approach (scroll, read_page, another element) instead of repeating it.
6. If a page requires login, CAPTCHA, or payment, stop and ask_user — never guess credentials.
7. When the task is finished (or impossible), call done with an honest summary.

USER PROFILE
${profileLines.length ? profileLines.join('\n') : '(empty — ask_user for any personal data you need)'}`;
}

// ---------------------------------------------------------------------------
// Tab / content-script helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureContentScript(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { __webpilot: true, action: 'ping' });
    if (res?.pong) return;
  } catch { /* not injected yet */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (err) {
    throw new Error(`Cannot control this page (${err.message}). chrome://, the Web Store and some browser pages are off-limits — navigate to a normal website first.`);
  }
}

async function sendToTab(tabId, action, params, options = {}) {
  await ensureContentScript(tabId);
  const res = await chrome.tabs.sendMessage(tabId, { __webpilot: true, action, params, options });
  if (!res) throw new Error('No response from page — it may have navigated. Retrying on the next step usually works.');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}

/** Capture the tab's viewport as a downscaled JPEG (base64). */
async function captureScreenshot(tabId, maxWidth = 1024) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) {
    // captureVisibleTab shoots whatever is visible in the window.
    await chrome.tabs.update(tabId, { active: true });
    await sleep(300);
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 80 });
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxWidth / bmp.width);
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const base64 = btoa(bin);
  return { mimeType: 'image/jpeg', base64, dataUrl: `data:image/jpeg;base64,${base64}` };
}

/** Wait for any in-flight navigation triggered by the last action to finish. */
async function settle(tabId) {
  await sleep(700);
  const deadline = Date.now() + 15000;
  for (;;) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { throw new Error('The tab was closed.'); }
    if (tab.status === 'complete' || Date.now() > deadline) break;
    await sleep(300);
  }
  await sleep(300);
}

// ---------------------------------------------------------------------------
// Agent run
// ---------------------------------------------------------------------------

const PAGE_STATE_RE = /<page_state>[\s\S]*?<\/page_state>/g;

class AgentRun {
  constructor(task, tabId, settings, post) {
    this.task = task;
    this.tabId = tabId;
    this.settings = settings;
    this.post = post;               // send an event to the side panel
    this.messages = [];
    this.stopped = false;
    this.abort = new AbortController();
    this.pendingAnswer = null;      // {resolve} while waiting on the user
    this.pendingImages = [];        // screenshots to attach after this turn's tools
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
    if (this.pendingAnswer) { this.pendingAnswer.resolve(null); this.pendingAnswer = null; }
  }

  provideAnswer(answer) {
    if (this.pendingAnswer) { this.pendingAnswer.resolve(answer); this.pendingAnswer = null; }
  }

  askUser(kind, text) {
    this.post({ type: kind, text });
    return new Promise((resolve) => { this.pendingAnswer = { resolve }; });
  }

  checkStopped() {
    if (this.stopped) throw new Error('__stopped__');
  }

  async pageStateBlock() {
    try {
      const s = await sendToTab(this.tabId, 'snapshot', {});
      return `<page_state>\nURL: ${s.url}\nTitle: ${s.title}\nScroll: ${s.scroll}\nInteractive elements (${s.elementCount}):\n${s.elements}\n</page_state>`;
    } catch (err) {
      return `<page_state>\nCould not read the page: ${err.message}\n</page_state>`;
    }
  }

  /** Keep only the newest page state and screenshot — old ones dominate token usage. */
  pruneOldPageStates() {
    for (const m of this.messages) {
      if ((m.role === 'tool' || m.role === 'user') && typeof m.content === 'string') {
        m.content = m.content.replace(PAGE_STATE_RE, '[stale page state removed — see the latest one below]');
      }
      if (m.images?.length) {
        delete m.images;
        m.content = '[stale screenshot removed — see the latest one below]';
      }
    }
  }

  async executeTool(tc) {
    const { name, args = {} } = tc;
    switch (name) {
      case 'click': {
        const result = await sendToTab(this.tabId, 'click', { index: args.index }, { confirmSubmit: this.settings.confirmBeforeSubmit });
        if (result.needsConfirmation) {
          const answer = await this.askUser('confirm', `The agent wants to click "${result.label}", which looks like a final submit action. Allow it?`);
          this.checkStopped();
          if (answer !== 'yes') return `The user DECLINED the click on "${result.label}". Ask them what to change, or adjust course.`;
          const r2 = await sendToTab(this.tabId, 'click', { index: args.index, confirmed: true }, { confirmSubmit: true });
          await settle(this.tabId);
          return r2.message + ' (user approved)';
        }
        await settle(this.tabId);
        return result.message;
      }
      case 'type_text': {
        const r = await sendToTab(this.tabId, 'type_text', args);
        if (args.press_enter) await settle(this.tabId);
        return r.message;
      }
      case 'select_option':
        return (await sendToTab(this.tabId, 'select_option', args)).message;
      case 'set_checkbox':
        return (await sendToTab(this.tabId, 'set_checkbox', args)).message;
      case 'scroll':
        return (await sendToTab(this.tabId, 'scroll', args)).message;
      case 'read_page':
        return (await sendToTab(this.tabId, 'read_page', args)).message;
      case 'navigate': {
        let url = String(args.url || '');
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        await chrome.tabs.update(this.tabId, { url });
        await settle(this.tabId);
        return `Navigated to ${url}`;
      }
      case 'go_back':
        await chrome.tabs.goBack(this.tabId).catch(() => { throw new Error('Cannot go back — no history.'); });
        await settle(this.tabId);
        return 'Went back one page.';
      case 'wait': {
        const secs = Math.min(Math.max(Number(args.seconds) || 1, 0.5), 10);
        await sleep(secs * 1000);
        return `Waited ${secs}s.`;
      }
      case 'upload_file': {
        const resume = this.settings.resume;
        if (!resume) return 'ERROR: No resume is stored. Ask the user to upload one in Settings, or ask_user how to proceed.';
        const r = await sendToTab(this.tabId, 'upload_file', {
          index: args.index, fileName: resume.fileName, mimeType: resume.mimeType, base64: resume.base64,
        });
        await sleep(1000); // many ATSs parse the file and update the form
        return r.message;
      }
      case 'screenshot': {
        const shot = await captureScreenshot(this.tabId);
        this.pendingImages.push(shot);
        this.post({ type: 'screenshot', dataUrl: shot.dataUrl });
        return 'Screenshot captured — attached below as an image.';
      }
      case 'ask_user': {
        const answer = await this.askUser('ask', args.question || 'The agent has a question.');
        this.checkStopped();
        return answer ? `User answered: ${answer}` : 'User did not answer.';
      }
      default:
        return `ERROR: Unknown tool "${name}".`;
    }
  }

  async run() {
    const providerId = this.settings.activeProvider;
    const providerLabel = PROVIDERS[providerId]?.label || providerId;
    const model = this.settings.providers?.[providerId]?.model || PROVIDERS[providerId]?.defaultModel;
    this.post({ type: 'status', text: `Running with ${providerLabel} · ${model}` });

    this.messages.push({ role: 'system', content: buildSystemPrompt(this.settings) });
    await ensureContentScript(this.tabId);
    this.messages.push({
      role: 'user',
      content: `TASK: ${this.task}\n\n${await this.pageStateBlock()}`,
    });

    const maxSteps = Math.max(1, Math.min(this.settings.maxSteps || 40, 100));

    for (let step = 1; step <= maxSteps; step++) {
      this.checkStopped();
      this.post({ type: 'step', step, maxSteps });

      let reply;
      try {
        reply = await chat(providerId, this.settings, {
          messages: this.messages,
          tools: TOOLS,
          signal: this.abort.signal,
        });
      } catch (err) {
        if (this.stopped) throw new Error('__stopped__');
        throw new Error(`LLM request failed (${providerLabel}): ${err.message}`);
      }

      if (reply.content?.trim()) this.post({ type: 'thought', text: reply.content.trim() });

      if (!reply.toolCalls.length) {
        // Model answered in plain text — nudge once, then accept as final.
        this.messages.push({ role: 'assistant', content: reply.content || '' });
        if (step === maxSteps) break;
        this.messages.push({
          role: 'user',
          content: 'Continue using tools. If the task is finished, call done(success, summary).',
        });
        continue;
      }

      this.messages.push({ role: 'assistant', content: reply.content || '', toolCalls: reply.toolCalls });

      let finished = null;
      for (let i = 0; i < reply.toolCalls.length; i++) {
        const tc = reply.toolCalls[i];
        this.checkStopped();

        if (tc.name === 'done') {
          finished = { success: tc.args?.success !== false, summary: tc.args?.summary || 'Task finished.' };
          this.messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: 'Acknowledged.' });
          continue;
        }

        this.post({ type: 'action', name: tc.name, args: tc.args });
        let content, isError = false;
        try {
          content = await this.executeTool(tc);
        } catch (err) {
          if (err.message === '__stopped__') throw err;
          content = `ERROR: ${err.message}`;
          isError = true;
        }
        this.post({ type: 'result', text: content, isError });

        // Attach a fresh page state to the last executed tool result.
        if (i === reply.toolCalls.length - 1) {
          this.pruneOldPageStates();
          content += `\n\n${await this.pageStateBlock()}`;
        }
        this.messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content, isError });
      }

      if (finished) {
        this.post({ type: 'done', success: finished.success, text: finished.summary });
        return;
      }

      // Attach screenshots: requested via the screenshot tool, or automatic in vision mode.
      if (this.settings.visionMode && !this.pendingImages.length) {
        try {
          const shot = await captureScreenshot(this.tabId);
          this.pendingImages.push(shot);
          this.post({ type: 'screenshot', dataUrl: shot.dataUrl });
        } catch { /* capture can fail on restricted pages — non-fatal */ }
      }
      if (this.pendingImages.length) {
        this.messages.push({
          role: 'user',
          content: '[Screenshot of the current viewport]',
          images: this.pendingImages.splice(0),
        });
      }
    }

    this.post({
      type: 'done', success: false,
      text: `Stopped after ${maxSteps} steps without the agent calling done. You can refine the task and try again.`,
    });
  }
}

// ---------------------------------------------------------------------------
// Side panel wiring
// ---------------------------------------------------------------------------

let panelPort = null;
let currentRun = null;

function postToPanel(msg) {
  try { panelPort?.postMessage(msg); } catch { /* panel closed */ }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'webpilot-panel') return;
  panelPort = port;
  port.postMessage({ type: 'hello', running: !!currentRun });

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'start') {
      if (currentRun) { postToPanel({ type: 'error', text: 'A task is already running. Stop it first.' }); return; }
      const settings = await loadSettings();
      let tabId = msg.tabId;
      if (!tabId) {
        try {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          tabId = tab?.id;
        } catch { /* fallthrough */ }
      }
      if (!tabId) { postToPanel({ type: 'error', text: 'No active tab found.' }); return; }

      currentRun = new AgentRun(msg.task, tabId, settings, postToPanel);
      postToPanel({ type: 'started' });
      // MV3 service workers idle out after ~30s without extension API activity;
      // a slow LLM response alone doesn't count. Ping a cheap API to stay alive.
      const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
      try {
        await currentRun.run();
      } catch (err) {
        if (err.message === '__stopped__') {
          postToPanel({ type: 'done', success: false, text: 'Stopped by user.' });
        } else {
          postToPanel({ type: 'error', text: err.message });
          postToPanel({ type: 'done', success: false, text: 'Task aborted due to an error.' });
        }
      } finally {
        clearInterval(keepAlive);
        currentRun = null;
      }
    } else if (msg.type === 'stop') {
      currentRun?.stop();
    } else if (msg.type === 'user_answer') {
      currentRun?.provideAnswer(msg.answer);
    }
  });

  port.onDisconnect.addListener(() => {
    if (panelPort === port) panelPort = null;
    // The run continues headless; results are lost unless the panel reconnects.
  });
});

// Options page requests (model listing) arrive via one-shot messages.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'list_models') {
    (async () => {
      try {
        const settings = await loadSettings();
        // Allow the options page to pass not-yet-saved credentials.
        if (msg.override) {
          settings.providers = { ...settings.providers, [msg.provider]: { ...settings.providers[msg.provider], ...msg.override } };
        }
        const models = await listModels(msg.provider, settings);
        sendResponse({ ok: true, models });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true; // async response
  }
});
