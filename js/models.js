// models.js — OpenRouter catalog, rank maps, TLV serialize, combobox UI.
// Catalog: /api/v1/models (default) + two sorted variants for rank maps.

import { eng, memBuf, u8, str } from './bridge.js';

const API = 'https://openrouter.ai/api/v1';
const MASKS = { ALL: 0, FREE: 1, VISION: 2, REASONING: 4, TOOLS: 8, 'CTX≥128K': 16, 'TPS TOP-20': 32 };
const SORTS = ['PRICE', 'CONTEXT', 'LATENCY', 'THROUGHPUT', 'LATEST'];
// default direction per metric: price asc, context desc, latency asc, tps desc(rank asc), latest desc
const DEFAULT_DESC = [0, 1, 0, 0, 1];

let catalog = []; // JS-side mirror for default-model logic
const isAnon = () => { try { const s = JSON.parse(localStorage['asm.settings'] || '{}'); return !s.key; } catch { return true; } };

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function fetchWithRetry(url) {
  try { return await fetchJson(url); }
  catch { await new Promise((r) => setTimeout(r, 2000)); return fetchJson(url); }
}

/** Fetch catalog + rank maps, serialize TLV, load into wasm. Returns count. */
export async function loadCatalog() {
  const [base, byLat, byTps] = await Promise.all([
    fetchWithRetry(`${API}/models`),
    fetchWithRetry(`${API}/models?sort=latency-low-to-high`).catch(() => ({ data: [] })),
    fetchWithRetry(`${API}/models?sort=throughput-high-to-low`).catch(() => ({ data: [] })),
  ]);

  const latRank = new Map((byLat?.data || []).map((m, i) => [m.id, i + 1]));
  const tpsRank = new Map((byTps?.data || []).map((m, i) => [m.id, i + 1]));

  catalog = (base?.data || []).map((m) => {
    const pp = parseFloat(m?.pricing?.prompt || '0') || 0;
    const pc = parseFloat(m?.pricing?.completion || '0') || 0;
    const mod = m?.architecture?.input_modalities || [];
    const params = m?.supported_parameters || [];
    return {
      id: m.id || '',
      name: m.name || m.id || '',
      ctx: m.context_length || 0,
      created: m.created || 0,
      pp: pp * 1e6, pc: pc * 1e6,
      free: String(m?.pricing?.prompt || '') === '0' && String(m?.pricing?.completion || '') === '0',
      vision: mod.includes('image'),
      reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
      tools: params.includes('tools'),
      lat: latRank.get(m.id) || 0,
      tps: tpsRank.get(m.id) || 0,
    };
  });

  const blob = serializeTLV(catalog);
  const E = eng();
  const S = E.scratch();
  new Uint8Array(memBuf(), S, blob.length).set(blob);
  return E.models_load(S, blob.length);
}

