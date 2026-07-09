// options.js — settings UI. Stores everything under chrome.storage.local "settings".
import { PROVIDERS } from '../providers.js';

const $ = (id) => document.getElementById(id);

const PROFILE_FIELDS = [
  'fullName', 'email', 'phone', 'location', 'linkedin', 'website',
  'workAuthorization', 'salaryExpectation', 'noticePeriod', 'extraNotes',
];

let settings = {
  activeProvider: 'openrouter',
  providers: {},
  maxSteps: 40,
  confirmBeforeSubmit: true,
  visionMode: false,
  theme: 'light',
  profile: {},
  resume: null,
};

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

// Keep in sync when the side panel toggles the theme.
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings?.newValue) {
    const t = changes.settings.newValue.theme || 'light';
    settings.theme = t;
    applyTheme(t);
    const sel = $('theme');
    if (sel) sel.value = t;
  }
});

// -- provider section -------------------------------------------------------

const providerSelect = $('active-provider');
for (const [id, p] of Object.entries(PROVIDERS)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = p.label;
  providerSelect.appendChild(opt);
}

function currentProviderId() { return providerSelect.value; }

function providerState(id) {
  if (!settings.providers[id]) settings.providers[id] = {};
  return settings.providers[id];
}

function renderProviderFields() {
  const id = currentProviderId();
  const meta = PROVIDERS[id];
  const state = providerState(id);

  $('field-api-key').style.display = meta.noKey ? 'none' : '';
  $('api-key').value = state.apiKey || '';

  const keyLink = $('key-link');
  if (meta.keyUrl) { keyLink.href = meta.keyUrl; keyLink.style.display = ''; }
  else keyLink.style.display = 'none';

  const showBase = id === 'custom' || id === 'ollama';
  $('field-base-url').style.display = showBase ? '' : 'none';
  $('base-url').value = state.baseUrl || meta.baseUrl || '';

  $('model').value = state.model || meta.defaultModel || '';
  $('model-list').innerHTML = '';
  $('models-status').textContent = '';
}

// Persist the visible fields into the in-memory settings object.
function captureProviderFields() {
  const id = currentProviderId();
  const state = providerState(id);
  state.apiKey = $('api-key').value.trim();
  state.model = $('model').value.trim();
  const baseUrl = $('base-url').value.trim();
  if (baseUrl && baseUrl !== PROVIDERS[id].baseUrl) state.baseUrl = baseUrl;
  else delete state.baseUrl;
}

providerSelect.addEventListener('change', () => {
  renderProviderFields();
});
['api-key', 'model', 'base-url'].forEach((id) => {
  $(id).addEventListener('input', captureProviderFields);
});

$('fetch-models').addEventListener('click', async () => {
  captureProviderFields();
  const id = currentProviderId();
  const status = $('models-status');
  status.className = 'hint';
  status.textContent = 'Fetching…';
  const override = { ...providerState(id) };
  const res = await chrome.runtime.sendMessage({ type: 'list_models', provider: id, override });
  if (!res?.ok) {
    status.className = 'hint err';
    status.textContent = `Failed: ${res?.error || 'no response'}`;
    return;
  }
  const list = $('model-list');
  list.innerHTML = '';
  for (const m of res.models) {
    const opt = document.createElement('option');
    opt.value = m;
    list.appendChild(opt);
  }
  status.className = 'hint ok';
  status.textContent = `${res.models.length} models loaded — the Model box now autocompletes.`;
});

// -- resume ------------------------------------------------------------------

function renderResume() {
  $('resume-status').textContent = settings.resume
    ? `Stored: ${settings.resume.fileName} (${Math.round(settings.resume.base64.length * 0.75 / 1024)} KB)`
    : 'No resume stored.';
}

$('resume-file').addEventListener('change', () => {
  const file = $('resume-file').files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    $('resume-status').textContent = 'File too large — keep it under 5 MB.';
    $('resume-file').value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = String(reader.result).split(',')[1];
    settings.resume = { fileName: file.name, mimeType: file.type || 'application/pdf', base64 };
    renderResume();
  };
  reader.readAsDataURL(file);
});

$('resume-clear').addEventListener('click', () => {
  settings.resume = null;
  $('resume-file').value = '';
  renderResume();
});

// -- load / save --------------------------------------------------------------

async function load() {
  const stored = (await chrome.storage.local.get('settings')).settings;
  if (stored) {
    settings = { ...settings, ...stored, profile: { ...settings.profile, ...(stored.profile || {}) } };
    if (!settings.providers) settings.providers = {};
  }
  providerSelect.value = settings.activeProvider in PROVIDERS ? settings.activeProvider : 'openrouter';
  renderProviderFields();
  $('max-steps').value = settings.maxSteps ?? 40;
  $('confirm-submit').checked = settings.confirmBeforeSubmit !== false;
  $('vision-mode').checked = settings.visionMode === true;
  $('autonomous-mode').checked = settings.autonomousMode === true;
  $('theme').value = settings.theme === 'dark' ? 'dark' : 'light';
  applyTheme(settings.theme);
  for (const f of PROFILE_FIELDS) {
    const el = $(`p-${f}`);
    if (el) el.value = settings.profile?.[f] || '';
  }
  renderResume();
}

$('theme').addEventListener('change', () => applyTheme($('theme').value));

$('save').addEventListener('click', async () => {
  captureProviderFields();
  settings.activeProvider = currentProviderId();
  settings.maxSteps = Math.max(5, Math.min(1000, parseInt($('max-steps').value, 10) || 40));
  settings.confirmBeforeSubmit = $('confirm-submit').checked;
  settings.visionMode = $('vision-mode').checked;
  settings.autonomousMode = $('autonomous-mode').checked;
  settings.theme = $('theme').value;
  applyTheme(settings.theme);
  settings.profile = settings.profile || {};
  for (const f of PROFILE_FIELDS) {
    const el = $(`p-${f}`);
    if (el) settings.profile[f] = el.value.trim();
  }
  await chrome.storage.local.set({ settings });
  const status = $('save-status');
  status.className = 'hint ok';
  status.textContent = 'Saved ✓';
  setTimeout(() => { status.textContent = ''; }, 2500);
});

load();
