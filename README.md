# 🛸 WebPilot — LLM Browser Agent (Chrome Extension)

A Manifest V3 Chrome extension that automates the browser with an LLM agent:
fill forms, apply to jobs, click through multi-step flows — driven from a side
panel chat. Bring your own API key from any supported provider.

## Providers

| Provider | Protocol | Endpoint |
|---|---|---|
| **OpenRouter** | OpenAI-compatible | `https://openrouter.ai/api/v1/chat/completions` |
| OpenAI | OpenAI | `https://api.openai.com/v1/chat/completions` |
| Anthropic | native Messages API | `https://api.anthropic.com/v1/messages` (`anthropic-version: 2023-06-01`) |
| Google Gemini | official OpenAI-compat endpoint | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` |
| Groq | OpenAI-compatible | `https://api.groq.com/openai/v1/chat/completions` |
| Ollama (local) | OpenAI-compatible | `http://localhost:11434/v1/chat/completions` |
| Custom | OpenAI-compatible | any base URL you enter |

All calls are made directly from the extension's service worker to the
provider — there is no middleman server. Keys live in `chrome.storage.local`
on your device.

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder (`webpilot/`).
3. Click the extension icon to open the side panel (pin it for convenience).
4. Open **Settings** (⚙️ in the panel):
   - pick a provider, paste an API key, click **List models** and choose a model;
   - fill in **Your profile** (used verbatim for form filling — the agent is
     instructed to never invent personal data);
   - optionally upload a **resume** (≤ 5 MB) for automatic attachment to
     file-upload fields.
5. Navigate to a form or job posting, type a task (or use a quick-action chip),
   hit **Run**.

## How it works

```
side panel ──port──> background service worker ──fetch──> LLM provider
                          │  ▲
                 executeScript / messages
                          ▼  │
                     content script (DOM)
```

- The **content script** snapshots the page: URL, title, and a numbered list of
  visible interactive elements (with labels, values, options, required/checked
  state). Indexes map back to live DOM nodes.
- The **service worker** runs the agent loop: it sends the task + page state to
  the model with a browser tool set, executes the returned tool calls in the
  tab, appends results + a fresh page state, and repeats until the model calls
  `done` (or the step cap is hit). Stale page states are pruned from history to
  keep token usage flat.
- Text is typed via native value setters + `input`/`change` events so
  React/Vue/Angular forms register the changes. File uploads are injected via
  `DataTransfer` into `<input type=file>`.

### Agent tools

`click`, `type_text`, `select_option`, `set_checkbox`, `scroll`, `navigate`,
`go_back`, `wait`, `read_page`, `upload_file` (stored resume), `ask_user`
(pauses and asks you in the panel), `done`.

### Safety rails

- **Confirm before submit** (default on): clicks on buttons matching
  submit/apply/pay/send patterns pause for your explicit approval in the panel.
- The system prompt forbids fabricating personal data; missing info triggers
  `ask_user` instead.
- Login walls, CAPTCHAs and payments are escalated to you, never guessed.
- **Stop** aborts the in-flight LLM call and the loop immediately.

## Notes & limitations

- Works on normal web pages; `chrome://`, the Web Store, and other extension
  pages can't be scripted (Chrome restriction).
- DOM-based (no screenshots), so canvas-heavy UIs aren't visible to the agent.
  Vision support would be the natural next step (`chrome.tabs.captureVisibleTab`).
- Cross-origin iframes (some embedded ATS forms) aren't reachable from the top
  frame's snapshot yet.
- Anthropic requests include the `anthropic-dangerous-direct-browser-access`
  header, which Anthropic requires for browser-context callers. Your key is
  only ever sent to `api.anthropic.com`.
- Use responsibly: some sites' terms of service restrict automation, and job
  boards may rate-limit or flag automated submissions. You remain responsible
  for everything submitted — that's what the confirm-before-submit gate is for.