function serializeTLV(models) {
  const parts = [];
  const cnt = new Uint8Array(4);
  new DataView(cnt.buffer).setUint32(0, models.length, true);
  parts.push(cnt);
  const u16 = (v) => new Uint8Array([v & 255, (v >> 8) & 255]);
  const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
  const f64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return b; };
  const txt = (s) => { const b = new TextEncoder().encode(String(s)); const out = [u16(b.length), b]; return out; };
  for (const m of models) {
    parts.push(new Uint8Array([1]), ...txt(m.id));
    parts.push(new Uint8Array([2]), ...txt(m.name));
    parts.push(new Uint8Array([3]), u32(m.ctx));
    parts.push(new Uint8Array([4]), u32(m.created));
    parts.push(new Uint8Array([5]), f64(m.pp));
    parts.push(new Uint8Array([6]), f64(m.pc));
    parts.push(new Uint8Array([7]), u32((m.free ? 1 : 0) | (m.vision ? 2 : 0) | (m.reasoning ? 4 : 0) | (m.tools ? 8 : 0)));
    parts.push(new Uint8Array([8]), u32(m.lat));
    parts.push(new Uint8Array([9]), u32(m.tps));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Read one wasm model record by visible index. */
export function visibleModel(i) {
  const E = eng();
  const a = E.models_visible_rec(i);
  const dv = new DataView(memBuf(), a, 56);
  return {
    id: str(dv.getInt32(0, true), dv.getInt32(4, true)),
    name: str(dv.getInt32(8, true), dv.getInt32(12, true)),
    ctx: dv.getInt32(16, true),
    created: dv.getInt32(20, true),
    pp: dv.getFloat64(24, true),
    pc: dv.getFloat64(32, true),
    lat: dv.getInt32(40, true),
    tps: dv.getInt32(44, true),
    flags: dv.getInt32(48, true),
  };
}

export function applyView(metric, desc, mask, query) {
  const E = eng();
  const q = new TextEncoder().encode(query || '');
  const S = E.scratch();
  new Uint8Array(memBuf(), S, q.length).set(q);
  E.models_sort(metric, desc);
  return E.models_filter(mask, S, q.length);
}

export const humanCtx = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
export const money = (v) => v === 0 ? 'FREE' : `$${v >= 10 ? v.toFixed(1) : v.toFixed(2)}/1M`;

// ── selection ───────────────────────────────────────────────────────────
export function defaultModelId() {
  const free = catalog.filter((m) => m.free && m.created);
  const pool = free.length ? free : catalog;
  if (!pool.length) return '';
  return pool.reduce((a, b) => (b.created > a.created ? b : a)).id;
}

export function getActiveModel() {
  const saved = localStorage['asm.activeModel'];
  // Q12 B: Anonymous users see only Free Models — force free if saved is paid
  if (isAnon() && saved) {
    const hit = catalog.find((m) => m.id === saved);
    if (hit && !hit.free && !saved.endsWith(':free')) {
      const freeId = defaultModelId();
      if (freeId) { localStorage['asm.activeModel'] = freeId; return freeId; }
    }
    // still allow if anon but saved is free
    if (saved && catalog.some((m) => m.id === saved && (m.free || saved.endsWith(':free')))) return saved;
    return defaultModelId();
  }
  if (saved && catalog.some((m) => m.id === saved)) return saved;
  return defaultModelId();
}

export function setActiveModel(id) { localStorage['asm.activeModel'] = id; }

// ── combobox modal ──────────────────────────────────────────────────────
let modal = null;
let state = { metric: 4, desc: 1, mask: 0, query: '', active: 0 };
let onSelect = null;

export function openCombobox(cb) {
  onSelect = cb;
  if (!modal) modal = buildModal();
  // Q12 B: default to FREE filter for Anonymous Users
  if (isAnon()) state.mask = 1;
  state.query = '';
  state.active = 0;
  modal.querySelector('.model-search input').value = '';
  refresh();
  modal.hidden = false;
  modal.querySelector('.model-search input').focus();
}

export function closeCombobox() { if (modal) modal.hidden = true; }

function buildModal() {
  const el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.innerHTML = `
    <div class="modal model-modal">
      <div class="model-head">
        <span class="modal-title">MODEL CATALOG</span>
        <button class="icon-btn model-close" aria-label="Close Model Catalog">ESC</button>
      </div>
      <div class="model-search"><input id="model-search-input" placeholder="SEARCH MODEL…" spellcheck="false" aria-label="Search models"></div>
      <div class="model-pills"></div>
      <div class="model-sorts"></div>
      <div class="model-count"></div>
      <div class="model-list" tabindex="0" role="region" aria-label="Model list"></div>
    </div>`;
  document.body.appendChild(el);

  const input = el.querySelector('.model-search input');
  let t = null;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { state.query = input.value; state.active = 0; refresh(); }, 120);
  });

  const pills = el.querySelector('.model-pills');
  for (const [name, mask] of Object.entries(MASKS)) {
    const b = document.createElement('button');
    b.className = 'pill';
    b.textContent = name;
    b.dataset.mask = mask;
    b.addEventListener('click', () => {
      // Q12 B: Anonymous Users locked to FREE
      if (isAnon() && mask !== 1 && mask !== 0) {
        // allow ALL (0) to toggle back? No — force FREE for anon
        state.mask = 1;
      } else if (isAnon() && mask === 0) {
        state.mask = 1;
      } else {
        state.mask = mask;
      }
      state.active = 0; refresh();
    });
    pills.appendChild(b);
  }

  const sorts = el.querySelector('.model-sorts');
  SORTS.forEach((name, i) => {
    const b = document.createElement('button');
    b.className = 'sort-btn';
    b.textContent = name;
    b.dataset.metric = i;
    b.addEventListener('click', () => {
      if (state.metric === i) state.desc = state.desc ? 0 : 1;
      else { state.metric = i; state.desc = DEFAULT_DESC[i]; }
      state.active = 0;
      refresh();
    });
    sorts.appendChild(b);
  });
  const dir = document.createElement('button');
  dir.className = 'sort-btn dir-btn';
  dir.textContent = '▲/▼';
  dir.title = 'toggle direction';
  dir.addEventListener('click', () => { state.desc = state.desc ? 0 : 1; refresh(); });
  sorts.appendChild(dir);

  el.querySelector('.model-close').addEventListener('click', closeCombobox);
  el.addEventListener('mousedown', (ev) => { if (ev.target === el) closeCombobox(); });

  const list = el.querySelector('.model-list');
  list.addEventListener('keydown', (ev) => {
    const rows = list.querySelectorAll('.model-row');
    if (ev.key === 'ArrowDown') { state.active = Math.min(state.active + 1, rows.length - 1); ev.preventDefault(); highlight(rows); }
    else if (ev.key === 'ArrowUp') { state.active = Math.max(state.active - 1, 0); ev.preventDefault(); highlight(rows); }
    else if (ev.key === 'Enter') { rows[state.active]?.click(); }
  });
  el.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeCombobox(); });

  function highlight(rows) {
    rows.forEach((r, i) => r.classList.toggle('active', i === state.active));
    rows[state.active]?.scrollIntoView({ block: 'nearest' });
  }
  el._highlight = highlight;
  return el;
}

