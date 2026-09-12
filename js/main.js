// main.js — "Command Line" UI (variant B adoption).
// The whole app is one terminal session: a full-bleed scrolling transcript, one slim
// tmux-style status line, a shell prompt with `:` command mode + tab completion, and
// native <dialog> overlays for model/preset/session/key/keymap. All engine I/O still
// flows through js/bridge.js (WAT engine), js/search.js (fan-out), js/sessions.js
// (localStorage), js/models.js (catalog), js/markdown.js (render).

import { initEngine, eng, memBuf, runTurn, checkAccess, stop, streaming,
  appendHistory, clearHistory, historyMessages, renderDrain, resetRender } from './bridge.js';
import { loadCatalog, applyView, visibleModel, getActiveModel, setActiveModel,
  humanCtx, money, MASKS, SORTS, DEFAULT_DESC, isAnonUser, catalogSize } from './models.js';
import { renderMarkdown, highlightCode, addCopyButtons, renderFinal } from './markdown.js';
import { parseBlocks } from './search.js';
import * as S from './sessions.js';
import { announceStatus } from './a11y.js';

// chip label → SORTS entry ('ctx'/'lat'/'tps'/'new' are not SORTS names themselves)
const SORT_KEY = { price: 'PRICE', ctx: 'CONTEXT', lat: 'LATENCY', tps: 'THROUGHPUT', new: 'LATEST' };

// ── dom ─────────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const dom = {};
for (const [k, sel] of [
  ['shell', '#b-shell'], ['transcript', '#b-transcript'], ['sug', '#b-sug'],
  ['prompt', '#b-prompt'], ['ps1', '#b-ps1'], ['mirror', '#b-mirror'], ['ph', '#b-ph'],
  ['input', '#b-input'], ['send', '#b-send'], ['status', '#b-status'],
  ['stSession', '#b-st-session'], ['stModel', '#b-st-model'], ['stPreset', '#b-st-preset'],
  ['stMem', '#b-st-mem'], ['stMsg', '#b-st-msg'], ['stTps', '#b-st-tps'], ['stState', '#b-st-state'],
]) dom[k] = $(sel);

