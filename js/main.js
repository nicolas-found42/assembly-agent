// main.js — chat UI for ASM::AGENT.
// One message box, one scrolling transcript of chat rows, and four dialogs
// (Chats / Assistant / Model / Settings). Engine I/O goes through js/bridge.js,
// persistence through js/store.js, catalog data through js/models.js.

import { initEngine, runTurn, checkAccess, stop, shouldUseProxy,
  appendHistory, clearHistory, historyMessages } from './bridge.js';
import { loadCatalog, applyView, visibleModel, catalogSize, newestFreeModelId,
  humanCtx, money, MASKS, SORTS, DEFAULT_DESC } from './models.js';
import { renderMarkdown, highlightCode, renderFinal } from './markdown.js';
import { parseBlocks } from './search.js';
import { announceStatus } from './a11y.js';
import { DEFAULT_PERSONA, APPLICATION_POLICY } from './persona.js';
import { checkProse, correctionPrompt, integrityPreserved } from './ste.js';
import * as S from './store.js';

// ── dom ─────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const dom = {};
for (const [key, sel] of [
  ['shell', '#b-shell'], ['transcript', '#b-transcript'],
  ['composer', '#b-composer'], ['input', '#b-input'], ['send', '#b-send'],
  ['stProgress', '#b-st-progress'], ['stAssistant', '#b-st-assistant'],
  ['stModel', '#b-st-model'], ['stKey', '#b-st-key'],
  ['newBtn', '#b-new'], ['chatsBtn', '#b-chats'], ['assistBtn', '#b-assist'],
  ['modelBtn', '#b-model'], ['settingsBtn', '#b-settings'],
]) dom[key] = $(sel);

// ── helpers ─────────────────────────────────────────────────────────────
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const button = (label, cls, onClick) => {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};
const shortModel = (id) => String(id || '').replace(/^.*\//, '').replace(/:free$/, '');
const SEARCH_NOTE_PREFIX = 'Web search results for "';
const isSearchNote = (text) => typeof text === 'string' && text.startsWith(SEARCH_NOTE_PREFIX);

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return String(url || ''); }
}

function relTime(ts) {
  const min = Math.round((Date.now() - (Number(ts) || 0)) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(ts).toLocaleDateString();
}

function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileSafe = (title) => String(title || 'chat').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat';

// ── state ───────────────────────────────────────────────────────────────
let settings = S.getSettings();
let chat = null;          // active chat record
let busy = false;         // a turn is running
let turn = null;          // state of the running turn
let watched = true;       // transcript sticks to the bottom
let draftTimer = 0;
let paintRaf = 0;
let pendingNotices = [];  // migration notices, shown once after boot

// ── audio ───────────────────────────────────────────────────────────────
let actx = null;
function blip(freq = 620, dur = 0.05, type = 'square', gain = 0.045) {
  if (!settings.crt?.sound) return;
  try {
    actx = actx ?? new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const osc = actx.createOscillator();
    const amp = actx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.connect(amp).connect(actx.destination);
    const t = actx.currentTime;
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  } catch { /* audio is optional */ }
}
const sfxTool = () => { blip(440, 0.07, 'square', 0.04); setTimeout(() => blip(440, 0.07), 120); };
const sfxDone = () => blip(220, 0.14, 'square', 0.04);

// ── CRT toggles (persisted in settings) ─────────────────────────────────
function applyCrt() {
  const c = settings.crt || {};
  dom.shell.classList.toggle('is-scan', !!c.scan);
  dom.shell.classList.toggle('is-curve', !!c.curve);
  dom.shell.classList.toggle('is-flicker', !!c.flicker);
}
function toggleCrt(key) {
  settings = S.saveSettings({ crt: { ...settings.crt, [key]: !settings.crt?.[key] } });
  applyCrt();
  blip(key === 'sound' && settings.crt.sound ? 880 : 560, 0.04, 'square', 0.03);
}

// ── transcript plumbing ─────────────────────────────────────────────────
function atBottom(slack = 90) {
  return dom.transcript.scrollHeight - dom.transcript.scrollTop - dom.transcript.clientHeight < slack;
}
function scrollDown(force = false) {
  if (force || watched) dom.transcript.scrollTop = dom.transcript.scrollHeight;
}
function add(node, { force = false } = {}) {
  watched = force || atBottom();
  dom.transcript.append(node);
  scrollDown();
  return node;
}

function rule(corner, label, meta) {
  const r = el('div', 'b-rule');
  r.dataset.corner = corner;
  if (label != null) r.append(el('span', 'b-lab', label));
  r.append(el('span', 'b-fill'));
  if (meta != null) r.append(el('span', 'b-stat', meta));
  return r;
}

// Inline status row in the transcript: replaced while a turn moves through its
// stages, removed when the stage is superseded.
let progressRow = null;
function showProgressRow(text) {
  if (progressRow && progressRow.isConnected) {
    if (progressRow.textContent !== text) progressRow.textContent = text;
    scrollDown();
    return progressRow;
  }
  progressRow = add(el('div', 'b-progress', text), { force: true });
  return progressRow;
}
function clearProgressRow() {
  progressRow?.remove();
  progressRow = null;
}

// ── status strip ────────────────────────────────────────────────────────
function setProgress(text, announce = '') {
  dom.stProgress.textContent = text;
  if (announce) announceStatus(announce);
}
function updateStrip() {
  dom.stAssistant.textContent = chat?.assistantName || 'ASM::AGENT';
  const id = chat?.model?.id || '';
  dom.stModel.textContent = id ? shortModel(id) : 'no model';
  dom.stModel.title = id || 'No model selected';
  dom.stKey.textContent = S.hasKey() ? 'API key set' : 'No API key';
}

// ── transcript pieces ───────────────────────────────────────────────────
function welcomeBanner() {
  const box = el('div', 'b-turn b-welcome');
  const mark = el('div', 'b-mark');
  mark.append(el('span', 'b-mark-t', 'ASM::AGENT'));
  box.append(mark);
  box.append(el('p', '', 'Ask a question in the box below. The assistant searches the web first. Then it writes an answer. The results it used appear under Sources.'));
  box.append(el('p', 'b-note', 'Replies come from an external AI service. Searches go to external search services. Do not send private data.'));
  return add(box, { force: true });
}

function userRow(text) {
  const row = el('div', 'b-turn b-user');
  row.append(el('div', 'b-user-role', 'You'), el('div', 'b-user-txt', text));
  return row;
}

function sourcesDetails(sources) {
  const det = el('details', 'b-src');
  det.append(el('summary', '', `Sources (${sources.length})`));
  const list = el('ul', 'b-src-list');
  for (const src of sources) {
    const li = el('li', 'b-src-item');
    const a = el('a', 'b-src-t', src.title || src.url);
    a.href = src.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    li.append(a, el('div', 'b-src-u', domainOf(src.url)));
    if (src.snippet) li.append(el('div', 'b-src-s', String(src.snippet).slice(0, 220)));
    list.append(li);
  }
  det.append(list);
  return det;
}

/** One framed answer. Streams markdown into `body`, then finalize() paints the
 *  finished text and the footer (model, wording state, sources, notes). */
function newAnswerCard(modelId = '') {
  const wrap = el('div', 'b-turn b-ans');
  const head = rule('┌', chat?.assistantName || 'ASM::AGENT', 'writing…');
  const headStat = head.querySelector('.b-stat');
  const body = el('div', 'b-md');
  const foot = el('div', 'b-foot');
  const footRule = el('div', 'b-rule');
  footRule.dataset.corner = '└';
  const footMeta = el('span', 'b-stat', '');
  footRule.append(el('span', 'b-fill'), footMeta);
  const srcSlot = el('div', 'b-src-slot');
  foot.append(footRule, srcSlot);
  wrap.append(head, body, foot);
  add(wrap, { force: true });
  return {
    wrap,
    body,
    streaming() {
      body.classList.add('is-streaming');
      renderMarkdown(body, '');
      scrollDown();
    },
    finalize({ text, modelId: used = modelId, wording = '', sources = [], failures = [] }) {
      body.classList.remove('is-streaming');
      headStat.textContent = '';
      renderFinal(body, text);
      footMeta.textContent = [shortModel(used), wording === 'checked' ? 'checked wording' : ''].filter(Boolean).join(' · ');
      if (used) footMeta.title = used;
      srcSlot.textContent = '';
      if (sources.length) srcSlot.append(sourcesDetails(sources));
      else srcSlot.append(el('div', 'b-note', 'Web search was not available for this answer.'));
      if (failures.length) srcSlot.append(el('div', 'b-note', 'Some sources were unreachable.'));
      scrollDown();
    },
    remove() { wrap.remove(); },
  };
}

function noticeRow(text, { dismiss = false, action = null } = {}) {
  const row = el('div', 'b-notice');
  row.append(el('span', 'b-notice-t', text));
  if (action) row.append(button(action.label, 'b-notice-b', () => action.run()));
  if (dismiss) {
    const x = button('Dismiss', 'b-notice-x', () => row.remove());
    x.setAttribute('aria-label', 'Dismiss notice');
    row.append(x);
  }
  return row;
}

function errorRow(message, actions = []) {
  const row = el('div', 'b-turn b-error');
  row.setAttribute('role', 'alert');
  row.append(el('div', 'b-err', message));
  if (actions.length) {
    const bar = el('div', 'b-err-acts');
    for (const [label, fn, cls] of actions) bar.append(button(label, `b-btn${cls ? ` ${cls}` : ''}`, fn));
    row.append(bar);
  }
  return add(row, { force: true });
}

// ── chats: restore, switch, create ──────────────────────────────────────
function saveDraft() {
  if (!chat) return;
  const value = dom.input.value;
  if (value === chat.draft) return;
  const next = S.updateChat(chat.id, { draft: value });
  if (next && next.id === chat.id) chat = next;
}

function onInput() {
  autogrow();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 300);
}

