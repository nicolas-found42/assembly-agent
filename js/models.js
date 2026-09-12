// models.js — OpenRouter catalog, rank maps, TLV serialize, selection.
// Catalog: /api/v1/models (default) + two sorted variants for rank maps.
// The picker UI lives in js/main.js (Command Line dialog); this module is the
// data + wasm sort/filter surface only.

import { eng, memBuf, str } from './bridge.js';

const API = 'https://openrouter.ai/api/v1';
export const MASKS = { ALL: 0, FREE: 1, VISION: 2, REASONING: 4, TOOLS: 8, 'CTX≥128K': 16, 'TPS TOP-20': 32 };
export const SORTS = ['PRICE', 'CONTEXT', 'LATENCY', 'THROUGHPUT', 'LATEST'];
// default direction per metric: price asc, context desc, latency asc, tps desc(rank asc), latest desc
export const DEFAULT_DESC = [0, 1, 0, 0, 1];

let catalog = []; // JS-side mirror for default-model logic
let catalogCount = 0;

const isAnon = () => { try { const s = JSON.parse(localStorage['asm.settings'] || '{}'); return !s.key; } catch { return true; } };
export const isAnonUser = isAnon;

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
  catalogCount = E.models_load(S, blob.length);
  return catalogCount;
}

export const catalogSize = () => catalogCount;

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

/** Sort + filter the wasm catalog; returns the visible count. */
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
  // Anonymous users see only Free Models — force free if saved is paid
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