// ── helpers ─────────────────────────────────────────────────────────────
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const shortModel = (id) => String(id || '').replace(/^.*\//, '').replace(/:free$/, '');

// ── state ───────────────────────────────────────────────────────────────
let settings = S.loadSettings();

const state = {
  runState: 'BOOT',
  busy: false,
  history: [],
  histIdx: -1,
  draft: '',
  sugItems: [],
  sugIdx: -1,
  watched: false,
  narrow: false,
  stats: { mem: '0KB', msg: 0, tps: 0 },
};
const BUSY_STATES = new Set(['THINK', 'SEARCH', 'STREAM']);

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
function toggleCrt(k) {
  settings.crt = settings.crt || {};
  settings.crt[k] = !settings.crt[k];
  S.saveSettings(settings);
  applyCrt();
}

// ── transcript plumbing ─────────────────────────────────────────────────
function atBottom(slack = 90) {
  return dom.transcript.scrollHeight - dom.transcript.scrollTop - dom.transcript.clientHeight < slack;
}
function scrollDown(force = false) {
  if (force || state.watched) dom.transcript.scrollTop = dom.transcript.scrollHeight;
}
function add(node, { force = false } = {}) {
  state.watched = force || atBottom();
  dom.transcript.append(node);
  scrollDown();
  return node;
}

function errorLine(text) {
  const row = el('div', 'b-l b-err');
  row.textContent = text;
  row.setAttribute('role', 'alert');
  add(row, { force: true });
  return row;
}

function prompt2() {
  return el('span', 'b-ps1', 'guest@asm:~$');
}

/** Echo a line as if the shell had printed the prompt back (user turn or command). */
function echo(text, cls = '') {
  const row = el('div', `b-echo${cls ? ` ${cls}` : ''}`);
  row.append(prompt2(), el('span', 'b-echo-txt', text));
  add(row, { force: true });
  return row;
}

/** Frame rule line: ┌ LABEL ─────────── meta   (all glyphs, no CSS borders). */
function rule(corner, label, meta, op) {
  const r = el('div', 'b-rule');
  r.dataset.corner = corner;
  r.append(el('span', 'b-lab', label));
  if (op) r.append(op);
  r.append(el('span', 'b-fill'));
  if (meta) r.append(el('span', 'b-stat', meta));
  return r;
}

/** A framed block: ┌ ·───┬ │ body ├ │ └ — used by tool cards and command output. */
function frame({ corner = '┌', title, meta, body, foot }) {
  const box = el('div', 'b-box');
  box.append(rule(corner, title, meta));
  const b = el('div', 'b-body');
  if (body) b.append(body);
  box.append(b);
  if (foot) box.append(rule('└', foot, ''));
  return box;
}
function kv(k, v, cls = '') {
  const row = el('div', `b-kv${cls ? ` ${cls}` : ''}`);
  row.append(el('span', 'b-k', k), el('span', 'b-v', v));
  return row;
}

// ── announcer ───────────────────────────────────────────────────────────
const live = (text, priority) => announceStatus(text, priority);

// ── status line ─────────────────────────────────────────────────────────
function setRunState(s) {
  state.runState = s;
  updateStatus();
}

function updateStatus() {
  const s = S.getActive();
  const list = S.loadSessions();
  dom.stSession.textContent = `[${list.findIndex((x) => x.id === s?.id) + 1 || 1}/${list.length}]`;
  dom.stModel.textContent = shortModel(getActiveModel());
  dom.stModel.title = getActiveModel() || '';
  dom.stPreset.textContent = s?.preset || 'BASIC AGENT';
  dom.stMem.textContent = state.stats.mem;
  dom.stMsg.textContent = String(state.stats.msg);
  dom.stTps.textContent = state.stats.tps ? state.stats.tps.toFixed(1) : '0.0';
  dom.stState.textContent = state.runState;
  dom.status.classList.toggle('is-busy', BUSY_STATES.has(state.runState));
}

// ── telemetry poll (engine stats, mirrors old HUD interval) ─────────────
let lastTok = 0, lastT = performance.now();
setInterval(() => {
  const E = eng();
  if (!E) return;
  const tmp = E.scratch() + 0xF000;
  E.memstats(tmp);
  const dv = new DataView(memBuf(), tmp, 32);
  const now = performance.now();
  const dt = (now - lastT) / 1000;
  const tok = dv.getInt32(24, true);
  state.stats.tps = dt > 0 ? Math.max(0, (tok - lastTok) / dt) : 0;
  lastTok = tok; lastT = now;
  const memKb = (dv.getInt32(8, true) / 1024) | 0;
  state.stats.mem = `${memKb}KB`;
  state.stats.msg = dv.getInt32(4, true);
  updateStatus();
}, 500);

// ── markdown ────────────────────────────────────────────────────────────

// ── turns ───────────────────────────────────────────────────────────────
function banner() {
  const wrap = el('div', 'b-turn b-banner');
  const mark = el('div', 'b-mark');
  mark.append(el('span', 'b-mark-t', 'ASM::AGENT'));
  mark.append(el('span', 'b-mark-s', 'amber phosphor terminal · wat engine · fan-out web search'));
  wrap.append(mark);
  const hint = el('div', 'b-hint');
  hint.innerHTML = 'type a message and press <b>enter</b> · <b>:</b> commands · <b>tab</b> completes · <b>?</b> keys';
  wrap.append(hint);
  return add(wrap, { force: true });
}

function sessionHeader(note) {
  const s = S.getActive();
  if (!s) return;
  const msgs = s.messages.filter((m) => m.role !== 0).length;
  const row = el('div', 'b-sec');
  row.textContent = `── session ${s.id} · ${s.title} · ${msgs} msgs ${'─'.repeat(4)}`;
  add(row);
  if (note) add(el('div', 'b-note', note));
  return row;
}

/** Live tool card: ┌ TOOL CALL · web_search(args) … groups stream in … └ status. */
function addToolCard(name, args) {
  const det = el('details', 'b-box b-tool');
  det.open = true;
  const op = el('span', 'b-op');
  const stat = el('span', 'b-stat', 'SEARCHING…');
  const head = el('summary', 'b-rule');
  head.dataset.corner = '┌';
  head.append(el('span', 'b-lab', `TOOL CALL · ${name}(${JSON.stringify(args)})`), op, el('span', 'b-fill'), stat);

  const body = el('div', 'b-body');
  det.append(head, body);
  add(det, { force: true });
  return {
    card: det,
    done(result) {
      if (result.sources === 0) {
        stat.textContent = `FAILED: ${(result.failures || []).join(', ') || 'no sources'}`;
      } else {
        stat.textContent = `${result.sources} SOURCES${result.failures?.length ? ` · MISSED: ${result.failures.join(',')}` : ''}`;
      }
      body.textContent = '';
      if (result.perSource && result.perSource.length) {
        const msMap = new Map(result.perSource.map((ps) => [ps.tag, ps.ms]));
        const groups = [];
        let cur = null;
        for (const b of parseBlocks(result.markdown)) {
          if (!cur || cur.tag !== b.tag) {
            cur = { tag: b.tag, ms: msMap.get(b.tag) ?? 0, hits: [] };
            groups.push(cur);
          }
          cur.hits.push(b);
        }
        for (const g of groups) body.append(groupBlock(g, groups.indexOf(g) > 1));
      } else {
        for (const h of parseBlocks(result.markdown)) {
          const row = el('div', 'b-hit');
          row.append(el('div', 'b-hit-t', h.title));
          if (h.url) row.append(el('div', 'b-hit-u', h.url));
          row.append(el('div', 'b-hit-s', h.snippet.slice(0, 220)));
          body.append(row);
        }
      }
      det.open = false;
    },
  };
}

function groupBlock(g, collapsed) {
  const det = el('details', 'b-grp');
  det.open = !collapsed;
  const sum = el('summary', 'b-rule b-rule-in');
  sum.append(el('span', 'b-op'), el('span', 'b-lab', g.tag), el('span', 'b-fill'),
    el('span', 'b-stat', `${g.ms ? `${g.ms}ms · ` : ''}${g.hits.length} ${g.hits.length === 1 ? 'hit' : 'hits'}`));
  const hits = el('div', 'b-hits');
  for (const h of g.hits) {
    const row = el('div', 'b-hit');
    const a = el('a', 'b-hit-t', h.title);
    if (h.url) { a.href = h.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    row.append(a);
    if (h.url) row.append(el('div', 'b-hit-u', h.url));
    row.append(el('div', 'b-hit-s', h.snippet.slice(0, 220)));
    hits.append(row);
  }
  det.append(sum, hits);
  return det;
}

/** Streamed assistant answer: ┌ AGENT ▸ model · tok/s │ markdown │ └ end of answer. */
function addAnswerCard(label) {
  const turn = el('div', 'b-turn b-ans');
  turn.append(rule('┌', label, `${shortModel(getActiveModel())}`));
  const body = el('div', 'b-md');
  turn.append(body);
  const footEl = el('div', 'b-rule');
  footEl.dataset.corner = '└';
  const footLab = el('span', 'b-lab', 'streaming…');
  footEl.append(footLab, el('span', 'b-fill'));
  turn.append(footEl);
  add(turn, { force: true });
  return {
    body, footLab, footEl,
    finalize(foot) {
      body.classList.remove('is-streaming');
      highlightCode(body, { final: true });
      addCopyButtons(body);
      footLab.textContent = foot || 'end of answer';
    },
  };
}


// ── send / turn loop ────────────────────────────────────────────────────
let busy = false;

function setBusy(b) {
  busy = b;
  dom.send.classList.toggle('is-stop', b);
  dom.send.textContent = b ? '■' : '↵';
  dom.send.setAttribute('aria-label', b ? 'Stop generating' : 'Send message');
}

async function doSend(text) {
  if (busy) { stop(); return; }
  text = (text ?? dom.input.value).trim();
  if (!text) return;
  if (text.startsWith(':')) { execLine(text); return; }
  if (text === '?') { openKeys(); return; }

  const key = settings.key;
  const model = getActiveModel();
  if (!model) { errorLine('NO MODEL — run :model and select one.'); live('No model selected', 'assertive'); return; }
  const gate = checkAccess(model, key);
  if (!gate.ok) { errorLine(gate.reason); live('This model needs a key', 'assertive'); return; }

  dom.input.value = '';
  paint();
  echo(text, 'is-user');
  setBusy(true);
  setRunState('THINK');
  live('ASM Agent generating…');

  let card = null, acc = '', raf = 0, toolCards = [];
  const dropIfEmpty = () => {
    if (card && !card.body.textContent.trim()) card.footEl.closest('.b-turn')?.remove();
  };
  const paintStream = () => {
    raf = 0;
    if (!card) return;
    renderMarkdown(card.body, acc);
    card.body.classList.add('is-streaming');
    highlightCode(card.body);
    scrollDown();
  };

  await runTurn(text, {
    key, model,
    persist: () => S.saveActiveSession(historyMessages()),
    on(ev) {
      switch (ev.type) {
        case 'round-started':
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          dropIfEmpty();
          card = addAnswerCard('AGENT ▸');
          acc = '';
          toolCards = [];
          resetRender();
          renderDrain();
          break;
        case 'delta':
          acc += ev.text;
          if (!raf) raf = requestAnimationFrame(paintStream);
          break;
        case 'tool-started':
          sfxTool();
          setRunState('SEARCH');
          live('Searching ' + (ev.query || ev.name || 'sources') + '…');
          toolCards.push(addToolCard(ev.name, { query: ev.query }));
          break;
        case 'tool-finished': {
          const tc = toolCards.find((c) => !c._done) || toolCards[toolCards.length - 1];
          if (tc) { tc.done(ev.result); tc._done = true; }
          live('Search complete');
          break;
        }
        case 'round-final':
          if (!card) card = addAnswerCard('AGENT ▸');
          renderFinal(card.body, ev.text);
          card.finalize();
          break;
        case 'aborted':
          errorLine('STREAM ABORTED');
          live('Stream aborted', 'assertive');
          break;
        case 'errored':
          errorLine(ev.message);
          live('Error: ' + ev.message.slice(0, 80), 'assertive');
          break;
        case 'done': {
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          dropIfEmpty();
          card?.finalize();
          sfxDone();
          setBusy(false);
          setRunState('DONE');
          const tokens = acc ? acc.split(/\s+/).length : 0;
          live(tokens ? `Response complete, ${tokens} tokens` : 'Response complete');
          break;
        }
      }
    },
  });
  renderStatusAfterTurn();
}

function renderStatusAfterTurn() {
  const s = S.getActive();
  state.stats.msg = s ? s.messages.filter((m) => m.role !== 0).length : 0;
  updateStatus();
}

// ── memory inspector output (:mem) ──────────────────────────────────────
function memCmd() {
  const E = eng();
  if (!E) { errorLine('engine not ready'); return; }
  const dv = new DataView(memBuf());
  const heapBump = dv.getInt32(0x20, true);
  const histBump = dv.getInt32(0x10, true);
  const poolBump = dv.getInt32(0x1C, true);
  const rendLen = dv.getInt32(0x14, true);
  const modCnt = dv.getInt32(0x18, true);
  const regions = [
    ['HEAP', heapBump - 0x90000, 16 * 1024 * 1024, 'bump allocator from 0x90000 (cap 16 MiB)'],
    ['HISTORY', histBump - 0x8000, 96 * 1024, '96 KiB arena 0x8000-0x1FFFF'],
    ['POOL', poolBump - 0x28000, 96 * 1024, '96 KiB model strings 0x28000-0x3FFFF'],
    ['RENDER', rendLen, 128 * 1024, '128 KiB pending markdown 0x50000-0x6FFFF'],
    ['MODELS', modCnt * 128, 512 * 128, 'records, max 512'],
  ];
  const body = el('div');
  for (const [label, used, cap, note] of regions) {
    const p = Math.max(0, Math.min(100, (Math.max(0, used) / cap) * 100));
    const row = el('div', 'b-mem');
    const bar = el('span', 'b-mem-bar');
    const fill = el('i', 'b-mem-fill');
    fill.style.width = `${p.toFixed(p < 1 ? 2 : 0)}%`;
    bar.append(fill);
    row.append(el('span', 'b-mem-lab', label), bar,
      el('span', 'b-mem-num', `${fmtBytes(used)}/${fmtBytes(cap)}`),
      el('span', 'b-mem-pct', `${p < 1 ? p.toFixed(2) : Math.round(p)}%`));
    row.title = note;
    body.append(row);
  }
  add(frame({
    title: 'MEMORY · wat linear memory',
    meta: `${regions.length} regions`,
    body,
    foot: 'live engine regions',
  }));
  live('Memory regions printed.');
}
function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MiB`;
  if (n >= 1024) return `${(n / 1024) | 0}KB`;
  return `${n}B`;
}

// ── WAT listing (:wat) ──────────────────────────────────────────────────
const WAT_KW = /\b(module|memory|func|param|result|local|global|block|loop|br_if|br|if|then|else|return|call|call_indirect|i32|i64|f32|f64|data|export|import|select|drop|memory\.fill|memory\.copy|memory\.grow|memory\.size)\b/g;

async function watCmd() {
  let html;
  try {
    const txt = await (await fetch('src/agent.wat')).text();
    html = txt.split('\n').map((line, i) => {
      const h = esc(line)
        .replace(/("[^"]*")/g, '<span class="b-str">$1</span>')
        .replace(WAT_KW, '<span class="b-kw">$1</span>');
      return `<div class="b-wline"><span class="b-ln">${String(i + 1).padStart(4, ' ')}</span><span class="b-wsrc">${h}</span></div>`;
    }).join('');
  } catch {
    html = '<div class="b-wline"><span class="b-wsrc">agent.wat unavailable</span></div>';
  }
  const pre = el('pre', 'b-wat');
  pre.innerHTML = html;
  add(frame({ title: 'WAT · js/wasm engine source', body: pre, foot: 'read-only listing' }));
  live('WAT listing printed.');
}

// ── runtime state (:status) ─────────────────────────────────────────────
function statusCmd() {
  const s = S.getActive();
  const id = getActiveModel();
  const m = visibleModelById(id);
  const rows = [
    ['session', s ? `${s.id} · ${s.title} (${s.messages.filter((x) => x.role !== 0).length} msgs)` : 'none'],
    ['model', id ? `${id}${m ? ` · ctx ${humanCtx(m.ctx)} · ${modelPrice(m)}` : ''}` : 'none'],
    ['preset', s ? `${s.preset} — "${(s.system || '').slice(0, 96)}"` : 'none'],
    ['crt', `scan:${settings.crt?.scan ? 'on' : 'off'} curve:${settings.crt?.curve ? 'on' : 'off'} flicker:${settings.crt?.flicker ? 'on' : 'off'} bell:${settings.crt?.sound ? 'on' : 'off'}`],
    ['telemetry', `mem ${state.stats.mem} · msg ${state.stats.msg} · tok/s ${(state.stats.tps || 0).toFixed(1)} · state ${state.runState}`],
    ['key', settings.key ? 'BYO key set' : 'anonymous — :free models via Proxy'],
    ['input', `${state.history.length} history entries · mode ${isCmdMode() ? 'command' : 'chat'}`],
  ];
  const body = el('div');
  for (const [k, v] of rows) body.append(kv(k, v));
  add(frame({ title: 'RUNTIME STATE', body, foot: 'live engine state' }));
  live('Runtime state printed.');
}
function modelPrice(m) {
  return !(m.pp > 0) && !(m.pc > 0) ? 'FREE' : `${money(Math.max(0, m.pp))} in · ${money(Math.max(0, m.pc))} out`;
}
function visibleModelById(id) {
  try {
    const E = eng();
    const cnt = E.models_filter(0, E.scratch(), 0);
    for (let i = 0; i < cnt; i++) {
      const m = visibleModel(i);
      if (m.id === id) return m;
    }
  } catch {}
  return null;
}

// ── presets (:preset) ───────────────────────────────────────────────────
function preset(arg) {
  const want = String(arg || '').trim().toLowerCase();
  if (want) {
    const hit = Object.keys(S.PRESETS).find((k) => k.toLowerCase().startsWith(want));
    if (hit) { applyPreset(hit); return; }
  }
  openPreset(want);
}

function applyPreset(name, custom = null) {
  const s = S.getActive();
  if (!s) return;
  const text = custom ?? S.PRESETS[name] ?? '';
  S.setSystemPrompt(s.id, custom ? 'CUSTOM' : name, text);
  // replay wasm history with the new system message
  const msgs = historyMessages();
  clearHistory();
  msgs[0] = { role: 0, content: text, tool_call_id: '', name: '', args: '' };
  for (const m of msgs) appendHistory(m.role, m.content, m);
  S.saveActiveSession(historyMessages());
  updateStatus();
  add(el('div', 'b-l b-ok', `preset → ${custom ? 'CUSTOM' : name}`));
  add(el('div', 'b-l b-dim', `  "${text.slice(0, 96)}"`));
  live(`Preset set to ${custom ? 'CUSTOM' : name}.`);
}

// ── sessions (:session / :new) ──────────────────────────────────────────
function sessionCmd(arg) {
  const list = S.loadSessions();
  const n = Number.parseInt(String(arg || '').trim(), 10);
  if (Number.isInteger(n) && n >= 1 && n <= list.length) return switchSession(list[n - 1].id);
  return openSession(String(arg || ''));
}

function switchSession(id) {
  if (busy || streaming()) { errorLine('busy — stop the current turn first'); return; }
  S.setActiveId(id);
  restoreSession();
}

function newSession() {
  if (busy || streaming()) { errorLine('busy — stop the current turn first'); return; }
  S.newSession();
  restoreSession();
}

function restoreSession() {
  clearHistory();
  dom.transcript.textContent = '';
  state.watched = true;
  banner();
  let s = S.getActive();
  if (!s) s = S.newSession();
  sessionHeader();
  for (const m of s.messages) {
    appendHistory(m.role, m.content, { tool_call_id: m.tool_call_id, name: m.name, args: m.args });
    if (m.role === 1) echo(m.content, 'is-user');
    else if (m.role === 2 && m.content) {
      const card = addAnswerCard('AGENT ▸');
      renderFinal(card.body, m.content);
      card.finalize();
    } else if (m.role === 3) {
      const card = addToolCard(m.name || 'web_search', { query: '(restored)' });
      card.done({ sources: 1, failures: [], markdown: m.content.slice(0, 4000) });
    }
  }
  updateStatus();
}

// ── API key (:key) ──────────────────────────────────────────────────────
function commitKey(raw) {
  settings.key = String(raw || '').trim();
  S.saveSettings(settings);
  try { if (!settings.key) getActiveModel(); } catch {}
  updateStatus();
}

// ── command surface ─────────────────────────────────────────────────────
const COMMANDS = [
  { name: 'model', args: '[filter]', desc: 'choose the active model', run: (a) => openModel(a) },
  { name: 'preset', args: '[name]', desc: 'switch the system-prompt preset', run: (a) => preset(a) },
  { name: 'session', args: '[n]', desc: 'list or switch sessions', run: (a) => sessionCmd(a) },
  { name: 'new', args: '', desc: 'start a new session', run: () => newSession() },
  { name: 'mem', args: '', desc: 'print the memory regions', run: () => memCmd() },
  { name: 'wat', args: '', desc: 'dump the WAT source listing', run: () => watCmd() },
  { name: 'status', args: '', desc: 'print the full runtime state', run: () => statusCmd() },
  { name: 'scan', args: '', desc: 'toggle CRT scanlines', run: () => crtCmd('scan', 'scanlines') },
  { name: 'curve', args: '', desc: 'toggle CRT curvature', run: () => crtCmd('curve', 'curvature') },
  { name: 'flicker', args: '', desc: 'toggle CRT flicker', run: () => crtCmd('flicker', 'flicker') },
  { name: 'sound', args: '', desc: 'toggle the terminal bell', run: () => crtCmd('sound', 'bell') },
  { name: 'key', args: '', desc: 'OpenRouter API key + data controls', run: () => openKeyDlg() },
  { name: 'clear', args: '', desc: 'clear the scrollback', run: () => clearCmd() },
  { name: 'keys', args: '', desc: 'keybindings + command map', run: () => openKeys() },
  { name: 'help', args: '', desc: 'keybindings + command map', run: () => openKeys() },
  { name: 'q', args: '', desc: 'exit', run: () => add(el('div', 'b-l b-dim', 'no job control in this terminal — close the tab to exit.')) },
];

function execLine(line) {
  echo(line, 'is-cmd');
  const [name, ...rest] = line.replace(/^:/, '').trim().split(/\s+/);
  const arg = rest.join(' ');
  const cmd = COMMANDS.find((c) => c.name === name.toLowerCase());
  if (!cmd) {
    errorLine(`: ${name}: command not found  —  try :help`);
    blip(220, 0.09);
    live(`Command ${name} not found.`);
    return;
  }
  blip(700, 0.035);
  cmd.run(arg);
}

function crtCmd(key, label) {
  toggleCrt(key);
  const on = settings.crt?.[key];
  add(el('div', `b-l ${on ? 'b-ok' : 'b-dim'}`, `${label}: ${on ? 'ON' : 'OFF'}`));
  if (key === 'sound' && on) blip(880, 0.09, 'sine', 0.05);
  live(`${label} ${on ? 'on' : 'off'}.`);
}

function clearCmd() {
  dom.transcript.textContent = '';
  state.watched = true;
}

// ── prompt / input line ─────────────────────────────────────────────────
const isCmdMode = () => dom.input.value.startsWith(':');
const narrow = () => window.innerWidth <= 460;

function paint() {
  const v = dom.input.value.replace(/\n+/g, ' ');
  if (v !== dom.input.value) dom.input.value = v;
  dom.mirror.textContent = '';
  if (v.startsWith(':')) {
    dom.mirror.append(el('span', 'b-cmdc', ':'), document.createTextNode(v.slice(1)));
  } else {
    dom.mirror.textContent = v;
  }
  dom.ph.hidden = v.length > 0;
  const cmd = v.startsWith(':');
  dom.prompt.classList.toggle('is-cmd', cmd);
  dom.status.classList.toggle('is-cmd', cmd);
  if (cmd) dom.ph.textContent = narrow() ? ':cmd — tab completes' : ':model · :preset · :session · :mem · :status · :keys — tab completes';
  else dom.ph.textContent = narrow() ? 'message, or ":" to command' : 'type a message · ":" for commands · "?" for keys';
  updateSuggestions();
}

const SUG_MAX = 7;

function updateSuggestions() {
  const v = dom.input.value;
  const sug = dom.sug;
  if (!v.startsWith(':') || /\s/.test(v.slice(1))) {
    sug.hidden = true;
    sug.textContent = '';
    state.sugItems = [];
    state.sugIdx = -1;
    return;
  }
  const q = v.slice(1).toLowerCase();
  const all = COMMANDS.filter((c) => c.name.startsWith(q));
  const items = all.slice(0, SUG_MAX);
  state.sugItems = items;
  state.sugIdx = items.length ? 0 : -1;
  sug.textContent = '';
  if (!items.length) { sug.hidden = true; return; }
  items.forEach((c, i) => {
    const li = el('li', 'b-sug-i');
    const b = el('button', 'b-sug-b');
    b.type = 'button';
    b.append(el('span', 'b-sug-c', `:${c.name}`), el('span', 'b-sug-a', c.args), el('span', 'b-sug-d', c.desc));
    if (i === 0) b.classList.add('is-hl');
    b.addEventListener('mousedown', (ev) => { ev.preventDefault(); complete(c.name); });
    li.append(b);
    sug.append(li);
  });
  if (all.length > items.length) {
    sug.append(el('li', 'b-sug-more', `+${all.length - items.length} more — tab lists all`));
  }
  sug.hidden = false;
}

function moveSug(delta) {
  const items = state.sugItems;
  if (!items.length) return false;
  state.sugIdx = Math.max(0, Math.min(items.length - 1, state.sugIdx + delta));
  const btns = dom.sug.querySelectorAll('.b-sug-b');
  btns.forEach((b, i) => b.classList.toggle('is-hl', i === state.sugIdx));
  btns[state.sugIdx]?.scrollIntoView({ block: 'nearest' });
  return true;
}

function complete(name) {
  dom.input.value = `:${name} `;
  dom.input.focus();
  paint();
  dom.input.setSelectionRange(dom.input.value.length, dom.input.value.length);
}

function printCommandList() {
  const body = el('div');
  for (const c of COMMANDS) {
    const row = el('div', 'b-kv');
    row.append(el('span', 'b-k', `:${c.name}${c.args ? ` ${c.args}` : ''}`), el('span', 'b-v', c.desc));
    body.append(row);
  }
  add(frame({ title: 'COMMANDS', meta: `${COMMANDS.length} entries`, body, foot: 'press tab on “:” to list again' }));
}

function historyStep(delta) {
  const h = state.history;
  if (!h.length) return;
  if (state.histIdx < 0) {
    if (delta > 0) return;
    state.draft = dom.input.value;
    state.histIdx = h.length - 1;
  } else {
    const next = state.histIdx + delta;
    if (next < 0) state.histIdx = 0;
    else if (next >= h.length) state.histIdx = -1;
    else state.histIdx = next;
  }
  dom.input.value = state.histIdx < 0 ? state.draft : h[state.histIdx];
  paint();
  dom.input.setSelectionRange(dom.input.value.length, dom.input.value.length);
}

function submitLine() {
  const raw = dom.input.value.trim();
  if (!raw) return;
  addHistory(raw);
  dom.input.value = '';
  paint();
  if (raw === '?') { openKeys(); return; }
  if (raw.startsWith(':')) {
    if (raw.replace(/^:/, '').trim() === '') { openKeys(); return; }
    execLine(raw);
    return;
  }
  doSend(raw);
}

function addHistory(raw) {
  state.history.push(raw);
  if (state.history.length > 60) state.history.shift();
  state.histIdx = -1;
}

// ── overlays (native <dialog>) ──────────────────────────────────────────
function makeDialog(id, title, cls = '') {
  let d = document.getElementById(id);
  if (d) return { d, body: d.querySelector('.b-dlg-body'), foot: d.querySelector('.b-dlg-foot'), title: d.querySelector('.b-lab') };
  d = el('dialog', `b-dlg${cls ? ` ${cls}` : ''}`);
  d.id = id;
  const inner = el('div', 'b-dlg-in');
  const head = rule('┌', title, '');
  const close = el('button', 'b-x', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', `Close ${title.toLowerCase()}`);
  close.addEventListener('click', () => d.close());
  head.append(close);
  const body = el('div', 'b-dlg-body');
  body.tabIndex = 0;
  body.setAttribute('role', 'region');
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
    const ae = document.activeElement;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!ev.shiftKey && ae === last) { ev.preventDefault(); first.focus(); }
    else if (ev.shiftKey && ae === first) { ev.preventDefault(); last.focus(); }
  });
  d.addEventListener('close', () => { dom.input?.focus({ preventScroll: true }); });
  document.body.append(d);
  return { d, body, foot, title: head.querySelector('.b-lab') };
}

// keymap / help ---------------------------------------------------------
const KEYMAP = [
  ['enter', 'send the message · run the command'],
  [':  (empty line)', 'enter command mode'],
  ['tab', 'complete the command name · bare “:” lists them'],
  ['↑ ↓', 'input history, or walk the suggestion list'],
  ['esc', 'leave command mode · close an overlay'],
  ['ctrl+L', 'clear the scrollback'],
  ['ctrl+C', 'abort the current line'],
  ['f1 · ?', 'this overlay (? needs an empty line)'],
  ['click', 'anywhere in the terminal focuses the prompt'],
];

function openKeys() {
  const { body, foot, d } = makeDialog('b-dlg-keys', 'KEYMAP', 'b-dlg-keys');
  body.textContent = '';
  const keys = el('div', 'b-klist');
  for (const [k, a] of KEYMAP) {
    const row = el('div', 'b-krow');
    row.append(el('kbd', 'b-kkey', k), el('span', 'b-kact', a));
    keys.append(row);
  }
  body.append(el('div', 'b-rule b-rule-plain', '─ KEYBINDINGS'), keys);
  const cmds = el('div', 'b-klist');
  for (const c of COMMANDS) {
    const row = el('div', 'b-krow');
    row.append(el('kbd', 'b-kkey', `:${c.name}${c.args ? ` ${c.args}` : ''}`), el('span', 'b-kact', c.desc));
    cmds.append(row);
  }
  body.append(el('div', 'b-rule b-rule-plain', '─ COMMANDS'), cmds);
  foot.textContent = 'esc closes · the prompt is still live behind this overlay';
  if (!d.open) d.showModal();
}

// model picker -----------------------------------------------------------
const modelDlgState = { filter: '', metric: 4, desc: 1, mask: 0, hl: 0, shown: [] };

function filteredModels() {
  const toks = modelDlgState.filter.toLowerCase().split(/\s+/).filter(Boolean);
  const n = applyView(modelDlgState.metric, modelDlgState.desc, modelDlgState.mask, modelDlgState.filter);
  const out = [];
  const max = Math.min(n, 400);
  for (let i = 0; i < max; i++) {
    const m = visibleModel(i);
    const hay = `${m.id} ${m.name}`.toLowerCase();
    if (toks.every((t) => hay.includes(t))) out.push(m);
  }
  return out;
}

function openModel(filter = '') {
  const { d } = makeDialog('b-dlg-model', 'CHOOSE MODEL', 'b-dlg-model');
  modelDlgState.filter = filter;
  modelDlgState.hl = 0;
  if (isAnonUser()) modelDlgState.mask = 1;
  renderModelDlg();
  if (!d.open) d.showModal();
  dom.modelFilter.focus();
  dom.modelFilter.setSelectionRange(dom.modelFilter.value.length, dom.modelFilter.value.length);
}

function buildModelDlg() {
  const dlg = makeDialog('b-dlg-model', 'CHOOSE MODEL', 'b-dlg-model');
  dlg.body.innerHTML = `
    <div class="b-dlg-bar">
      <label class="sr-only" for="b-model-filter">Filter models</label>
      <input id="b-model-filter" class="b-filter" type="text" placeholder="filter: free · tools · vision · ctx…" autocomplete="off" spellcheck="false">
      <span class="b-dlg-count" id="b-model-count"></span>
    </div>
    <div class="b-chips" id="b-model-chips">
      <button type="button" class="b-chip" data-chip="FREE">FREE</button>
      <button type="button" class="b-chip" data-chip="TOOLS">TOOLS</button>
      <button type="button" class="b-chip" data-chip="REASONING">REASONING</button>
      <button type="button" class="b-chip" data-chip="VISION">VISION</button>
      <button type="button" class="b-chip" data-chip="CTX≥128K">CTX≥128K</button>
      <span class="b-chips-sp"></span>
      <span class="b-chips-lab">sort</span>
      <button type="button" class="b-chip" data-sort="price">price</button>
      <button type="button" class="b-chip" data-sort="ctx">ctx</button>
      <button type="button" class="b-chip" data-sort="lat">lat</button>
      <button type="button" class="b-chip" data-sort="tps">tps</button>
      <button type="button" class="b-chip" data-sort="new">new</button>
    </div>
    <ul class="b-list" id="b-model-list" role="listbox" aria-label="Models"></ul>`;
  dlg.foot.textContent = '↑ ↓ select · enter apply · esc cancel';
  dom.modelDlg = dlg;
  dom.modelFilter = dlg.body.querySelector('#b-model-filter');
  dom.modelList = dlg.body.querySelector('#b-model-list');
  dom.modelCount = dlg.body.querySelector('#b-model-count');
  dom.modelChips = dlg.body.querySelector('#b-model-chips');
  dom.modelFilter.addEventListener('input', () => { modelDlgState.filter = dom.modelFilter.value; modelDlgState.hl = 0; renderModelDlg(); });
  dom.modelChips.addEventListener('click', (ev) => {
    const chip = ev.target.closest('.b-chip');
    if (!chip) return;
    if (chip.dataset.sort) {
      const metric = SORTS.indexOf(SORT_KEY[chip.dataset.sort]);
      if (modelDlgState.metric === metric) modelDlgState.desc = modelDlgState.desc ? 0 : 1;
      else { modelDlgState.metric = metric; modelDlgState.desc = DEFAULT_DESC[metric]; }
    } else {
      const mask = MASKS[chip.dataset.chip];
      if (isAnonUser() && mask !== 1) {
        add(el('div', 'b-l b-dim', 'anonymous users are locked to FREE — add a key via :key for the full catalog.'));
      } else {
        modelDlgState.mask = modelDlgState.mask === mask ? 0 : mask;
      }
      modelDlgState.hl = 0;
    }
    renderModelDlg();
    dom.modelFilter.focus();
  });
  dlg.d.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); hlModel(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); hlModel(-1); }
    else if (ev.key === 'Enter') {
      ev.preventDefault();
      const m = modelDlgState.shown[modelDlgState.hl];
      if (m) pickModel(m);
    }
  });
}

function renderModelDlg() {
  if (!dom.modelDlg) buildModelDlg();
  dom.modelChips.querySelectorAll('.b-chip').forEach((c) => {
    if (c.dataset.sort) {
      const metric = SORTS.indexOf(SORT_KEY[c.dataset.sort]);
      const on = modelDlgState.metric === metric;
      c.classList.toggle('is-on', on);
      c.textContent = on ? `${c.dataset.sort} ${modelDlgState.desc ? '↓' : '↑'}` : c.dataset.sort;
    } else {
      c.classList.toggle('is-on', MASKS[c.dataset.chip] === modelDlgState.mask && modelDlgState.mask !== 0);
    }
  });
  const list = filteredModels();
  modelDlgState.shown = list;
  modelDlgState.hl = Math.max(0, Math.min(modelDlgState.hl, list.length - 1));
  const activeId = getActiveModel();
  dom.modelList.textContent = '';
  if (!list.length) {
    dom.modelList.append(el('li', 'b-l b-dim', 'no model matches that filter'));
  }
  list.forEach((m, i) => {
    const li = el('li', 'b-row');
    li.id = `b-mr-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(m.id === activeId));
    li.setAttribute('aria-label', m.name);
    li.classList.toggle('is-hl', i === modelDlgState.hl);
    li.classList.toggle('is-active', m.id === activeId);
    li.append(el('span', 'b-row-mk', m.id === activeId ? '▸' : ' '));
    const t = el('span', 'b-row-t', m.name);
    t.append(el('span', 'b-row-id', m.id));
    li.append(t);
    const badges = [
      m.flags & 1 ? 'FREE' : '', m.flags & 2 ? 'VISION' : '', m.flags & 4 ? 'REASON' : '', m.flags & 8 ? 'TOOLS' : '',
    ].filter(Boolean);
    li.append(el('span', 'b-row-m', `ctx ${humanCtx(m.ctx)} · ${modelPrice(m)}`));
    const tags = el('span', 'b-row-tags');
    for (const tg of badges) tags.append(el('i', '', tg));
    if (m.id === activeId) tags.append(el('i', 'b-row-on', 'ACTIVE'));
    li.append(tags);
    li.addEventListener('click', () => pickModel(m));
    dom.modelList.append(li);
  });
  dom.modelCount.textContent = `${list.length}/${catalogSize()} models`;
  dom.modelFilter.setAttribute('aria-activedescendant', list.length ? `b-mr-${modelDlgState.hl}` : '');
}