function autogrow() {
  const t = dom.input;
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 180)}px`;
}

function staleAssistant(rec) {
  if (!rec.assistantId) return null;
  const current = S.getAssistant(rec.assistantId);
  if (!current || rec.assistantRev == null) return null;
  return current.rev > rec.assistantRev ? current : null;
}

function renderStoredMessage(msg, rec) {
  if (msg.role === 'user') {
    if (isSearchNote(msg.content)) return; // engine search note from an older chat
    add(userRow(msg.content), { force: true });
    return;
  }
  if (msg.role !== 'assistant' || !msg.content) return;
  const used = msg.modelUsed || rec.model?.id || '';
  const card = newAnswerCard(used);
  card.finalize({ text: msg.content, modelId: used, wording: msg.wording, sources: msg.sources || [] });
}

function replayHistory(rec) {
  if (busy) return; // a running turn owns the engine history
  clearHistory();
  for (const msg of rec.messages) {
    if (msg.role === 'user' && !isSearchNote(msg.content)) appendHistory(1, msg.content);
    else if (msg.role === 'assistant' && msg.content) appendHistory(2, msg.content);
  }
}

function renderChat() {
  cancelPaint();
  clearProgressRow();
  dom.transcript.textContent = '';
  watched = true;
  const rec = chat;
  if (!rec) return;
  for (const text of pendingNotices) add(noticeRow(text, { dismiss: true }), { force: true });
  pendingNotices = [];
  if (rec.assistantId === null) add(el('div', 'b-note', 'This chat kept its original instructions.'), { force: true });
  const newer = staleAssistant(rec);
  if (newer) {
    const row = noticeRow(`This chat uses an older copy of the instructions for ${rec.assistantName || newer.name}.`, {
      action: {
        label: 'Update instructions',
        run: () => {
          const updated = S.updateChat(rec.id, {
            assistantRev: newer.rev, assistantName: newer.name, instructions: newer.instructions,
          });
          if (updated && chat && chat.id === updated.id) chat = updated;
          row.remove();
          announceStatus('The chat now uses the new instructions. Past replies stay the same.');
        },
      },
    });
    add(row, { force: true });
  }
  if (!rec.messages.length) welcomeBanner();
  else for (const msg of rec.messages) renderStoredMessage(msg, rec);
  // A turn may have started here, the user left, and came back: re-attach its draft.
  if (turn && turn.chatId === rec.id && !turn.cardFinal && turn.card && !turn.card.wrap.isConnected) {
    turn.card = newAnswerCard(turn.model);
    if (turn.acc) renderMarkdown(turn.card.body, turn.acc);
  }
  replayHistory(rec);
  dom.input.value = rec.draft || '';
  autogrow();
  updateStrip();
  scrollDown(true);
}

function openChat(id) {
  if (chat && chat.id !== id) saveDraft();
  const rec = S.getChat(id);
  if (!rec) return false;
  S.setActiveChat(id);
  chat = rec;
  renderChat();
  return true;
}

function newChat(assistantId = S.BUILTIN_ID) {
  saveDraft();
  let rec;
  try {
    rec = S.createChat({ assistantId, model: { mode: 'auto', id: newestFreeModelId() } });
  } catch (err) {
    errorRow(String(err?.message || err));
    return null;
  }
  S.setActiveChat(rec.id);
  chat = rec;
  renderChat();
  setProgress('Ready', 'New chat started.');
  return rec;
}

function restoreOrCreate() {
  let rec = S.activeChat();
  if (!rec) {
    rec = S.listChats()[0] || S.createChat({ model: { mode: 'auto', id: newestFreeModelId() } });
    S.setActiveChat(rec.id);
  }
  chat = rec;
  renderChat();
}

// ── the turn ────────────────────────────────────────────────────────────
function setBusy(value) {
  busy = value;
  dom.send.classList.toggle('is-stop', value);
  dom.send.textContent = value ? 'Stop' : 'Send';
  dom.send.setAttribute('aria-label', value ? 'Stop' : 'Send message');
}

function turnSources(t) {
  const out = [];
  const seen = new Set();
  try {
    for (const block of parseBlocks(t.markdown)) {
      const url = String(block.url || '');
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ title: block.title || url, url, snippet: String(block.snippet || '').slice(0, 300) });
    }
  } catch { /* a malformed block list never breaks the answer */ }
  return out;
}

function persistTurn(t) {
  const rec = S.getChat(t.chatId);
  if (!rec) return;
  const messages = rec.messages.slice();
  const patch = { messages };
  if (!t.userPersisted) {
    messages.push({ role: 'user', content: t.text });
    t.userPersisted = true;
    if (messages.length === 1) patch.title = t.text.slice(0, 40);
  } else {
    const msg = {
      role: 'assistant',
      content: t.answerText,
      sources: turnSources(t),
      modelUsed: t.model,
      wording: t.builtin ? (t.wording || 'original') : undefined,
    };
    if (t.assistantIdx >= 0 && messages[t.assistantIdx]) messages[t.assistantIdx] = msg;
    else { t.assistantIdx = messages.length; messages.push(msg); }
  }
  const next = S.updateChat(t.chatId, patch);
  if (next && chat && chat.id === next.id) chat = next;
}

function cancelPaint() {
  if (paintRaf) { cancelAnimationFrame(paintRaf); paintRaf = 0; }
}

function queuePaint(t) {
  if (paintRaf) return;
  paintRaf = requestAnimationFrame(() => {
    paintRaf = 0;
    if (!t.card || !t.card.wrap.isConnected || t.cardFinal) return;
    renderMarkdown(t.card.body, t.acc);
    highlightCode(t.card.body);
    scrollDown();
  });
}

function onTurnEvent(t, ev) {
  // State that must survive a chat switch (the persist points read it).
  if (ev.type === 'research-finished') {
    t.markdown += ev.markdown || '';
    for (const failure of ev.failures || []) if (failure && !t.failures.includes(failure)) t.failures.push(failure);
  } else if (ev.type === 'round-final') {
    t.answerText = ev.text;
    t.settled = true;
  }
  if (!chat || chat.id !== t.chatId) return; // the user switched away
  if (ev.type !== 'delta') cancelPaint();    // a settled stage must not be repainted by a pending frame
  switch (ev.type) {
    case 'research-started':
      sfxTool();
      showProgressRow('Searching the web…');
      setProgress('Searching the web…', 'Searching the web.');
      break;
    case 'tool-started':
      sfxTool();
      showProgressRow(ev.query ? `Searching the web for ${ev.query}` : 'Searching the web…');
      setProgress('Searching the web…', `Searching the web for ${ev.query || 'your question'}.`);
      break;
    case 'round-started':
      if (t.cardFinal) {
        // The wording pass: it stays invisible until the rewrite is accepted.
        t.pass = true;
        showProgressRow('Checking wording…');
        setProgress('Checking wording…', 'Checking wording.');
      } else {
        t.acc = '';
        if (!t.card) t.card = newAnswerCard(t.model);
        t.card.streaming();
        showProgressRow('Writing your answer…');
        setProgress('Writing your answer…', 'Writing your answer.');
      }
      break;
    case 'delta':
      t.acc += ev.text;
      if (!t.pass) queuePaint(t);
      break;
    case 'round-final': {
      clearProgressRow();
      if (t.pass && t.card) {
        t.pass = false;
        t.wording = 'checked';
        t.card.finalize({ text: ev.text, wording: 'checked', sources: turnSources(t), failures: t.failures });
      } else {
        t.cardFinal = true;
        if (!t.card) t.card = newAnswerCard(t.model);
        t.card.finalize({ text: ev.text, sources: turnSources(t), failures: t.failures });
      }
      setProgress('Answer ready');
      break;
    }
    case 'aborted':
      clearProgressRow();
      errorRow('Stopped.');
      setProgress('Stopped');
      break;
    case 'errored': {
      clearProgressRow();
      // Service-side error text can carry old product names; show ours.
      const message = String(ev.message || '').replace(/\bSET\b/g, 'Settings');
      const row = errorRow(message, [
        ['Retry', () => { row.remove(); retryTurn(t.text); }],
        ['Change model', () => openModel({ notice: 'Choose the model for your next reply.' })],
      ]);
      announceStatus('Something went wrong. You can retry or change the model.', 'assertive');
      setProgress('Something went wrong');
      break;
    }
    default:
      break;
  }
}

function finishTurn(t) {
  if (t.finished) return;
  t.finished = true;
  cancelPaint();
  if (turn === t) turn = null;
  setBusy(false);
  if (chat && chat.id === t.chatId) {
    clearProgressRow();
    if (!t.cardFinal) t.card?.remove(); // an unfinished draft is never saved
  } else if (chat) {
    replayHistory(chat); // the finished turn no longer owns the engine history
  }
  setProgress('Ready');
  if (t.settled && chat && chat.id === t.chatId) announceStatus('Response complete.');
  sfxDone();
}

function startTurn(text, { retry = false, model, useProxy }) {
  const rec = chat;
  const builtin = rec.assistantId === S.BUILTIN_ID;
  const system = `${APPLICATION_POLICY}\n\n${builtin ? DEFAULT_PERSONA : (rec.instructions || '')}`;
  const t = {
    chatId: rec.id, text, model, builtin, useProxy,
    userPersisted: retry, assistantIdx: -1,
    answerText: '', wording: '', markdown: '', failures: [],
    card: null, cardFinal: false, pass: false, acc: '', settled: false, finished: false,
  };
  turn = t;
  setBusy(true);
  setProgress('Thinking…', 'Thinking.');
  runTurn(text, {
    system,
    getKey: () => S.getKey(),
    model,
    useProxy,
    retry,
    on: (ev) => onTurnEvent(t, ev),
    persist: () => persistTurn(t),
    ...(builtin ? {
      correct: (finalText) => {
        const check = checkProse(finalText);
        return check.violations.length ? correctionPrompt(check.violations) : '';
      },
      acceptCorrection: (original, rewritten) => integrityPreserved(original, rewritten),
    } : {}),
  }).catch((err) => {
    onTurnEvent(t, { type: 'errored', message: String(err?.message || err) });
  }).finally(() => {
    finishTurn(t);
  });
}

function retryTurn(text) {
  if (!chat) return;
  const model = chat.model?.id || '';
  if (!model) { openModel({ notice: 'Choose a model to continue' }); return; }
  startTurn(text, { retry: true, model, useProxy: shouldUseProxy(S.getKey(), model) });
}

function doSend() {
  if (busy) {
    stop();
    setProgress('Stopping…', 'Stopping.');
    return;
  }
  const text = dom.input.value.trim();
  if (!text || !chat) return;
  const model = chat.model?.id || '';
  if (!model) {
    openModel({ notice: 'Choose a model to continue' });
    return;
  }
  const key = S.getKey();
  const gate = checkAccess(model, key);
  if (!gate.ok) {
    errorRow('This model needs your API key. Add a key in Settings, or choose a free model.', [
      ['Add API key', () => openSettings({ notice: 'Add your OpenRouter API key here.' })],
    ]);
    announceStatus('This model needs your API key.', 'assertive');
    return;
  }
  dom.input.value = '';
  autogrow();
  saveDraft();
  add(userRow(text), { force: true });
  startTurn(text, { retry: false, model, useProxy: shouldUseProxy(key, model) });
}

// ── dialogs (native <dialog>) ───────────────────────────────────────────
function dialog(id, title, cls = '') {
  const found = document.getElementById(id);
  if (found) {
    const handle = found._dlg;
    handle.titleEl.textContent = title;
    handle.body.setAttribute('aria-label', `${title} options`);
    const close = found.querySelector('.b-x');
    if (close) close.setAttribute('aria-label', `Close ${title.toLowerCase()}`);
    return handle;
  }
  const d = el('dialog', `b-dlg${cls ? ` ${cls}` : ''}`);
  d.id = id;
  const inner = el('div', 'b-dlg-in');
  const head = rule('┌', title, '');
  const close = button('✕', 'b-x', () => d.close());
  close.setAttribute('aria-label', `Close ${title.toLowerCase()}`);
  head.append(close);
  const body = el('div', 'b-dlg-body');
  body.tabIndex = 0;
  body.setAttribute('role', 'region');
  body.setAttribute('aria-label', `${title} options`);
  const foot = el('div', 'b-dlg-foot');
  inner.append(head, body, foot);
  d.append(inner);
  d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); });
  // Current stable Chrome breaks the native <dialog> Tab wrap at the boundary —
  // focus escapes to <body> instead of cycling. Wrap manually between the
  // dialog's tab stops (deepest elements only; containers are skipped).
  d.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Tab') return;
    const all = [...d.querySelectorAll('button:not([disabled]), input:not([disabled]), select, textarea, [tabindex="0"]')]
      .filter((x) => x.getClientRects().length > 0);
    const stops = all.filter((x) => !all.some((y) => y !== x && x.contains(y)));
    if (!stops.length) return;
    const active = document.activeElement;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
    else if (ev.shiftKey && active === first) { ev.preventDefault(); last.focus(); }
  });
  d.addEventListener('close', () => {
    if (!document.querySelector('dialog[open]')) dom.input?.focus({ preventScroll: true });
  });
  document.body.append(d);
  const handle = { d, body, foot, titleEl: head.querySelector('.b-lab') };
  d._dlg = handle;
  return handle;
}
const showDialog = (dlg) => { if (!dlg.d.open) dlg.d.showModal(); };

function footNote(dlg, text) {
  dlg.foot.textContent = text || '';
}

// ── Chats dialog ────────────────────────────────────────────────────────
function chatMarkdown(rec) {
  const lines = [`# ${rec.title}`, '', `Assistant: ${rec.assistantName || 'ASM::AGENT'}`, ''];
  for (const msg of rec.messages) {
    if (msg.role === 'user') {
      if (isSearchNote(msg.content)) continue;
      lines.push('## You', '', msg.content, '');
    } else if (msg.role === 'assistant' && msg.content) {
      lines.push('## Assistant', '', msg.content, '');
      for (const src of msg.sources || []) lines.push(`- [${src.title || src.url}](${src.url})`);
      if ((msg.sources || []).length) lines.push('');
    }
  }
  return lines.join('\n');
}
function chatJson(rec) {
  const { draft, ...rest } = rec;
  return JSON.stringify(rest, null, 2);
}

