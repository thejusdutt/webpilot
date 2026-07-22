// content.js — page-side agent hands: snapshots interactive elements and
// executes actions requested by the background service worker.
// Injected on demand; the guard makes re-injection a no-op.
(() => {
  if (window.__webpilotInjected) return;
  window.__webpilotInjected = true;

  /** index -> Element for the most recent snapshot */
  let elementRegistry = [];

  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
    '[role="combobox"]', '[role="listbox"]', '[role="option"]', '[role="tab"]',
    '[role="menuitem"]', '[role="switch"]', '[role="textbox"]',
    '[contenteditable="true"]', '[contenteditable=""]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function isVisiblePlain(el) {
    if (el.closest('[hidden],[aria-hidden="true"]')) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    return true;
  }

  function isVisible(el) {
    // Custom-styled radios/checkboxes hide the native input (opacity:0, 0×0, or
    // clipped) and render a styled label/proxy that's what the user actually sees.
    // Keep such an input if its label is visible, so it still appears in snapshots.
    if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) {
      if (isVisiblePlain(el)) return true;
      if (el.closest('[hidden],[aria-hidden="true"]')) return false;
      // Any hiding technique (display:none, visibility, opacity:0, 1×1 clip) is
      // fine as long as the styled label the user sees is visible.
      const lbl = labelEl(el);
      return !!(lbl && isVisiblePlain(lbl));
    }
    return isVisiblePlain(el);
  }

  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  }

  function clean(text, max = 90) {
    return (text || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function labelEl(el) {
    // Explicit <label for=...>
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return lbl;
    }
    // Wrapping label
    return el.closest('label');
  }

  function labelFor(el) {
    const lbl = labelEl(el);
    if (lbl) return clean(lbl.innerText);
    return (
      clean(el.getAttribute('aria-label')) ||
      clean(el.getAttribute('placeholder')) ||
      clean(el.getAttribute('title')) ||
      clean(el.innerText) ||
      clean(el.getAttribute('name')) ||
      ''
    );
  }

  function describe(el, index) {
    const tag = el.tagName.toLowerCase();
    const parts = [`[${index}] <${tag}`];
    const type = el.getAttribute('type');
    if (type) parts.push(`type=${type}`);
    const role = el.getAttribute('role');
    if (role) parts.push(`role=${role}`);
    parts.push('>');

    const label = labelFor(el);
    if (label) parts.push(`"${label}"`);

    if (tag === 'a') {
      const href = el.getAttribute('href') || '';
      if (href && !href.startsWith('javascript:')) parts.push(`href=${clean(href, 80)}`);
    }
    if (tag === 'select') {
      const opts = [...el.options].slice(0, 20).map((o) => clean(o.textContent, 40));
      parts.push(`options=[${opts.join(' | ')}]${el.options.length > 20 ? ` (+${el.options.length - 20} more)` : ''}`);
      if (el.selectedIndex >= 0) parts.push(`selected="${clean(el.options[el.selectedIndex]?.textContent, 40)}"`);
    }
    if (tag === 'input' || tag === 'textarea') {
      if (type === 'checkbox' || type === 'radio') {
        parts.push(el.checked ? 'checked' : 'unchecked');
      } else if (type === 'file') {
        parts.push(el.files?.length ? `file="${el.files[0].name}"` : 'no file selected');
      } else if (type === 'password') {
        if (el.value) parts.push('value="••• (hidden)"'); // never expose passwords to the model
      } else if (el.value) {
        parts.push(`value="${clean(el.value, 60)}"`);
      }
    }
    if (tag !== 'input' && (role === 'checkbox' || role === 'radio' || role === 'switch')) {
      const ac = el.getAttribute('aria-checked');
      parts.push(ac === 'true' ? 'checked' : ac === 'mixed' ? 'mixed' : 'unchecked');
    }
    if (el.isContentEditable && el.innerText) parts.push(`text="${clean(el.innerText, 60)}"`);
    if (el.required || el.getAttribute('aria-required') === 'true') parts.push('required');
    if (el.disabled) parts.push('disabled');
    if (!inViewport(el)) parts.push('(off-screen)');
    return parts.join(' ');
  }

  function snapshot() {
    elementRegistry = [];
    const seen = new Set();
    const lines = [];
    for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (seen.has(el) || !isVisible(el)) continue;
      // Skip wrappers whose interactive child will be listed anyway — but only
      // if that child is actually visible; custom widgets (e.g. role=checkbox
      // wrapping a hidden native input) must keep the wrapper.
      if (el.matches('[onclick],[tabindex]')
        && [...el.querySelectorAll(INTERACTIVE_SELECTOR)].some(isVisible)) continue;
      seen.add(el);
      const index = elementRegistry.length;
      elementRegistry.push(el);
      lines.push(describe(el, index));
      if (elementRegistry.length >= 250) {
        lines.push(`… truncated: more interactive elements exist. Scroll or use read_page.`);
        break;
      }
    }
    const scrollY = Math.round(scrollY0());
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    return {
      url: location.href,
      title: document.title,
      scroll: maxScroll > 0 ? `${Math.min(100, Math.round((scrollY / maxScroll) * 100))}% of page` : 'page fits viewport',
      elements: lines.join('\n'),
      elementCount: elementRegistry.length,
    };
  }

  function scrollY0() { return window.scrollY || document.documentElement.scrollTop || 0; }

  function getElement(index) {
    const el = elementRegistry[index];
    if (!el) throw new Error(`No element with index ${index} in the current snapshot. Take note of the fresh page state and retry.`);
    if (!el.isConnected) throw new Error(`Element [${index}] is no longer attached to the page (it re-rendered). Use the fresh page state.`);
    return el;
  }

  function flash(el) {
    try {
      const prev = el.style.outline;
      el.style.outline = '3px solid #7c5cff';
      setTimeout(() => { el.style.outline = prev; }, 600);
    } catch { /* cosmetic only */ }
  }

  // Set value the framework-friendly way (React/Vue listen for real input events
  // and ignore direct .value writes).
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
      }));
    }
    const form = el.form || el.closest('form');
    if (form && typeof form.requestSubmit === 'function') {
      // Only submit if nothing intercepted Enter (heuristic: form still present).
      try { form.requestSubmit(); } catch { /* some forms reject programmatic submit */ }
    }
  }

  const SUBMIT_RE = /\b(submit|apply|send( application)?|finish|complete|confirm|place order|pay|purchase|book)\b/i;

  const actions = {
    snapshot() {
      return snapshot();
    },

    click({ index, confirmed }, opts) {
      const el = getElement(index);
      const label = labelFor(el) || clean(el.innerText, 60);
      if (opts.confirmSubmit && !confirmed && SUBMIT_RE.test(label)) {
        return { needsConfirmation: true, label };
      }
      el.scrollIntoView({ block: 'center' });
      flash(el);
      el.focus?.();
      // Real-ish event sequence, some handlers need pointer/mouse events.
      const rect = el.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        el.dispatchEvent(new MouseEvent(t, init));
      }
      el.click();
      return { ok: true, message: `Clicked [${index}] "${label}"` };
    },

    type_text({ index, text, press_enter }) {
      const el = getElement(index);
      el.scrollIntoView({ block: 'center' });
      flash(el);
      el.focus?.();
      if (el.isContentEditable) {
        el.innerText = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        setNativeValue(el, text);
      } else {
        throw new Error(`Element [${index}] is not a text input.`);
      }
      if (press_enter) pressEnter(el);
      return { ok: true, message: `Typed into [${index}]: "${clean(text, 80)}"${press_enter ? ' and pressed Enter' : ''}` };
    },

    select_option({ index, value }) {
      const el = getElement(index);
      if (!(el instanceof HTMLSelectElement)) throw new Error(`Element [${index}] is not a <select>.`);
      el.scrollIntoView({ block: 'center' });
      flash(el);
      const target = String(value).trim().toLowerCase();
      const opt = [...el.options].find((o) =>
        o.value.toLowerCase() === target || clean(o.textContent).toLowerCase() === target,
      ) || [...el.options].find((o) => clean(o.textContent).toLowerCase().includes(target));
      if (!opt) {
        const avail = [...el.options].slice(0, 20).map((o) => clean(o.textContent, 40)).join(' | ');
        throw new Error(`No option matching "${value}". Available: ${avail}`);
      }
      el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, message: `Selected "${clean(opt.textContent, 60)}" in [${index}]` };
    },

    set_checkbox({ index, checked }) {
      const el = getElement(index);
      el.scrollIntoView({ block: 'center' });
      flash(el);
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        if (el.checked !== checked) el.click();
        if (el.checked !== checked) { el.checked = checked; el.dispatchEvent(new Event('change', { bubbles: true })); }
      } else {
        // role=checkbox / radio / switch widgets: only click when the current
        // aria-checked state differs from the target, otherwise we'd toggle it off.
        const current = el.getAttribute('aria-checked') === 'true';
        if (current !== checked) el.click();
      }
      return { ok: true, message: `Set [${index}] to ${checked ? 'checked' : 'unchecked'}` };
    },

    scroll({ direction }) {
      const amount = Math.round(innerHeight * 0.8);
      if (direction === 'top') scrollTo({ top: 0, behavior: 'instant' });
      else if (direction === 'bottom') scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      else if (direction === 'up') scrollBy({ top: -amount, behavior: 'instant' });
      else scrollBy({ top: amount, behavior: 'instant' });
      return { ok: true, message: `Scrolled ${direction}` };
    },

    read_page({ max_chars = 6000 }) {
      const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
      const out = text.slice(0, max_chars);
      return { ok: true, message: out + (text.length > max_chars ? `\n… (${text.length - max_chars} more chars — call read_page again after scrolling if needed)` : '') };
    },

    upload_file({ index, fileName, mimeType, base64 }) {
      const el = getElement(index);
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
        throw new Error(`Element [${index}] is not a file input.`);
      }
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const file = new File([bytes], fileName, { type: mimeType });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      flash(el);
      return { ok: true, message: `Attached "${fileName}" to [${index}]` };
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.__webpilot !== true) return;
    if (msg.action === 'ping') { sendResponse({ pong: true }); return; }
    try {
      const result = actions[msg.action]
        ? actions[msg.action](msg.params || {}, msg.options || {})
        : (() => { throw new Error(`Unknown action: ${msg.action}`); })();
      sendResponse({ ok: true, result });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
    // All handlers are synchronous; no `return true` needed.
  });
})();