function hlModel(delta) {
  if (!modelDlgState.shown.length) return;
  modelDlgState.hl = Math.max(0, Math.min(modelDlgState.shown.length - 1, modelDlgState.hl + delta));
  renderModelDlg();
  document.getElementById(`b-mr-${modelDlgState.hl}`)?.scrollIntoView({ block: 'nearest' });
}

function pickModel(m) {
  setActiveModel(m.id);
  dom.modelDlg.d.close();
  add(el('div', 'b-l b-ok', `model → ${m.id}`));
  add(el('div', 'b-l b-dim', `  ctx ${humanCtx(m.ctx)} · ${modelPrice(m)}`));
  live(`Model set to ${m.name}.`);
  blip(920, 0.06, 'sine');
  updateStatus();
}

// preset picker -----------------------------------------------------------
function openPreset(filter = '') {
  const dlg = makeDialog('b-dlg-preset', 'SYSTEM PROMPT', 'b-dlg-preset');
  if (!dlg.body.querySelector('#b-preset-list')) {
    dlg.body.innerHTML = `
      <ul class="b-list b-list-sm" id="b-preset-list" role="listbox" aria-label="Presets"></ul>
      <label class="b-lab2" for="b-preset-text">system prompt (edit + apply to store a custom preset)</label>
      <textarea id="b-preset-text" class="b-custom" rows="3" spellcheck="false"></textarea>
      <button type="button" class="b-btn" id="b-preset-apply">APPLY AS CUSTOM</button>`;
    dlg.foot.textContent = 'click a preset to switch · esc cancel';
    dom.presetList = dlg.body.querySelector('#b-preset-list');
    dom.presetText = dlg.body.querySelector('#b-preset-text');
    dlg.body.querySelector('#b-preset-apply').addEventListener('click', applyCustom);
    dom.presetDlg = dlg;
  }
  renderPresetDlg(filter);
  if (!dom.presetDlg.d.open) dom.presetDlg.d.showModal();
  blip(520, 0.03);
}