function openChats() {
  const dlg = dialog('b-dlg-chats', 'Chats', 'b-dlg-chats');
  renderChats(dlg);
  showDialog(dlg);
}

function renderChats(dlg) {
  dlg.body.textContent = '';
  dlg.body.append(button('New chat', 'b-btn', () => { dlg.d.close(); newChat(); }));
  const list = el('ul', 'b-list');
  const chats = S.listChats();
  if (!chats.length) list.append(el('li', 'b-l b-dim', 'No chats yet.'));
  for (const rec of chats) {
    const active = !!chat && rec.id === chat.id;
    const li = el('li', 'b-row');
    li.classList.toggle('is-active', active);
    li.append(el('span', 'b-row-mk', active ? '▸' : ' '));
    li.append(el('span', 'b-row-t', rec.title));
    li.append(el('span', 'b-row-m', `${relTime(rec.updated)} · ${rec.assistantName || 'ASM::AGENT'}`));
    const bar = el('div', 'b-row-act');
    bar.append(button('Open', 'b-row-go', () => { dlg.d.close(); openChat(rec.id); }));
    bar.append(button('Rename', '', () => renameChatRow(li, rec)));
    bar.append(button('Export .md', '', () => download(`${fileSafe(rec.title)}.md`, chatMarkdown(rec), 'text/markdown')));
    bar.append(button('Export .json', '', () => download(`${fileSafe(rec.title)}.json`, chatJson(rec), 'application/json')));
    bar.append(button('Delete', 'is-danger', () => deleteChat(rec, dlg)));
    li.append(bar);
    list.append(li);
  }
  dlg.body.append(list);
  footNote(dlg, 'Your chats stay in this browser.');
}

