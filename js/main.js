// main.js — boot, orchestration, HUD, inspector, audio, settings, sidebar.

import { initEngine, eng, memBuf, send, stop, streaming, appendHistory,
  clearHistory, historyMessages, renderDrain, resetRender } from './bridge.js';
import { loadCatalog, openCombobox, getActiveModel, visibleModel } from './models.js';
import { renderMarkdown, highlightCode, addCopyButtons, renderFinal } from './markdown.js';
import { webSearch } from './search.js';
import * as S from './sessions.js';

const $ = (sel) => document.querySelector(sel);

// ── audio ───────────────────────────────────────────────────────────────
let audioCtx = null;
function beep(freq, ms, gain = 0.03, type = 'square', when = 0) {
  const s = settings.crt;
  if (!s || !s.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime + when;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.connect(g).connect(audioCtx.destination);
    o.start(t); o.stop(t + ms / 1000 + 0.02);
  } catch {}
}
const sfxKey = () => beep(880, 30);
const sfxDone = () => beep(220, 140, 0.04);
const sfxTool = () => { beep(440, 70, 0.04); beep(440, 70, 0.04, 'square', 0.12); };

// ── settings & CRT toggles ──────────────────────────────────────────────
let settings = S.loadSettings();

function applyCrt() {
  const c = settings.crt || {};
  document.body.classList.toggle('crt-scan', !!c.scan);
  document.body.classList.toggle('crt-curve', !!c.curve);
  document.body.classList.toggle('crt-flicker', !!c.flicker);
  const map = [['btn-scan', 'scan'], ['btn-curve', 'curve'], ['btn-flicker', 'flicker'], ['btn-sound', 'sound']];
  for (const [id, k] of map) {
    const el = document.getElementById(id);
    el?.classList.toggle('on', !!c[k]);
    if (el) el.setAttribute('aria-pressed', String(!!c[k]));
  }
}
function toggleCrt(k) {
  settings.crt = settings.crt || {};
  settings.crt[k] = !settings.crt[k];
  S.saveSettings(settings);
  applyCrt();
}
for (const [id, k] of [['btn-scan', 'scan'], ['btn-curve', 'curve'], ['btn-flicker', 'flicker'], ['btn-sound', 'sound']])
  $(`#${id}`)?.addEventListener('click', () => toggleCrt(k));

// ── boot overlay ────────────────────────────────────────────────────────
const BOOT = [
  'ASM::AGENT BIOS v1.0 — PHOSPHOR AMBER',
  'MEM CHECK ......... 1024KB OK',
  'WAT KERNEL ........ LOADED [0x0000-0xFFFFF]',
  'OPENROUTER LINK ... ESTABLISHED',
  'CATALOG SYNC ...... {n} MODELS',
  'SESSION STORE ..... MOUNTED',
  'BOOT COMPLETE — TYPE YOUR QUERY',
];

async function boot() {
  const pre = $('#boot-lines');
  const overlay = $('#boot-overlay');
  let catalogCount = '…';
  const catalogPromise = loadCatalog()
    .then((n) => { catalogCount = n; return n; })
    .catch((e) => { catalogCount = 'FAILED'; throw e; });

  for (let i = 0; i < BOOT.length; i++) {
    let line = BOOT[i];
    if (line.includes('{n}')) {
      try { await catalogPromise; } catch {}
      line = line.replace('{n}', catalogCount === 'FAILED' ? 'FAILED — SEE RETRY CARD' : String(catalogCount));
    }
    pre.textContent += line + '\n';
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
  }
  await new Promise((r) => setTimeout(r, 350));
  overlay.classList.add('fade');
  setTimeout(() => overlay.remove(), 700);

  if (catalogCount === 'FAILED') catalogErrorCard();
  else {
    refreshModelButton();
    restoreSession();
  }
}