function renderPresetDlg(filter = '') {
  const toks = filter.toLowerCase().split(/\s+/).filter(Boolean);
  dom.presetList.textContent = '';
  const s = S.getActive();
  Object.entries(S.PRESETS).forEach(([name, text]) => {
    if (toks.length && !`${name} ${text}`.toLowerCase().includes(toks.join(' '))) return;
    const active = s?.preset === name && s?.system === text;
    const li = el('li', 'b-row');
    li.setAttribute('role', 'option');
    li.tabIndex = 0;
    li.classList.toggle('is-active', active);
    li.append(el('span', 'b-row-mk', active ? '▸' : ' '));
    li.append(el('span', 'b-row-t', name), el('span', 'b-row-m', text));
    const pick = () => { dom.presetDlg.d.close(); applyPreset(name); };
    li.addEventListener('click', pick);
    li.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); }
    });
    dom.presetList.append(li);
  });
  if (s?.preset === 'CUSTOM' && s?.system) {
    const li = el('li', 'b-row is-active');
    li.append(el('span', 'b-row-mk', '▸'), el('span', 'b-row-t', 'CUSTOM'), el('span', 'b-row-m', s.system));
    dom.presetList.prepend(li);
  }
  dom.presetText.value = s?.system || '';
}

function applyCustom() {
  const v = dom.presetText.value.trim();
  if (!v) return;
  dom.presetDlg.d.close();
  applyPreset('CUSTOM', v);
}

