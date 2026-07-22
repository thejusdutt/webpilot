# WebPilot — Chrome Web Store listing (ready to paste)

## Package
- ZIP: `webpilot-<version>.zip` built in the repo root (currently `webpilot-0.1.3.zip`)
- Store icon (128×128): `store-icon-128.png` (this folder)
- Screenshot (1280×800): `store-screenshot-1280x800.png` (this folder)

## Basic info

**Name:** WebPilot — LLM Browser Agent

**Summary (132 chars max):**
Automate your browser with the LLM of your choice: fill forms, apply to jobs, click through pages. Your keys, your device.

**Category:** Workflow & Planning (or Tools)

**Language:** English

**Description:**
WebPilot turns your browser into an AI agent. Describe a task in the side
panel — "fill out this form", "apply to this job" — and WebPilot reads the
page, fills fields from your saved profile, attaches your resume, and clicks
through multi-step flows, showing you every action as it happens.

BRING YOUR OWN MODEL
Works with OpenRouter, OpenAI, Anthropic, Google Gemini, Groq, a local Ollama,
or any OpenAI-compatible endpoint. Your API keys are stored only on your
device and requests go directly to the provider you chose — no middleman
server, no telemetry.

BUILT-IN SAFETY
• Asks before clicking submit / apply / pay buttons (configurable)
• Never invents personal data — it asks you when something is missing
• Login walls, CAPTCHAs and payments are always escalated to you
• Passwords on pages are masked before anything is sent to a model
• Optional autonomous mode for high-volume tasks, clearly marked as
  advanced/dangerous and off by default

FEATURES
• Tab-scoped side panel with a live action log
• Job-application profile + resume auto-attach
• Screenshot/vision support for visually complex pages
• Light & dark themes
• Open source: https://github.com/thejusdutt/webpilot

## Privacy tab

**Single purpose description:**
WebPilot automates browser tasks (form filling, job applications, page
navigation) in the current tab using an LLM API configured by the user.

**Permission justifications:**
- `storage` — saves the user's settings, profile, and API keys locally.
- `tabs` — identifies and tracks the tab the agent is operating in.
- `activeTab` / `scripting` — injects the content script that reads the
  page's form fields and performs the user-requested actions.
- `sidePanel` — hosts the extension's task UI.
- Host permission `<all_urls>` — the user can run automation on any site
  they choose; the extension only acts in the tab where the user starts a
  task, and only while a task is running. It also allows direct API calls
  to the LLM provider endpoint the user configured.
- Remote code: **No remote code is executed.**

**Data usage disclosures (check these):**
- Personally identifiable information: YES (name/contact the user enters,
  sent only to the user's chosen LLM provider to fill forms)
- Website content: YES (page text/fields of the active tab, sent to the
  user's chosen LLM provider)
- NOT sold to third parties; NOT used for unrelated purposes; NOT used for
  creditworthiness.

**Privacy policy URL:**
https://github.com/thejusdutt/webpilot/blob/main/PRIVACY.md

## Distribution
- Visibility: Public
- Regions: All