function catalogErrorCard() {
  const card = document.createElement('div');
  card.className = 'msg error';
  card.innerHTML = `<div class="msg-head">SYSTEM</div>
    <div class="msg-body">MODEL CATALOG UNREACHABLE — the engine is running but the OpenRouter catalog could not be loaded.
    <button class="side-btn primary" style="margin-top:8px">RETRY SYNC</button></div>`;
  card.querySelector('button').addEventListener('click', async (ev) => {
    ev.target.textContent = 'SYNCING…';
    try { await loadCatalog(); card.remove(); refreshModelButton(); restoreSession(); }
    catch { ev.target.textContent = 'RETRY SYNC'; }
  });
  $('#messages').appendChild(card);
}

// ── HUD telemetry ───────────────────────────────────────────────────────
const STATS = new Int32Array(8);
const STAT_NAMES = ['IDLE', 'STREAM', 'DONE', 'ERR'];
let lastTok = 0, lastT = performance.now();

setInterval(() => {
  const E = eng(); if (!E) return;
  const tmp = E.scratch() + 0xF000;
  E.memstats(tmp);
  const dv = new DataView(memBuf(), tmp, 32);
  for (let i = 0; i < 8; i++) STATS[i] = dv.getInt32(i * 4, true);
  const now = performance.now();
  const dt = (now - lastT) / 1000;
  const rate = dt > 0 ? Math.max(0, (STATS[6] - lastTok) / dt) : 0;
  lastTok = STATS[6]; lastT = now;
  $('#telemetry').textContent =
    `MEM ${(STATS[2] / 1024) | 0}KB · MSG ${STATS[1]} · TOK/S ${rate.toFixed(1)} · STATE ${STAT_NAMES[STATS[0]] || '?'}`;
  updateMemoryBars();
}, 500);

// ── inspector ───────────────────────────────────────────────────────────
$('#btn-inspector')?.addEventListener('click', () => {
  const insp = $('#inspector');
  insp.hidden = !insp.hidden;
  if (!insp.hidden) loadInspector();
});
$('#btn-insp-close')?.addEventListener('click', () => { $('#inspector').hidden = true; });
document.querySelectorAll('.insp-tab[data-tab]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.insp-tab[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    $('#insp-source').hidden = b.dataset.tab !== 'source';
    $('#insp-memory').hidden = b.dataset.tab !== 'memory';
    if (b.dataset.tab === 'source') loadWatListing();
  });
});

const WAT_KW = /\b(module|memory|func|param|result|local|global|block|loop|br_if|br|if|then|else|return|call|call_indirect|i32|i64|f32|f64|data|export|import|select|drop|memory\.fill|memory\.copy|memory\.grow|memory\.size)\b/g;