function renameChatRow(li, rec) {
  const titleEl = li.querySelector('.b-row-t');
  if (!titleEl) return;
  const input = el('input', 'b-filter');
  input.value = rec.title;
  input.setAttribute('aria-label', 'Chat title');
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); S.renameChat(rec.id, input.value); refreshAfterRename(rec.id); }
    else if (ev.key === 'Escape') { ev.stopPropagation(); renderChats(li.closest('dialog')._dlg); }
  });
  input.addEventListener('blur', () => {
    if (!input.isConnected) return; // the row was re-rendered already
    S.renameChat(rec.id, input.value);
    refreshAfterRename(rec.id);
  });
}

function refreshAfterRename(id) {
  const rec = S.getChat(id);
  if (rec && chat && chat.id === rec.id) chat = rec;
  const dlg = document.getElementById('b-dlg-chats')?._dlg;
  if (dlg) renderChats(dlg);
}

function deleteChat(rec, dlg) {
  if (!confirm(`Delete the chat "${rec.title}"? This cannot be undone.`)) return;
  const wasActive = !!chat && chat.id === rec.id;
  S.deleteChat(rec.id);
  if (wasActive) {
    const next = S.listChats()[0];
    if (next) openChat(next.id);
    else newChat();
  }
  if (dlg) renderChats(dlg);
}

