# WebPilot Privacy Policy

_Last updated: 2026-07-09_

WebPilot is a browser automation extension that runs entirely on your device.

## What data WebPilot stores

- **Profile information you enter in Settings** (name, contact details, work
  authorization, screening-question answers) and an optional **resume file**.
- **API keys** for the LLM providers you configure.
- Your preferences (theme, agent options).

All of this is stored locally in `chrome.storage.local` on your device. It is
never transmitted to the extension's developer — WebPilot has **no backend
server** and collects **no analytics or telemetry**.

## What data leaves your device

When you run a task, WebPilot sends the content of the active tab (page text,
form field labels/values, and — only if you use the screenshot feature —
viewport images) together with your profile data **directly to the LLM
provider you configured** (e.g. OpenRouter, OpenAI, Anthropic, Google,
Groq, or your own endpoint), using **your own API key**. That transmission is
governed by the privacy policy of the provider you chose. Nothing is sent
anywhere else.

Passwords visible on pages are masked before page content is sent to any
provider.

## Data sharing and sale

WebPilot does not sell, share, or transfer your data to any third party other
than the LLM provider you explicitly configure.

## Data removal

Remove all stored data at any time by clearing the extension's storage
(Settings → remove keys/profile/resume) or by uninstalling the extension.

## Contact

Questions: open an issue at https://github.com/thejusdutt/webpilot/issues