// session picker — rows carry explicit buttons (OPEN/REN/MD/JSON/DEL); the row itself is
// not an interactive control, so buttons stay unnested
function openSession(filter = '') {
  const dlg = makeDialog('b-dlg-session', 'SESSIONS', 'b-dlg-session');
  if (!dlg.body.querySelector('#b-session-list')) {
    dlg.body.innerHTML = '<ul class="b-list b-list-sm" id="b-session-list" aria-label="Sessions"></ul>';
    dom.sessionList = dlg.body.querySelector('#b-session-list');
    dom.sessionDlg = dlg;
  }
  renderSessionDlg(filter);
  if (!dom.sessionDlg.d.open) dom.sessionDlg.d.showModal();
}

function renderSessionDlg(filter = '') {
  const toks = filter.toLowerCase().split(/\s+/).filter(Boolean);
  dom.sessionList.textContent = '';
  const act = S.activeId();
  const addRow = el('li', 'b-row');
  addRow.append(el('span', 'b-row-t', '+ NEW SESSION'),
    el('span', 'b-row-m', 'starts an empty transcript'));
  const addBar = el('div', 'b-row-act');
  const addBtn = el('button', '', 'NEW');
  addBtn.type = 'button';
  addBtn.addEventListener('click', (ev) => { ev.stopPropagation(); dom.sessionDlg.d.close(); newSession(); });
  addBar.append(addBtn);
  addRow.append(addBar);
  dom.sessionList.append(addRow);
  S.loadSessions().forEach((s) => {
    if (toks.length && !`${s.id} ${s.title}`.toLowerCase().includes(toks.join(' '))) return;
    const li = el('li', 'b-row');
    li.classList.toggle('is-active', s.id === act);
    li.append(el('span', 'b-row-mk', s.id === act ? '▸' : ' '));
    li.append(el('span', 'b-row-t', `${s.title}`));
    const msgs = s.messages.filter((m) => m.role !== 0).length;
    li.append(el('span', 'b-row-m', `${s.id} · ${msgs} msgs`));
    const bar = el('div', 'b-row-act');
    const actions = [
      ['OPEN', () => { dom.sessionDlg.d.close(); switchSession(s.id); }, 'b-row-go'],
      ['REN', () => renameInRow(li, s), ''],
      ['MD', () => S.exportMarkdown(s), ''],
      ['JSON', () => S.exportJSON(s), ''],
      ['DEL', () => { dom.sessionDlg.d.close(); const next = S.deleteSession(s.id); if (next) switchSession(next.id); else { S.newSession(); restoreSession(); } }, 'is-danger'],
    ];
    for (const [label, fn, cls] of actions) {
      const b = el('button', cls, label);
      b.type = 'button';
      b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
      bar.append(b);
    }
    li.append(bar);
    dom.sessionList.append(li);
  });
}