// ── Assistant dialog + editor ───────────────────────────────────────────
const ASSISTANT_GUIDE = "Describe the assistant's role and voice. These instructions guide every reply. Web search always runs before answers; it cannot be turned off.";

function assistantsDialog() {
  const dlg = dialog('b-dlg-assistants', 'Assistant', 'b-dlg-assistants');
  if (!dlg.list) buildAssistants(dlg);
  return dlg;
}

function buildAssistants(dlg) {
  const list = el('ul', 'b-list');
  list.id = 'b-a-list';
  const importBox = el('div', 'b-sect');
  importBox.append(el('div', 'b-sect-lab', 'Import'));
  const file = el('input', 'b-file');
  file.type = 'file';
  file.accept = 'application/json,.json';
  file.id = 'b-imp-file';
  file.setAttribute('aria-label', 'Choose an assistant file');
  const paste = el('textarea', 'b-custom');
  paste.id = 'b-imp-text';
  paste.rows = 3;
  paste.placeholder = 'Or paste an assistant file here';
  paste.setAttribute('aria-label', 'Paste an assistant file');
  const result = el('div', 'b-res');
  const run = button('Import', 'b-btn', async () => {
    let text = paste.value.trim();
    const chosen = file.files && file.files[0];
    if (!text && chosen) text = await chosen.text();
    if (!text) {
      result.textContent = 'Choose a file or paste an assistant file first.';
      announceStatus('Nothing to import.', 'assertive');
      return;
    }
    try {
      const summary = S.importAssistants(text);
      const parts = [`Imported ${summary.imported}.`, `Skipped ${summary.skipped}.`];
      if (summary.errors.length) parts.push(summary.errors.join(' '));
      result.textContent = parts.join(' ');
      file.value = '';
      paste.value = '';
      renderAssistantList(dlg);
      announceStatus(result.textContent);
    } catch (err) {
      result.textContent = String(err?.message || err);
      announceStatus('The import failed.', 'assertive');
    }
  });
  importBox.append(file, paste, run, result);
  const exportBox = el('div', 'b-sect');
  exportBox.append(el('div', 'b-sect-lab', 'Export'));
  exportBox.append(button('Export all', 'b-btn', () => {
    download('asm-agent-assistants.json', S.exportAssistants(), 'application/json');
  }));
  exportBox.append(button('New assistant', 'b-btn', () => openAssistantEditor(null)));
  dlg.body.append(list, importBox, exportBox);
  dlg.list = list;
}

function openAssistants() {
  const dlg = assistantsDialog();
  renderAssistantList(dlg);
  showDialog(dlg);
}

function renderAssistantList(dlg) {
  if (!dlg.list) return;
  const list = dlg.list;
  list.textContent = '';
  for (const assistant of S.listAssistants()) {
    const li = el('li', 'b-row');
    const active = !!chat && chat.assistantId === assistant.id;
    li.classList.toggle('is-active', active);
    li.append(el('span', 'b-row-mk', active ? '▸' : ' '));
    const title = el('span', 'b-row-t', assistant.name);
    if (assistant.builtin) title.append(el('i', 'b-tag', 'Built-in'));
    li.append(title);
    li.append(el('span', 'b-row-m', String(assistant.instructions || '').slice(0, 140)));
    const bar = el('div', 'b-row-act');
    bar.append(button('New chat', 'b-row-go', () => { dlg.d.close(); newChat(assistant.id); }));
    if (!assistant.builtin) {
      bar.append(button('Edit', '', () => openAssistantEditor(assistant)));
    }
    bar.append(button('Duplicate', '', () => {
      try { S.duplicateAssistant(assistant.id); } catch (err) { announceStatus(String(err?.message || err), 'assertive'); }
      renderAssistantList(dlg);
    }));
    if (!assistant.builtin) {
      bar.append(button('Delete', 'is-danger', () => {
        if (!confirm(`Delete the assistant "${assistant.name}"? Chats that used it keep their instructions.`)) return;
        try { S.deleteAssistant(assistant.id); } catch (err) { announceStatus(String(err?.message || err), 'assertive'); }
        renderAssistantList(dlg);
      }));
    }
    li.append(bar);
    list.append(li);
  }
  footNote(dlg, 'Each chat keeps a copy of the assistant instructions it started with.');
}

