// providers.js — multi-provider LLM client.
//
// Two wire protocols cover every provider:
//   - "openai"    : OpenAI-compatible /chat/completions (OpenRouter, OpenAI,
//                   Gemini via its official OpenAI-compat endpoint, Groq,
//                   Ollama, any custom base URL)
//   - "anthropic" : native Anthropic Messages API
//
// All requests are made from the extension service worker; host_permissions
// in the manifest exempt them from CORS.

export const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.2',
    keyUrl: 'https://openrouter.ai/keys',
  },
  openai: {
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.2',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    label: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-opus-4-8',
    keyUrl: 'https://platform.claude.com/settings/keys',
  },
  gemini: {
    label: 'Google Gemini',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  groq: {
    label: 'Groq',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
  },
  ollama: {
    label: 'Ollama (local)',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    noKey: true,
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    kind: 'openai',
    baseUrl: '',
    defaultModel: '',
  },
};

function providerConfig(providerId, settings) {
  const base = PROVIDERS[providerId];
  if (!base) throw new Error(`Unknown provider: ${providerId}`);
  const user = settings.providers?.[providerId] || {};
  const baseUrl = (user.baseUrl || base.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error(`${base.label}: base URL is not configured (see Settings).`);
  const apiKey = (user.apiKey || '').trim();
  if (!apiKey && !base.noKey) {
    throw new Error(`${base.label}: no API key configured. Open Settings and add one.`);
  }
  return { ...base, id: providerId, baseUrl, apiKey };
}

async function readError(resp) {
  let detail = '';
  try {
    const body = await resp.json();
    detail = body?.error?.message || body?.message || JSON.stringify(body).slice(0, 400);
  } catch {
    try { detail = (await resp.text()).slice(0, 400); } catch { /* ignore */ }
  }
  return new Error(`HTTP ${resp.status}: ${detail || resp.statusText}`);
}

function safeParseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { _raw: String(raw) }; }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter
// ---------------------------------------------------------------------------

function toOpenAIMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        })),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content ?? '' };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

async function chatOpenAI(cfg, { model, messages, tools, signal }) {
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  if (cfg.id === 'openrouter') {
    // Optional app attribution (shows up on openrouter.ai rankings).
    headers['HTTP-Referer'] = 'https://github.com/webpilot-extension';
    headers['X-Title'] = 'WebPilot';
  }

  const body = {
    model,
    messages: toOpenAIMessages(messages),
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = 'auto';
  }

  const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) throw await readError(resp);
  const data = await resp.json();

  const choice = data.choices?.[0];
  if (!choice) throw new Error(`Provider returned no choices: ${JSON.stringify(data).slice(0, 300)}`);
  const msg = choice.message || {};
  return {
    content: msg.content || '',
    toolCalls: (msg.tool_calls || [])
      .filter((tc) => tc.type === 'function' || tc.function)
      .map((tc, i) => ({
        id: tc.id || `call_${Date.now()}_${i}`,
        name: tc.function.name,
        args: safeParseArgs(tc.function.arguments),
      })),
    stopReason: choice.finish_reason || 'stop',
    usage: data.usage
      ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API adapter
// ---------------------------------------------------------------------------

function toAnthropicPayload(messages) {
  let system = '';
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + (m.content || '');
    } else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls || []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args ?? {} });
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
    } else if (m.role === 'tool') {
      // All tool_result blocks for one assistant turn must land in a single
      // user message — merge consecutive tool results.
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content ?? '' };
      if (m.isError) block.is_error = true;
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    } else {
      out.push({ role: 'user', content: m.content ?? '' });
    }
  }
  return { system, messages: out };
}

async function chatAnthropic(cfg, { model, messages, tools, signal }) {
  const { system, messages: msgs } = toAnthropicPayload(messages);
  const body = {
    model,
    max_tokens: 16000,
    messages: msgs,
  };
  if (system) body.system = system;
  if (tools?.length) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  const resp = await fetch(`${cfg.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      // Required when calling api.anthropic.com from browser contexts.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok) throw await readError(resp);
  const data = await resp.json();

  if (data.stop_reason === 'refusal') {
    const why = data.stop_details?.explanation || 'the model declined this request';
    throw new Error(`Anthropic refused the request: ${why}`);
  }

  let content = '';
  const toolCalls = [];
  for (const block of data.content || []) {
    if (block.type === 'text') content += block.text;
    else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
  }
  return {
    content,
    toolCalls,
    stopReason: data.stop_reason,
    usage: data.usage
      ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send one chat turn. `messages` uses the neutral shape:
 *   {role:'system'|'user', content}
 *   {role:'assistant', content, toolCalls:[{id,name,args}]}
 *   {role:'tool', toolCallId, name, content, isError?}
 * Returns {content, toolCalls, stopReason, usage}.
 */
export async function chat(providerId, settings, req) {
  const cfg = providerConfig(providerId, settings);
  const model = req.model || settings.providers?.[providerId]?.model || cfg.defaultModel;
  if (!model) throw new Error(`${cfg.label}: no model configured.`);
  const args = { ...req, model };
  return cfg.kind === 'anthropic' ? chatAnthropic(cfg, args) : chatOpenAI(cfg, args);
}

/** List model ids for the settings dropdown. */
export async function listModels(providerId, settings) {
  const cfg = providerConfig(providerId, settings);
  if (cfg.kind === 'anthropic') {
    const resp = await fetch(`${cfg.baseUrl}/models?limit=100`, {
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
    if (!resp.ok) throw await readError(resp);
    const data = await resp.json();
    return (data.data || []).map((m) => m.id).sort();
  }
  const headers = {};
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  const resp = await fetch(`${cfg.baseUrl}/models`, { headers });
  if (!resp.ok) throw await readError(resp);
  const data = await resp.json();
  return (data.data || []).map((m) => m.id).sort();
}