function renameInRow(li, s) {
  const titleEl = li.querySelector('.b-row-t');
  if (!titleEl) return; // row is already in rename mode
  const inp = el('input', 'b-filter');
  inp.value = s.title;
  inp.style.width = '100%';
  titleEl.replaceWith(inp);
  inp.focus();
  inp.select();
  const commit = () => { S.renameSession(s.id, inp.value || s.title); renderSessionDlg(''); };
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); commit(); }
    if (ev.key === 'Escape') { ev.stopPropagation(); renderSessionDlg(''); }
  });
  inp.addEventListener('click', (ev) => ev.stopPropagation());
}

// key / settings dialog ----------------------------------------------------
function openKeyDlg() {
  const dlg = makeDialog('b-dlg-key', 'API KEY', 'b-dlg-key');
  if (!dlg.body.querySelector('#b-key-input')) {
    dlg.body.innerHTML = `
      <div class="b-dlg-bar">
        <label class="sr-only" for="b-key-input">OpenRouter API key</label>
        <input id="b-key-input" class="b-filter" type="password" placeholder="sk-or-…  (leave empty for :free via Proxy)" autocomplete="off" spellcheck="false">
        <button type="button" class="b-chip" id="b-key-show">SHOW</button>
        <button type="button" class="b-chip" id="b-key-test">TEST</button>
        <span class="b-test-badge" id="b-key-badge"></span>
      </div>
      <div class="b-lab2">Free models (<code>:free</code>) work without a key via the Proxy. Paid models need your own key.</div>
      <button type="button" class="b-btn is-danger" id="b-key-clear">CLEAR ALL DATA</button>`;
    dlg.foot.textContent = 'the key stays in this browser (localStorage) · esc cancel';
    dom.keyInput = dlg.body.querySelector('#b-key-input');
    dom.keyBadge = dlg.body.querySelector('#b-key-badge');
    dlg.body.querySelector('#b-key-show').addEventListener('click', (ev) => {
      const show = dom.keyInput.type === 'password';
      dom.keyInput.type = show ? 'text' : 'password';
      ev.target.textContent = show ? 'HIDE' : 'SHOW';
    });
    dlg.body.querySelector('#b-key-test').addEventListener('click', async () => {
      commitKey(dom.keyInput.value);
      dom.keyBadge.textContent = '…';
      dom.keyBadge.className = 'b-test-badge';
      try {
        const r = await fetch('https://openrouter.ai/api/v1/key', {
          headers: { Authorization: `Bearer ${settings.key}` },
        });
        dom.keyBadge.textContent = r.ok ? 'VALID ✓' : 'INVALID ✗';
        dom.keyBadge.className = `b-test-badge ${r.ok ? 'ok' : 'bad'}`;
      } catch {
        dom.keyBadge.textContent = 'INVALID ✗';
        dom.keyBadge.className = 'b-test-badge bad';
      }
    });
    dlg.body.querySelector('#b-key-clear').addEventListener('click', () => {
      if (!confirm('Wipe sessions, settings, and model selection from this browser?')) return;
      S.clearAllData();
      location.reload();
    });
    dom.keyInput.addEventListener('change', () => commitKey(dom.keyInput.value));
    dom.keyDlg = dlg;
  }
  dom.keyInput.value = settings.key || '';
  if (!dom.keyDlg.d.open) dom.keyDlg.d.showModal();
  dom.keyInput.focus();
}