function openAssistantEditor(assistant) {
  const dlg = dialog('b-dlg-edit', assistant ? 'Edit assistant' : 'New assistant', 'b-dlg-edit');
  dlg.body.textContent = '';
  const nameLabel = el('label', 'b-lab2', 'Name');
  nameLabel.htmlFor = 'b-edit-name';
  const name = el('input', 'b-filter');
  name.id = 'b-edit-name';
  name.type = 'text';
  name.value = assistant?.name || '';
  const insLabel = el('label', 'b-lab2', 'Instructions');
  insLabel.htmlFor = 'b-edit-ins';
  const instructions = el('textarea', 'b-custom');
  instructions.id = 'b-edit-ins';
  instructions.rows = 6;
  instructions.value = assistant?.instructions || '';
  const guide = el('p', 'b-hint-text', ASSISTANT_GUIDE);
  const error = el('div', 'b-res b-err');
  error.hidden = true;
  const save = button('Save assistant', 'b-btn', () => {
    try {
      S.saveAssistant({ id: assistant ? assistant.id : undefined, name: name.value, instructions: instructions.value });
      dlg.d.close();
      announceStatus('Assistant saved.');
      const listDlg = assistantsDialog();
      if (listDlg.d.open) renderAssistantList(listDlg);
    } catch (err) {
      error.hidden = false;
      error.textContent = String(err?.message || err);
      announceStatus('The assistant was not saved.', 'assertive');
    }
  });
  dlg.body.append(nameLabel, name, insLabel, instructions, guide, error, save);
  footNote(dlg, 'Both fields are required.');
  showDialog(dlg);
  name.focus();
}

// ── Model dialog ────────────────────────────────────────────────────────
const SORT_FOR = { price: 'PRICE', ctx: 'CONTEXT', lat: 'LATENCY', tps: 'THROUGHPUT', new: 'LATEST' };
const picker = { filter: '', metric: 4, desc: 1, mask: 0, notice: '' };

function modelDialog() {
  const dlg = dialog('b-dlg-model', 'Model', 'b-dlg-model');
  if (!dlg.list) buildModelDlg(dlg);
  return dlg;
}

function buildModelDlg(dlg) {
  const note = el('div', 'b-dlg-note');
  note.hidden = true;
  const auto = el('button', 'b-auto', '');
  auto.type = 'button';
  auto.id = 'b-auto';
  auto.addEventListener('click', () => {
    if (!chat) return;
    updateChatModel({ mode: 'auto', id: newestFreeModelId() });
    dlg.d.close();
    announceStatus(`Automatic model set to ${shortModel(chat.model.id) || 'none'}.`);
  });
  const bar = el('div', 'b-dlg-bar');
  const filterLabel = el('label', 'sr-only', 'Filter models');
  filterLabel.htmlFor = 'b-model-filter';
  const filter = el('input', 'b-filter');
  filter.id = 'b-model-filter';
  filter.type = 'text';
  filter.placeholder = 'Filter models';
  filter.autocomplete = 'off';
  filter.spellcheck = false;
  const count = el('span', 'b-dlg-count');
  bar.append(filterLabel, filter, count);
  const chips = el('div', 'b-chips');
  for (const [label, mask] of [['free', MASKS.FREE], ['vision', MASKS.VISION], ['reasoning', MASKS.REASONING], ['tools', MASKS.TOOLS], ['ctx≥128k', MASKS['CTX≥128K']]]) {
    const chip = button(label, 'b-chip', () => {
      picker.mask = picker.mask === mask ? 0 : mask;
      renderModelDlg(dlg);
    });
    chip.dataset.mask = String(mask);
    chips.append(chip);
  }
  chips.append(el('span', 'b-chips-sp'), el('span', 'b-chips-lab', 'sort'));
  for (const name of ['price', 'ctx', 'lat', 'tps', 'new']) {
    const chip = button(name, 'b-chip', () => {
      const metric = SORTS.indexOf(SORT_FOR[name]);
      if (picker.metric === metric) picker.desc = picker.desc ? 0 : 1;
      else { picker.metric = metric; picker.desc = DEFAULT_DESC[metric]; }
      renderModelDlg(dlg);
    });
    chip.dataset.sort = name;
    chips.append(chip);
  }
  const list = el('ul', 'b-list');
  filter.addEventListener('input', () => { picker.filter = filter.value; renderModelDlg(dlg); });
  dlg.body.append(note, auto, bar, chips, list);
  dlg.note = note;
  dlg.auto = auto;
  dlg.filter = filter;
  dlg.count = count;
  dlg.chips = chips;
  dlg.list = list;
}

function filteredModels() {
  const tokens = picker.filter.toLowerCase().split(/\s+/).filter(Boolean);
  const total = applyView(picker.metric, picker.desc, picker.mask, picker.filter);
  const out = [];
  for (let i = 0; i < Math.min(total, 400); i++) {
    const model = visibleModel(i);
    const hay = `${model.id} ${model.name}`.toLowerCase();
    if (tokens.every((t) => hay.includes(t))) out.push(model);
  }
  return out;
}

function capabilityTags(model) {
  const tags = [];
  if (model.flags & 1) tags.push('FREE');
  if (model.flags & 2) tags.push('VISION');
  if (model.flags & 4) tags.push('REASONING');
  if (model.flags & 8) tags.push('TOOLS');
  if (model.textOut) tags.push('TEXT');
  return tags;
}