function refresh() {
  if (!modal) return;
  const n = applyView(state.metric, state.desc, state.mask, state.query);
  const list = modal.querySelector('.model-list');
  const count = modal.querySelector('.model-count');
  const activeId = localStorage['asm.activeModel'];

  modal.querySelectorAll('.pill').forEach((p) =>
    p.classList.toggle('on', Number(p.dataset.mask) === state.mask));
  modal.querySelectorAll('.sort-btn[data-metric]').forEach((b) => {
    const on = Number(b.dataset.metric) === state.metric;
    b.classList.toggle('on', on);
    b.textContent = SORTS[Number(b.dataset.metric)] + (on ? (state.desc ? ' ▼' : ' ▲') : '');
  });

  count.textContent = `${n} / ${catalog.length} MODELS`;

  const frag = document.createDocumentFragment();
  const max = Math.min(n, 400);
  for (let i = 0; i < max; i++) {
    const m = visibleModel(i);
    const row = document.createElement('div');
    row.className = 'model-row' + (m.id === activeId ? ' selected' : '') + (i === state.active ? ' active' : '');
    row.dataset.i = i;
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-label', m.name);
    row.setAttribute('aria-pressed', String(m.id === activeId));
    const badges = [
      m.flags & 1 ? 'FREE' : '', m.flags & 2 ? 'VISION' : '', m.flags & 4 ? 'REASON' : '', m.flags & 8 ? 'TOOLS' : '',
    ].filter(Boolean).map((b) => `<span class="badge">${b}</span>`).join(' ');
    const ranks = [
      m.lat > 0 ? `#${m.lat} LAT` : '', m.tps > 0 ? `#${m.tps} TPS` : '',
    ].filter(Boolean).map((b) => `<span class="rank-badge">${b}</span>`).join(' ');
    row.innerHTML = `
      <div class="mr-main">
        <span class="mr-name">${escapeHtml(m.name)}</span>
        <span class="mr-meta">${humanCtx(m.ctx)} · ${!(m.pp > 0) && !(m.pc > 0) ? 'FREE' : `${money(Math.max(0, m.pp))} in · ${money(Math.max(0, m.pc))} out`} ${badges} ${ranks}</span>
      </div>
      <div class="mr-provider">${escapeHtml(m.id.split('/')[0] || '')}</div>`;
    row.addEventListener('click', () => {
      setActiveModel(m.id);
      onSelect?.(m.id, m);
      closeCombobox();
    });
    row.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); row.click(); }
    });
    frag.appendChild(row);
  }
  if (n > max) {
    const more = document.createElement('div');
    more.className = 'model-more';
    more.textContent = `… ${n - max} more — refine the search`;
    frag.appendChild(more);
  }
  list.replaceChildren(frag);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