// ── wiring ───────────────────────────────────────────────────────────────
function wire() {
  dom.input.addEventListener('input', () => { blip(880, 0.03); paint(); });
  dom.input.addEventListener('focus', () => dom.prompt.classList.add('is-focus'));
  dom.input.addEventListener('blur', () => dom.prompt.classList.remove('is-focus'));
  dom.prompt.addEventListener('submit', (ev) => { ev.preventDefault(); submitLine(); });
  dom.send.addEventListener('click', submitLine);
  dom.prompt.addEventListener('click', (ev) => {
    if (ev.target.closest('button')) return;
    dom.input.focus();
  });

  dom.input.addEventListener('keydown', (ev) => {
    const sugOpen = !dom.sug.hidden && state.sugItems.length > 0;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      submitLine();
    } else if (ev.key === 'Tab') {
      if (isCmdMode()) {
        ev.preventDefault();
        if (dom.input.value.replace(/^:/, '').trim() === '') printCommandList();
        else if (sugOpen) complete(state.sugItems[state.sugIdx]?.name ?? state.sugItems[0].name);
        else { state.sugIdx = -1; updateSuggestions(); }
      }
    } else if (ev.key === 'ArrowDown') {
      if (sugOpen) { ev.preventDefault(); moveSug(1); } else { ev.preventDefault(); historyStep(1); }
    } else if (ev.key === 'ArrowUp') {
      if (sugOpen) { ev.preventDefault(); moveSug(-1); } else { ev.preventDefault(); historyStep(-1); }
    } else if (ev.key === 'Escape') {
      if (isCmdMode()) {
        ev.preventDefault();
        dom.input.value = '';
        paint();
      }
    } else if (ev.key === 'F1') {
      ev.preventDefault();
      openKeys();
    } else if (ev.key === '?' && dom.input.value === '') {
      ev.preventDefault();
      openKeys();
    } else if (ev.key.toLowerCase() === 'l' && ev.ctrlKey && !ev.metaKey) {
      ev.preventDefault();
      clearCmd();
      blip(560, 0.03);
    } else if (ev.key.toLowerCase() === 'c' && ev.ctrlKey && !ev.metaKey) {
      ev.preventDefault();
      const had = dom.input.value;
      dom.input.value = '';
      paint();
      if (had) add(el('div', 'b-l b-dim', '^C'));
    }
  });

  dom.status.addEventListener('click', (ev) => {
    const seg = ev.target.closest('.b-seg[data-cmd]');
    if (!seg) return;
    const cmd = seg.dataset.cmd;
    if (cmd === 'mem') {
      execLine(':mem');
      dom.input.focus({ preventScroll: true });
      return;
    }
    if (cmd === 'key') { openKeyDlg(); return; }
    if (cmd === 'model') { openModel(); return; }
    if (cmd === 'preset') { openPreset(); return; }
    if (cmd === 'session') { openSession(); return; }
  });

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!dom.shell.contains(t) || t.closest('a, button, summary, input, textarea, [role="option"], dialog')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    dom.input.focus({ preventScroll: true });
  });

  const setVH = () => {
    const vv = window.visualViewport;
    if (vv) {
      // Only track the visual viewport when the on-screen keyboard has taken a big bite
      // out of it — otherwise pinch-zoom would shrink the terminal shell.
      if (window.innerHeight - vv.height > 100) dom.shell.style.setProperty('--b-vh', `${Math.round(vv.height)}px`);
      else dom.shell.style.removeProperty('--b-vh');
    }
    if (narrow() !== state.narrow) { state.narrow = narrow(); paint(); }
  };
  setVH();
  window.visualViewport?.addEventListener('resize', setVH);
  window.addEventListener('resize', setVH);
  if (window.matchMedia('(pointer: fine)').matches) dom.input.focus({ preventScroll: true });
}