function renderModelDlg(dlg) {
  dlg.note.hidden = !picker.notice;
  dlg.note.textContent = picker.notice;
  const activeId = chat?.model?.id || '';
  const auto = !!chat && chat?.model?.mode === 'auto';
  dlg.auto.textContent = '';
  dlg.auto.classList.toggle('is-active', auto);
  dlg.auto.append(el('span', 'b-row-t', 'Automatic — newest free'));
  dlg.auto.append(el('span', 'b-row-m', autoIdText()));
  dlg.auto.setAttribute('aria-pressed', String(auto));
  dlg.chips.querySelectorAll('.b-chip').forEach((chip) => {
    if (chip.dataset.sort) {
      const metric = SORTS.indexOf(SORT_FOR[chip.dataset.sort]);
      const on = picker.metric === metric;
      chip.classList.toggle('is-on', on);
      chip.textContent = on ? `${chip.dataset.sort} ${picker.desc ? '↓' : '↑'}` : chip.dataset.sort;
    } else {
      chip.classList.toggle('is-on', picker.mask !== 0 && Number(chip.dataset.mask) === picker.mask);
    }
  });
  const models = filteredModels();
  dlg.list.textContent = '';
  for (const model of models) {
    const locked = !(model.flags & 1) && !S.hasKey();
    const li = el('li', 'b-mrow');
    li.classList.toggle('is-active', model.id === activeId);
    const pick = el('button', 'b-mrow-main', '');
    pick.type = 'button';
    pick.setAttribute('aria-pressed', String(model.id === activeId));
    const title = el('span', 'b-row-t', model.name);
    title.append(el('span', 'b-row-id', model.id));
    pick.append(el('span', 'b-row-mk', model.id === activeId ? '▸' : ' '), title);
    pick.append(el('span', 'b-row-m', `ctx ${humanCtx(model.ctx)} · ${(model.flags & 1) ? 'FREE' : `${money(model.pp)} in · ${money(model.pc)} out`}`));
    const tags = el('span', 'b-row-tags');
    for (const tag of capabilityTags(model)) tags.append(el('i', '', tag));
    if (model.id === activeId) tags.append(el('i', 'b-row-on', 'ACTIVE'));
    pick.append(tags);
    pick.addEventListener('click', () => {
      if (locked) { openSettings({ notice: 'Add your OpenRouter API key to use this model.' }); return; }
      updateChatModel({ mode: 'manual', id: model.id });
      dlg.d.close();
      announceStatus(`Model set to ${model.name}.`);
      blip(920, 0.06, 'sine');
    });
    li.append(pick);
    if (locked) {
      const lock = el('div', 'b-lock');
      lock.append(el('span', '', 'Your API key required'));
      lock.append(button('Add key', 'b-chip', () => openSettings({ notice: 'Add your OpenRouter API key to use paid models.' })));
      li.append(lock);
    }
    const adv = el('details', 'b-adv');
    adv.append(el('summary', '', 'Advanced'));
    adv.append(el('div', 'b-adv-grid',
      `Context: ${humanCtx(model.ctx)} · Price in: ${money(model.pp)} · Price out: ${money(model.pc)} · Latency rank: ${model.lat} · Throughput rank: ${model.tps} · Capabilities: ${capabilityTags(model).join(', ') || '—'}`));
    li.append(adv);
    dlg.list.append(li);
  }
  if (!models.length) dlg.list.append(el('li', 'b-l b-dim', 'No model matches that filter.'));
  dlg.count.textContent = `${models.length}/${catalogSize()} models`;
  footNote(dlg, 'The model choice applies to this chat.');
}

function autoIdText() {
  const id = newestFreeModelId();
  return id ? `uses ${id}` : 'no free model found in the list';
}

function updateChatModel(model) {
  if (!chat) return;
  const next = S.updateChat(chat.id, { model });
  if (next) chat = next;
  updateStrip();
}

function openModel(options = {}) {
  const dlg = modelDialog();
  picker.notice = options.notice || '';
  dlg.filter.value = picker.filter;
  renderModelDlg(dlg);
  showDialog(dlg);
  dlg.filter.focus();
}

// ── Settings dialog ─────────────────────────────────────────────────────
function settingsDialog() {
  const dlg = dialog('b-dlg-settings', 'Settings', 'b-dlg-settings');
  if (!dlg.keyInput) buildSettings(dlg);
  return dlg;
}

