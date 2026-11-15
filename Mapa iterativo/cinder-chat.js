/*
 * Monitor Cinder assistant panel (original code).
 * Sends a question to POST {apiBase}/api/assistant and shows the answer with its verification seal.
 * - The municipality comes from the UI controller (FireUI.selected) and the language from FireI18n.lang().
 * - Every label is created with a data-i18n key, so the existing language button (FireI18n.apply)
 *   re-translates the whole panel, including messages already on screen. API answers keep their language.
 * - DOM updates use createElement + textContent only; nothing from the network is ever parsed as HTML.
 */
(function (global) {
  'use strict';

  const CFG = global.CINDER_CONFIG;
  const I = global.FireI18n;
  const t = I.t;
  const $ = (id) => document.getElementById(id);

  const TIMEOUT_MS = 30000;
  const MAX_QUESTION = 500; // same as maxlength on the input
  const MAX_ANSWER = 8000;
  const MAX_NOTICES = 6;
  const MAX_NOTICE = 600;
  const MAX_NAME = 80;
  const MAX_MESSAGES = 60;
  const IBGE_CODE = /^\d{7}$/;

  let busy = false;

  /* ---------- small DOM helpers ---------- */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  /** Leaf element whose text comes from the dictionary; FireI18n.apply() re-translates it on language change. */
  function label(tag, cls, key) {
    const e = el(tag, cls, t(key));
    e.dataset.i18n = key;
    return e;
  }

  /* ---------- context taken from the rest of the page ---------- */
  /** IBGE code of the municipality selected on the map (cinder-ui.js owns it), or null. */
  function selectedIbge() {
    const ui = global.FireUI;
    const id = ui && typeof ui.selected === 'function' ? ui.selected() : null;
    return typeof id === 'string' && IBGE_CODE.test(id) && id.startsWith(CFG.uf) ? id : null;
  }
  /** True when the page fell back to DEMO because the API did not answer /api/meta. */
  function isDemo() {
    const ui = global.FireUI;
    return !!ui && typeof ui.sourceKind === 'function' && ui.sourceKind() === 'demo';
  }

  /* ---------- API call & response validation ---------- */
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);

  /** Keeps only what the panel shows; anything malformed makes the whole answer invalid (null). */
  function validateAnswer(j) {
    if (!j || typeof j !== 'object') return null;
    const answer = text(j.answer, MAX_ANSWER);
    if (!answer) return null;
    const m = j.municipality;
    return {
      answer,
      verified: j.verified === true,
      mode: j.mode === 'llm' || j.mode === 'template' ? j.mode : null,
      cached: j.cached === true,
      municipality: m && typeof m === 'object' ? text(m.name, MAX_NAME) : null,
      notices: Array.isArray(j.notices) ? j.notices.map((n) => text(n, MAX_NOTICE)).filter(Boolean).slice(0, MAX_NOTICES) : [],
    };
  }

  /** Resolves to { answer } or { error: i18n key }. Never throws. */
  async function ask(question, lang) {
    const body = { question, lang };
    const ibge = selectedIbge();
    if (ibge) body.ibge = ibge;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      let res;
      try {
        res = await fetch(`${CFG.apiBase}/api/assistant`, {
          method: 'POST',
          signal: ctrl.signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, application/problem+json' },
          body: JSON.stringify(body),
        });
      } catch (e) {
        // Timeout: the API may be up but slow. Any other failure here means the request never got an answer.
        return { error: e && e.name === 'AbortError' ? 'chat.err.generic' : 'chat.err.noApi' };
      }
      if (res.status === 429) return { error: 'chat.err.rate' };
      if (!res.ok) { console.warn('assistant: HTTP', res.status); return { error: 'chat.err.generic' }; }
      let data = null;
      try { data = await res.json(); } catch (_) { /* not JSON, or aborted while reading the body */ }
      const answer = validateAnswer(data);
      return answer ? { answer } : { error: 'chat.err.generic' };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- messages ---------- */
  function push(node) {
    const log = $('chat-log');
    log.append(node);
    while (log.children.length > MAX_MESSAGES) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }
  function message(kind, whoKey) {
    const li = el('li', `chat__msg chat__msg--${kind}`);
    li.append(label('span', 'chat__who', whoKey));
    return li;
  }
  function userMessage(question) {
    const li = message('user', 'chat.you');
    li.append(el('p', 'chat__text', question));
    return li;
  }
  function pendingMessage() {
    const li = message('bot', 'chat.bot');
    li.append(label('p', 'chat__text chat__thinking', 'chat.thinking'));
    return li;
  }
  function errorMessage(key) {
    const li = message('error', 'chat.bot');
    li.append(label('p', 'chat__text', key));
    return li;
  }
  function answerMessage(a) {
    const li = message('bot', 'chat.bot');
    li.append(el('p', 'chat__text', a.answer)); // pre-wrap in CSS keeps the line breaks
    for (const n of a.notices) li.append(el('p', 'chat__notice', n));
    const meta = el('p', 'chat__meta');
    meta.append(label('span', `chat__seal ${a.verified ? 'chat__seal--ok' : 'chat__seal--no'}`, a.verified ? 'chat.verified' : 'chat.unverified'));
    if (a.mode) meta.append(label('span', '', `chat.mode.${a.mode}`));
    if (a.cached) meta.append(label('span', '', 'chat.cached'));
    if (a.municipality) meta.append(el('span', '', a.municipality));
    li.append(meta);
    return li;
  }

  /* ---------- sending ---------- */
  function setBusy(on) {
    busy = on;
    $('chat-send').disabled = on;
    for (const chip of $('chat-chips').querySelectorAll('button')) chip.disabled = on;
    $('chat-log').setAttribute('aria-busy', on ? 'true' : 'false');
  }

  async function send(raw) {
    const question = String(raw || '').trim().slice(0, MAX_QUESTION);
    if (!question || busy) return;
    const input = $('chat-input');
    input.value = '';
    push(userMessage(question));
    if (isDemo()) { push(errorMessage('chat.err.noApi')); return; }

    setBusy(true);
    const pending = pendingMessage();
    push(pending);
    let result;
    try { result = await ask(question, I.lang()); } catch (e) { console.error(e); result = { error: 'chat.err.generic' }; }
    const node = result.answer ? answerMessage(result.answer) : errorMessage(result.error);
    if (pending.parentNode) pending.replaceWith(node); else push(node);
    const log = $('chat-log');
    log.scrollTop = log.scrollHeight;
    setBusy(false);
    if (!$('chat-panel').hidden) input.focus();
  }

  /* ---------- open / close ---------- */
  function setOpen(open) {
    const panel = $('chat-panel'), btn = $('chat-toggle');
    const hadFocus = panel.contains(document.activeElement);
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.classList.toggle('is-active', open);
    if (open) $('chat-input').focus();
    else if (hadFocus) btn.focus();
  }

  function init() {
    const panel = $('chat-panel'), btn = $('chat-toggle'), input = $('chat-input');
    if (!panel || !btn || !input) return;

    btn.addEventListener('click', () => setOpen(panel.hidden));
    $('chat-close').addEventListener('click', () => setOpen(false));
    $('chat-send').addEventListener('click', () => send(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send(input.value); }
    });
    $('chat-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chat__chip');
      if (chip && !chip.disabled) send(chip.textContent);
    });
    // Esc closes the panel when the focus is in it (or nowhere); the search box and the map keep their own Esc.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || panel.hidden) return;
      const target = e.target;
      if (target === btn || target === document.body || panel.contains(target)) setOpen(false);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