// ── boot ─────────────────────────────────────────────────────────────────
function catalogError() {
  const body = el('div');
  body.append(el('div', 'b-l b-err', 'MODEL CATALOG UNREACHABLE — the engine is running but the OpenRouter catalog could not be loaded.'));
  const retry = el('button', 'b-btn', 'RETRY SYNC');
  retry.type = 'button';
  retry.addEventListener('click', async () => {
    retry.textContent = 'SYNCING…';
    try {
      await loadCatalog();
      add(el('div', 'b-l b-ok', 'catalog synced.'));
      live('Catalog synced');
      updateStatus();
    } catch {
      retry.textContent = 'RETRY SYNC';
      live('Catalog sync failed', 'assertive');
    }
  });
  body.append(retry);
  add(frame({ title: 'CATALOG ERROR', body, foot: 'check network / proxy' }));
  live('Model catalog unreachable', 'assertive');
}

async function boot() {
  banner();
  sessionHeader();
  try {
    await loadCatalog();
  } catch {
    catalogError();
    updateStatus();
    return;
  }
  updateStatus();
  restoreSession();
  live('Boot complete — ready');
}

// ── start ────────────────────────────────────────────────────────────────
applyCrt();
wire();
paint();
updateStatus();

(async () => {
  try {
    await initEngine();
  } catch (e) {
    errorLine(`ENGINE FAILED — ${String(e).slice(0, 300)}`);
    const retry = el('button', 'b-btn', 'RETRY');
    retry.type = 'button';
    retry.addEventListener('click', () => location.reload());
    const body = el('div');
    body.append(el('div', 'b-l b-dim', 'reload the page to retry engine init.'), retry);
    add(frame({ title: 'ENGINE ERROR', body, foot: 'wasm init failed' }));
    live('Engine failed to load', 'assertive');
    return;
  }
  await boot();
})();

window.__asm = window.__asm || {};
window.__asm.history = historyMessages;