function buildSettings(dlg) {
  const note = el('div', 'b-dlg-note');
  note.hidden = true;
  const appearance = el('div', 'b-sect');
  appearance.append(el('div', 'b-sect-lab', 'Appearance'));
  for (const [key, label] of [['scan', 'Scanlines'], ['curve', 'Curvature'], ['flicker', 'Flicker'], ['sound', 'Sound']]) {
    const wrap = el('label', 'b-toggle');
    const box = el('input');
    box.type = 'checkbox';
    box.id = `b-set-${key}`;
    box.addEventListener('change', () => toggleCrt(key));
    wrap.append(box, document.createTextNode(label));
    appearance.append(wrap);
  }
  const keyBox = el('div', 'b-sect');
  keyBox.append(el('div', 'b-sect-lab', 'API key'));
  const keyLabel = el('label', 'b-lab2', 'OpenRouter API key');
  keyLabel.htmlFor = 'b-set-key';
  const bar = el('div', 'b-dlg-bar');
  const input = el('input', 'b-filter');
  input.id = 'b-set-key';
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'sk-or-…';
  const badge = el('span', 'b-test-badge');
  const show = button('Show', 'b-chip', () => {
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    show.textContent = hidden ? 'Hide' : 'Show';
  });
  const test = button('Test', 'b-chip', async () => {
    const value = input.value.trim();
    if (!value) { badge.textContent = 'Enter a key first.'; badge.className = 'b-test-badge'; return; }
    badge.textContent = 'Testing…';
    badge.className = 'b-test-badge';
    let ok = false;
    try {
      const res = await fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${value}` } });
      ok = res.ok;
    } catch { ok = false; }
    badge.textContent = ok ? 'Valid' : 'Invalid';
    badge.className = `b-test-badge ${ok ? 'ok' : 'bad'}`;
    announceStatus(ok ? 'The key is valid.' : 'The key is not valid.', ok ? 'polite' : 'assertive');
  });
  bar.append(input, show, test, badge);
  const remember = el('label', 'b-toggle');
  const rememberBox = el('input');
  rememberBox.type = 'checkbox';
  rememberBox.id = 'b-set-remember';
  remember.append(rememberBox, document.createTextNode('Remember on this device'));
  const hint = el('p', 'b-hint-text', 'A session key clears when the browser tab closes. A remembered key is saved in this browser.');
  const actions = el('div', 'b-dlg-actions');
  const save = button('Save key', 'b-btn', () => {
    const value = input.value.trim();
    if (!value) { badge.textContent = 'Enter a key first.'; return; }
    if (rememberBox.checked) S.setRememberedKey(value);
    else {
      S.setSessionKey(value);
      S.clearKeys({ session: false, remembered: true });
    }
    settings = S.getSettings();
    badge.textContent = rememberBox.checked ? 'Saved for this browser.' : 'Saved for this session.';
    badge.className = 'b-test-badge ok';
    updateStrip();
    announceStatus('API key saved.');
  });
  const removeKey = button('Remove key', 'b-btn is-danger', () => {
    S.clearKeys({ session: true, remembered: true });
    settings = S.getSettings();
    input.value = '';
    rememberBox.checked = false;
    badge.textContent = '';
    badge.className = 'b-test-badge';
    updateStrip();
    announceStatus('API key removed.');
  });
  actions.append(save, removeKey);
  keyBox.append(keyLabel, bar, remember, hint, actions);
  const data = el('div', 'b-sect');
  data.append(el('div', 'b-sect-lab', 'Data'));
  data.append(el('p', 'b-hint-text', 'Chats, assistants, and settings stay in this browser.'));
  data.append(button('Clear all data', 'b-btn is-danger', clearAllData));
  dlg.body.append(note, appearance, keyBox, data);
  dlg.note = note;
  dlg.keyInput = input;
  dlg.badge = badge;
  dlg.remember = rememberBox;
  dlg.toggles = { scan: dlg.body.querySelector('#b-set-scan'), curve: dlg.body.querySelector('#b-set-curve'), flicker: dlg.body.querySelector('#b-set-flicker'), sound: dlg.body.querySelector('#b-set-sound') };
}

function openSettings(options = {}) {
  const dlg = settingsDialog();
  settings = S.getSettings();
  dlg.note.hidden = !options.notice;
  dlg.note.textContent = options.notice || '';
  dlg.keyInput.value = S.getKey();
  dlg.badge.textContent = '';
  dlg.badge.className = 'b-test-badge';
  dlg.remember.checked = settings.rememberKey;
  for (const [key, box] of Object.entries(dlg.toggles)) box.checked = !!settings.crt?.[key];
  showDialog(dlg);
}

function clearAllData() {
  if (!confirm('Delete every chat and assistant from this browser, and remove the saved API key?')) return;
  for (const rec of S.listChats()) S.deleteChat(rec.id);
  for (const assistant of S.listAssistants()) {
    if (assistant.builtin) continue;
    try { S.deleteAssistant(assistant.id); } catch { /* builtin records are refused */ }
  }
  S.clearKeys({ session: true, remembered: true });
  S.setActiveChat(null);
  S.saveSettings({ crt: { scan: true, curve: true, flicker: false, sound: false } });
  location.reload();
}

// ── wiring ──────────────────────────────────────────────────────────────
function wire() {
  dom.input.addEventListener('input', onInput);
  dom.input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      doSend();
    }
  });
  dom.composer.addEventListener('submit', (ev) => { ev.preventDefault(); doSend(); });
  dom.send.addEventListener('click', () => doSend());
  dom.newBtn.addEventListener('click', () => newChat());
  dom.chatsBtn.addEventListener('click', openChats);
  dom.assistBtn.addEventListener('click', openAssistants);
  dom.modelBtn.addEventListener('click', () => openModel());
  dom.settingsBtn.addEventListener('click', () => openSettings());
  document.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!dom.shell.contains(target) || target.closest('a, button, summary, input, textarea, select, dialog')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    dom.input.focus({ preventScroll: true });
  });
  const setViewport = () => {
    const vv = window.visualViewport;
    if (vv) {
      // Track the visual viewport only while the on-screen keyboard takes a big
      // bite out of it — otherwise pinch-zoom would shrink the shell.
      if (window.innerHeight - vv.height > 100) dom.shell.style.setProperty('--b-vh', `${Math.round(vv.height)}px`);
      else dom.shell.style.removeProperty('--b-vh');
    }
  };
  setViewport();
  window.visualViewport?.addEventListener('resize', setViewport);
  window.addEventListener('resize', setViewport);
  if (window.matchMedia('(pointer: fine)').matches) dom.input.focus({ preventScroll: true });
}

// ── boot ────────────────────────────────────────────────────────────────
function engineFailed(err) {
  errorRow(`The assistant did not start. ${String(err?.message || err).slice(0, 200)}`, [
    ['Reload the page', () => location.reload(), 'is-danger'],
  ]);
  setProgress('Not available', 'The assistant did not start.');
}

function catalogFailed() {
  const row = el('div', 'b-turn b-error');
  row.setAttribute('role', 'alert');
  row.append(el('div', 'b-err', 'The model list did not load. Check your connection, then try again.'));
  const retry = button('Try again', 'b-btn', async () => {
    retry.disabled = true;
    retry.textContent = 'Loading…';
    try {
      await loadCatalog();
      row.remove();
      restoreOrCreate();
      setProgress('Ready', 'The model list loaded.');
    } catch {
      retry.disabled = false;
      retry.textContent = 'Try again';
      announceStatus('The model list still did not load.', 'assertive');
    }
  });
  const acts = el('div', 'b-err-acts');
  acts.append(retry);
  row.append(acts);
  add(row, { force: true });
  setProgress('No model list', 'The model list did not load.');
}

async function boot() {
  try {
    await initEngine();
  } catch (err) {
    engineFailed(err);
    return;
  }
  S.setBuiltinInstructions(DEFAULT_PERSONA);
  try {
    const migration = S.migrateIfNeeded();
    pendingNotices = Array.isArray(migration?.notices) ? migration.notices.slice() : [];
  } catch { pendingNotices = []; }
  try {
    await loadCatalog();
  } catch {
    catalogFailed();
    return;
  }
  restoreOrCreate();
  setProgress('Ready', 'Ready.');
}

// ── start ───────────────────────────────────────────────────────────────
applyCrt();
wire();
setBusy(false);
setProgress('Starting…');
boot();

window.__asm = window.__asm || {};
window.__asm.history = historyMessages;