async function loadWatListing() {
  const pre = $('#wat-listing');
  if (pre.dataset.loaded) return;
  try {
    const txt = await (await fetch('src/agent.wat')).text();
    const esc = txt.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const html = esc.split('\n').map((line, i) => {
      let h = line
        .replace(/("[^"]*")/g, '<span class="str">$1</span>')
        .replace(WAT_KW, '<span class="kw">$1</span>');
      return `<span class="ln">${String(i + 1).padStart(4)}</span>${h}`;
    }).join('\n');
    pre.innerHTML = html;
    pre.dataset.loaded = '1';
  } catch {
    pre.textContent = 'agent.wat unavailable';
  }
}

function loadInspector() { loadWatListing(); buildMemoryBars(); }

function buildMemoryBars() {
  const el = $('#insp-memory');
  if (el.dataset.built) return;
  el.innerHTML = '';
  for (const [name, note] of [
    ['HEAP', 'bump allocator from 0x90000 (cap 16 MiB)'],
    ['HISTORY', '96 KiB arena 0x8000-0x1FFFF'],
    ['POOL', '96 KiB model strings 0x28000-0x3FFFF'],
    ['RENDER', '128 KiB pending markdown 0x50000-0x6FFFF'],
    ['MODELS', 'records, max 512'],
  ]) {
    const row = document.createElement('div');
    row.className = 'mem-row';
    row.innerHTML = `<div class="mem-label"><span>${name}</span><span class="mem-val"></span></div>
      <div class="mem-bar"><div class="mem-fill"></div></div><div class="mem-note">${note}</div>`;
    row.dataset.name = name;
    el.appendChild(row);
  }
  el.dataset.built = '1';
}

function updateMemoryBars() {
  const el = $('#insp-memory');
  if (el.hidden || !el.dataset.built) return;
  const E = eng();
  const dv = new DataView(memBuf());
  const heapBump = dv.getInt32(0x20, true);
  const histBump = dv.getInt32(0x10, true);
  const poolBump = dv.getInt32(0x1C, true);
  const rendLen = dv.getInt32(0x14, true);
  const modCnt = dv.getInt32(0x18, true);
  const vals = {
    HEAP: [heapBump - 0x90000, 16 * 1024 * 1024, `${(((heapBump - 0x90000) / 1024) | 0)}KB`],
    HISTORY: [histBump - 0x8000, 96 * 1024, `${histBump - 0x8000}B`],
    POOL: [poolBump - 0x28000, 96 * 1024, `${poolBump - 0x28000}B`],
    RENDER: [rendLen, 128 * 1024, `${rendLen}B`],
    MODELS: [modCnt * 128, 512 * 128, `${modCnt}/512`],
  };
  for (const row of el.querySelectorAll('.mem-row')) {
    const [used, cap, label] = vals[row.dataset.name];
    row.querySelector('.mem-fill').style.width = `${Math.min(100, (used / cap) * 100).toFixed(1)}%`;
    row.querySelector('.mem-val').textContent = label;
  }
}

// ── settings modal ──────────────────────────────────────────────────────
let settingsModal = null;

$('#btn-settings')?.addEventListener('click', () => {
  if (!settingsModal) settingsModal = buildSettings();
  settingsModal.hidden = false;
});

function buildSettings() {
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="modal">
      <div class="model-head"><span class="modal-title">SETTINGS</span>
        <button class="icon-btn set-close" aria-label="Close Settings"><span aria-hidden="true">✕</span></button></div>
      <div class="set-field">
        <label for="set-api-key">OPENROUTER API KEY — Optional for Free Models</label>
        <div class="set-row">
          <input id="set-api-key" type="password" class="set-key" placeholder="sk-or-…  (leave empty for :free via Proxy)" style="flex:1">
          <button class="side-btn set-show">SHOW</button>
          <button class="side-btn primary set-test">TEST</button>
          <span class="test-badge"></span>
        </div>
        <div class="set-hint" style="font-size:11px;opacity:.7;margin-top:4px">Free models (<code>:free</code>) work without a key via the Proxy. Paid models need your own key.</div>
      </div>
      <div class="set-field"><label>CRT</label>
        <div class="set-crt-row">
          <button class="pill crt-t" data-k="scan">SCAN</button>
          <button class="pill crt-t" data-k="curve">CURVE</button>
          <button class="pill crt-t" data-k="flicker">FLICKER</button>
          <button class="pill crt-t" data-k="sound">SOUND</button>
        </div>
      </div>
      <button class="side-btn stop set-clear">CLEAR ALL DATA</button>
    </div>`;
  document.body.appendChild(el);

  const load = () => {
    settings = S.loadSettings();
    el.querySelector('.set-key').value = settings.key || '';
    el.querySelectorAll('.crt-t').forEach((b) => b.classList.toggle('on', !!settings.crt?.[b.dataset.k]));
  };
  load();

  const save = () => {
    settings.key = el.querySelector('.set-key').value.trim();
    S.saveSettings(settings);
    // Q12 B: if Anonymous, ensure active model is Free and button reflects it
    try { if (!settings.key) getActiveModel(); } catch {}
    try { refreshModelButton(); } catch {}
  };
  el.querySelector('.set-key').addEventListener('change', save);

  el.querySelector('.set-show').addEventListener('click', (ev) => {
    const inp = el.querySelector('.set-key');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    ev.target.textContent = show ? 'HIDE' : 'SHOW';
  });

  el.querySelector('.set-test').addEventListener('click', async (ev) => {
    save();
    const badge = el.querySelector('.test-badge');
    badge.textContent = '…'; badge.className = 'test-badge';
    try {
      const r = await fetch('https://openrouter.ai/api/v1/key', {
        headers: { Authorization: `Bearer ${settings.key}` },
      });
      badge.textContent = r.ok ? 'VALID ✓' : 'INVALID ✗';
      badge.className = `test-badge ${r.ok ? 'ok' : 'bad'}`;
    } catch {
      badge.textContent = 'INVALID ✗'; badge.className = 'test-badge bad';
    }
  });

  el.querySelectorAll('.crt-t').forEach((b) => b.addEventListener('click', () => {
    toggleCrt(b.dataset.k); save();
    el.querySelectorAll('.crt-t').forEach((x) => x.classList.toggle('on', !!settings.crt?.[x.dataset.k]));
  }));

  el.querySelector('.set-clear').addEventListener('click', () => {
    if (!confirm('Wipe sessions, settings, and model selection from this browser?')) return;
    S.clearAllData();
    location.reload();
  });

  el.querySelector('.set-close').addEventListener('click', () => { save(); el.hidden = true; });
  el.addEventListener('mousedown', (ev) => { if (ev.target === el) { save(); el.hidden = true; } });
  return el;
}

// ── messages ────────────────────────────────────────────────────────────
const messagesEl = $('#messages');
let pinned = true;
messagesEl.addEventListener('scroll', () => {
  pinned = messagesEl.scrollTop + messagesEl.clientHeight >= messagesEl.scrollHeight - 40;
});
const scrollDown = () => { if (pinned) messagesEl.scrollTop = messagesEl.scrollHeight; };

function addMsg(role, head) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = `<div class="msg-head">${head}</div><div class="msg-body"></div>`;
  messagesEl.appendChild(el);
  scrollDown();
  return el.querySelector('.msg-body');
}

function addUserMsg(text) {
  const body = addMsg('user', 'OPERATOR ▸');
  body.textContent = text;
}

function addErrorCard(text) {
  const body = addMsg('error', 'ERROR');
  body.textContent = text;
}


// tool accordion card — grouped by Source weight, per-Source collapsible headers (ADR 0005)
function addToolCard(name, args) {
  const card = document.createElement('div');
  card.className = 'tool-card';
  card.innerHTML = `
    <div class="tool-head" role="button" tabindex="0" aria-expanded="true"><span>▶ ${name}(${JSON.stringify(args)})</span><span class="tool-status"><span class="tool-spin">▖▘▝▗</span> SEARCHING…</span></div>
    <div class="tool-body"></div>`;
  {
    const head = card.querySelector('.tool-head');
    const syncHead = () => head.setAttribute('aria-expanded', String(!card.classList.contains('collapsed')));
    const toggleHead = () => { card.classList.toggle('collapsed'); syncHead(); };
    head.addEventListener('click', toggleHead);
    head.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleHead(); }
    });
    syncHead();
  }
  messagesEl.appendChild(card);
  scrollDown();
  return {
    card,
    done(result) {
      const st = card.querySelector('.tool-status');
      const bodyEl = card.querySelector('.tool-body');
      if (result.sources === 0) {
        st.textContent = `FAILED: ${(result.failures || []).join(', ') || 'no sources'}`;
      } else {
        st.textContent = `${result.sources} SOURCES${result.failures?.length ? ` · MISSED: ${result.failures.join(',')}` : ''}`;
      }
      bodyEl.innerHTML = '';
      // Grouped rendering when perSource present (13-source fan-out)
      if (result.perSource && result.perSource.length) {
        const msMap = new Map(result.perSource.map((ps) => [ps.tag, ps.ms]));
        const groups = [];
        let cur = null;
        for (const block of result.markdown.split(/(?=### \[)/)) {
          const m = block.match(/^### \[([^\]]+)\] (.+)\n(\S*)\n?([\s\S]*)$/);
          if (!m) continue;
          const tag = m[1];
          if (!cur || cur.tag !== tag) {
            cur = { tag, ms: msMap.get(tag) ?? 0, hits: [] };
            groups.push(cur);
          }
          cur.hits.push({ title: m[2], url: m[3], snippet: m[4] });
        }
        if (!groups.length && result.sources === 0) {
          bodyEl.innerHTML = `<div style="color:var(--err);padding:8px;">No sources returned. <code>failures: [${(result.failures || []).join(', ')}]</code></div>`;
        } else {
          for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            const grp = document.createElement('div');
            grp.className = 'src-group';
            const head = document.createElement('div');
            head.className = 'src-head' + (i > 1 ? ' collapsed' : '');
            head.setAttribute('role', 'button');
            head.setAttribute('tabindex', '0');
            head.setAttribute('aria-expanded', String(!(i > 1)));
            head.innerHTML = `<span class="arrow">▼</span> ${g.tag} · ${g.hits.length} hit${g.hits.length === 1 ? '' : 's'} <span class="ms">· ${g.ms}ms</span>`;
            const body = document.createElement('div');
            body.className = 'src-body' + (i > 1 ? ' collapsed' : '');
            for (const h of g.hits) {
              const div = document.createElement('div');
              div.className = 'tool-src';
              const titleDiv = document.createElement('div');
              titleDiv.className = 'hit-title';
              titleDiv.style.color = 'var(--amber-bright)';
              titleDiv.style.fontSize = '13px';
              titleDiv.style.marginBottom = '2px';
              titleDiv.textContent = h.title;
              div.appendChild(titleDiv);
              const tagSpan = document.createElement('span');
              tagSpan.className = 'tag';
              tagSpan.textContent = `[${g.tag}]`;
              div.appendChild(tagSpan);
              if (h.url) {
                div.appendChild(document.createTextNode(' '));
                const aEl = document.createElement('a');
                aEl.href = h.url;
                aEl.target = '_blank';
                aEl.rel = 'noopener';
                aEl.textContent = h.url;
                div.appendChild(aEl);
              }
              const snippetDiv = document.createElement('div');
              snippetDiv.className = 'snippet';
              snippetDiv.textContent = h.snippet.slice(0, 220);
              div.appendChild(snippetDiv);
              body.appendChild(div);
            }
            {
              const sync = () => head.setAttribute('aria-expanded', String(!head.classList.contains('collapsed')));
              const toggle = () => { head.classList.toggle('collapsed'); body.classList.toggle('collapsed'); sync(); };
              head.addEventListener('click', toggle);
              head.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
              });
            }
            grp.appendChild(head);
            grp.appendChild(body);
            bodyEl.appendChild(grp);
          }
        }
      } else {
        for (const block of result.markdown.split(/(?=### \[)/)) {
          const m = block.match(/^### \[([^\]]+)\] (.+)\n(\S*)\n?([\s\S]*)$/);
          if (!m) continue;
          const div = document.createElement('div');
          div.className = 'tool-src';
          const a = m[3] ? `<a href="${m[3]}" target="_blank" rel="noopener">${m[3]}</a>` : '';
          div.innerHTML = `<span class="tag">${m[1]}</span>${a}<div class="snippet"></div>`;
          div.querySelector('.snippet').textContent = m[4].slice(0, 220);
          bodyEl.appendChild(div);
        }
      }
      card.classList.add('collapsed');
      const head = card.querySelector('.tool-head');
      if (head) head.setAttribute('aria-expanded', String(!card.classList.contains('collapsed')));
    },
  };
}

// ── composer & send ─────────────────────────────────────────────────────
const input = $('#input');
const btnSend = $('#btn-send');
const btnStop = $('#btn-stop');

input.addEventListener('input', () => {
  sfxKey();
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
});
input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); doSend(); }
});
btnSend.addEventListener('click', doSend);
btnStop.addEventListener('click', () => stop());

$('#btn-model')?.addEventListener('click', () => {
  openCombobox((id) => refreshModelButton());
});

function refreshModelButton() {
  const id = getActiveModel();
  $('#btn-model').textContent = `MODEL: ${id || '—'}`;
  const hint = $('#model-hint');
  try {
    const E = eng();
    const cnt = E.models_filter(0, E.scratch(), 0);
    for (let i = 0; i < cnt; i++) {
      const m = visibleModel(i);
      if (m.id === id) {
        hint.textContent = `${m.name.slice(0, 34)}`;
        return;
      }
    }
  } catch {}
  hint.textContent = '';
}

let busy = false;
function setBusy(b) {
  busy = b;
  btnSend.disabled = b;
  btnStop.hidden = !b;
}
async function doSend() {
  if (busy || streaming()) return;
  const text = input.value.trim();
  if (!text) return;
  const key = settings.key;
  const model = getActiveModel();
  if (!model) { addErrorCard('NO MODEL — open the catalog and select one.'); return; }
  const isFree = model.endsWith(':free');
  if (!key && !isFree) {
    addErrorCard('This model needs your own key — open SET and add sk-or-… Anonymous users can use any :free model.');
    return;
  }

  input.value = '';
  input.style.height = 'auto';
  addUserMsg(text);
  setBusy(true);

  let body = null, acc = '', raf = 0, toolCards = [];
  // A tool-only round streams no prose; drop its placeholder rather than
  // leaving an empty AGENT bubble above the tool card.
  const dropIfEmpty = () => {
    if (body && !body.textContent.trim()) body.closest('.msg')?.remove();
  };
  const paint = () => {
    raf = 0;
    if (!body) return;
    renderMarkdown(body, acc);
    body.classList.add('cursor-blink');
    highlightCode(body);
    scrollDown();
  };

  await send(text, {
    onRoundStart() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      dropIfEmpty();
      body = addMsg('assistant', 'AGENT ▸');
      acc = '';
      toolCards = [];
      window.__toolCards = toolCards;
      resetRender();
      renderDrain();
    },
    onDelta(d) {
      acc += d;
      if (!raf) raf = requestAnimationFrame(paint);
    },
    onToolStart(name, args) {
      sfxTool();
      const card = addToolCard(name, args);
      card._done = false;
      toolCards.push(card);
      window.__toolCard = card;
      window.__toolCards = toolCards;
    },
    onToolDone(name, result) {
      const card = toolCards.find((c) => !c._done) || toolCards[toolCards.length - 1];
      if (card) {
        card.done(result);
        card._done = true;
      }
      if (toolCards.every((c) => c._done)) window.__toolCard = null;
    },
    onRoundFinal(text) {
      if (!body) body = addMsg('assistant', 'AGENT ▸');
      renderFinal(body, text);
    },
    onAborted() {
      addErrorCard('STREAM ABORTED');
    },
    onError(msg) {
      addErrorCard(msg);
    },
    onDone() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      dropIfEmpty();
      body?.classList.remove('cursor-blink');
      sfxDone();
      setBusy(false);
      renderSidebar();
    },
  }, { key, model });
  renderSidebar();
}

// ── sessions sidebar ────────────────────────────────────────────────────
function renderSidebar() {
  const listEl = $('#session-list');
  const list = S.loadSessions();
  const act = S.activeId();
  listEl.innerHTML = '';
  for (const s of list) {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === act ? ' on' : '');
    const titleBtn = document.createElement('button');
    titleBtn.className = 'session-title-btn';
    titleBtn.textContent = s.title;
    titleBtn.setAttribute('aria-label', s.title);
    if (s.id === act) titleBtn.setAttribute('aria-current', 'true');
    titleBtn.addEventListener('click', () => switchSession(s.id));
    const actions = document.createElement('div');
    actions.className = 'session-actions';
    actions.innerHTML = `<button data-a="rename">RENAME</button><button data-a="md">EXPORT MD</button><button data-a="json">EXPORT JSON</button><button data-a="del">DELETE</button>`;
    actions.addEventListener('click', (ev) => {
      const a = ev.target.dataset?.a;
      if (!a) return;
      if (a === 'md') S.exportMarkdown(s);
      else if (a === 'json') S.exportJSON(s);
      else if (a === 'del') {
        const next = S.deleteSession(s.id);
        if (next) switchSession(next.id);
        else { S.newSession(); location.reload(); }
      } else if (a === 'rename') {
        const inp = document.createElement('input');
        inp.className = 'session-rename';
        inp.value = s.title;
        titleBtn.replaceWith(inp);
        inp.focus(); inp.select();
        const commit = () => { S.renameSession(s.id, inp.value || s.title); renderSidebar(); };
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') renderSidebar();
        });
        inp.addEventListener('blur', commit);
      }
    });
    item.append(titleBtn, actions);
    listEl.appendChild(item);
  }
}

function switchSession(id) {
  if (busy || streaming()) return;
  S.setActiveId(id);
  restoreSession();
}

function restoreSession() {
  clearHistory();
  messagesEl.innerHTML = '';
  let s = S.getActive();
  if (!s) s = S.newSession();
  for (const m of s.messages) {
    appendHistory(m.role, m.content, { tool_call_id: m.tool_call_id, name: m.name, args: m.args });
    if (m.role === 1) addUserMsg(m.content);
    else if (m.role === 2 && m.content) renderFinal(addMsg('assistant', 'AGENT ▸'), m.content);
    else if (m.role === 3) {
      const card = addToolCard(m.name || 'web_search', { query: '(restored)' });
      card.done({ sources: 1, failures: [], markdown: m.content.slice(0, 4000) });
    }
  }
  $('#sysprompt-text').value = s.system || '';
  renderSidebar();
}

$('#btn-new-chat')?.addEventListener('click', () => {
  if (busy || streaming()) return;
  S.newSession();
  restoreSession();
});

// system prompt drawer
$('#btn-sysprompt')?.addEventListener('click', () => {
  const p = $('#sysprompt-panel');
  p.hidden = !p.hidden;
});
{
  const presets = $('#preset-btns');
  for (const name of Object.keys(S.PRESETS)) {
    const b = document.createElement('button');
    b.className = 'pill';
    b.textContent = name;
    b.addEventListener('click', () => { $('#sysprompt-text').value = S.PRESETS[name]; });
    presets.appendChild(b);
  }
}
$('#btn-sysprompt-save')?.addEventListener('click', () => {
  const s = S.getActive(); if (!s) return;
  const text = $('#sysprompt-text').value.trim() || S.PRESETS['BASIC AGENT'];
  const guessed = Object.entries(S.PRESETS).find(([, v]) => v === text)?.[0] || 'CUSTOM';
  S.setSystemPrompt(s.id, guessed, text);
  // replay wasm history with the new system message
  const msgs = historyMessages();
  clearHistory();
  msgs[0] = { role: 0, content: text, tool_call_id: '', name: '', args: '' };
  for (const m of msgs) appendHistory(m.role, m.content, m);
  $('#sysprompt-panel').hidden = true;
});

// sidebar collapse via brand button — a11y: aria-expanded + keyboard (native button handles Enter/Space)
{
  const brand = document.querySelector('.brand');
  const sidebar = document.getElementById('sidebar');
  const syncExpanded = () => {
    if (!brand || !sidebar) return;
    const expanded = !sidebar.classList.contains('collapsed');
    brand.setAttribute('aria-expanded', String(expanded));
  };
  const toggleSidebar = () => {
    if (!sidebar) return;
    sidebar.classList.toggle('collapsed');
    syncExpanded();
  };
  brand?.addEventListener('click', toggleSidebar);
  // init aria-expanded to match initial state
  syncExpanded();
}
// ── start ───────────────────────────────────────────────────────────────
(async () => {
  applyCrt();
  try {
    await initEngine();
  } catch (e) {
    document.getElementById('boot-lines').textContent += `\nENGINE FAIL — ${e}`;
    return;
  }
  await boot();
})();

// debug surface
window.__asm = window.__asm || {};
window.__asm.search = webSearch;
window.__asm.history = historyMessages;
