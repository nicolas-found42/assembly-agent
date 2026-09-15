// models.js — OpenRouter catalog, rank maps, TLV serialize, catalog queries.
// Catalog: /api/v1/models (default) + two sorted variants for rank maps.
// The picker UI lives in js/main.js (Command Line dialog); this module is the
// data + wasm sort/filter surface only. The chosen model is per-chat state and
// lives in a chat record (js/store.js) — this module holds no selection state.

import { eng, memBuf, str } from './bridge.js';

const API = 'https://openrouter.ai/api/v1';
export const MASKS = { ALL: 0, FREE: 1, VISION: 2, REASONING: 4, TOOLS: 8, 'CTX≥128K': 16, 'TPS TOP-20': 32 };
export const SORTS = ['PRICE', 'CONTEXT', 'LATENCY', 'THROUGHPUT', 'LATEST'];
// default direction per metric: price asc, context desc, latency asc, tps desc(rank asc), latest desc.
// The picker's initial order is LATEST desc (metric 4, desc 1): the required "Newest" initial sort.
export const DEFAULT_DESC = [0, 1, 0, 0, 1];

let catalog = []; // JS-side mirror of the records loaded into wasm
let catalogCount = 0;

// Capacity of the wasm model region (see MEMORY MAP in src/agent.wat): 512
// records, staged through the 64 KiB JS scratch area.
const MAX_RECORDS = 512;
const SCRATCH_CAP = 0x10000;

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

  return loadCatalogFromRecords(toRecords(base?.data || [], latRank, tpsRank));
}

/** Map OpenRouter /models entries to catalog records. */
function toRecords(data, latRank, tpsRank) {
  return data.map((m) => {
    const pp = parseFloat(m?.pricing?.prompt || '0') || 0;
    const pc = parseFloat(m?.pricing?.completion || '0') || 0;
    const mod = m?.architecture?.input_modalities || [];
    const out = m?.architecture?.output_modalities;
    const params = m?.supported_parameters || [];
    return {
      id: m.id || '',
      name: m.name || m.id || '',
      ctx: m.context_length || 0,
      created: m.created || 0,
      pp: pp * 1e6, pc: pc * 1e6,
      free: String(m?.pricing?.prompt || '') === '0' && String(m?.pricing?.completion || '') === '0',
      vision: mod.includes('image'),
      // text output: a missing/empty output_modalities counts as text (back-compat)
      textOut: !Array.isArray(out) || out.length === 0 ? true : out.includes('text'),
      reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
      tools: params.includes('tools'),
      lat: latRank.get(m.id) || 0,
      tps: tpsRank.get(m.id) || 0,
    };
  });
}

/** Serialize records, stage them into the wasm region, and return the count
 *  actually loaded. Network-free entry point; loadCatalog() feeds it. */
export function loadCatalogFromRecords(records) {
  const all = records || [];
  const blob = serializeTLV(all);
  const E = eng();
  const S = E.scratch();
  new Uint8Array(memBuf(), S, blob.length).set(blob);
  catalogCount = E.models_load(S, blob.length);
  catalog = all.slice(0, catalogCount);
  return catalogCount;
}

export const catalogSize = () => catalogCount;

/** Serialize the longest loadable prefix of `models` as TLV bytes: encoding
 *  stops at the wasm 512-record cap and when the next record would not fit the
 *  64 KiB scratch area. The count header matches what was written, so the wasm
 *  load returns the count actually loaded. */
function serializeTLV(models) {
  const u16 = (v) => new Uint8Array([v & 255, (v >> 8) & 255]);
  const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
  const f64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return b; };
  const txt = (s) => { const b = new TextEncoder().encode(String(s)); return [u16(b.length), b]; };
  const rec = (m) => [
    new Uint8Array([1]), ...txt(m.id),
    new Uint8Array([2]), ...txt(m.name),
    new Uint8Array([3]), u32(m.ctx),
    new Uint8Array([4]), u32(m.created),
    new Uint8Array([5]), f64(m.pp),
    new Uint8Array([6]), f64(m.pc),
    new Uint8Array([7]), u32((m.free ? 1 : 0) | (m.vision ? 2 : 0) | (m.reasoning ? 4 : 0) | (m.tools ? 8 : 0) | (m.textOut === false ? 0 : 16)),
    new Uint8Array([8]), u32(m.lat),
    new Uint8Array([9]), u32(m.tps),
  ];
  const cnt = new Uint8Array(4);
  const parts = [cnt];
  let size = 4;
  let n = 0;
  for (const m of models) {
    if (n >= MAX_RECORDS) break;
    const r = rec(m);
    const bytes = r.reduce((t, p) => t + p.length, 0);
    if (size + bytes > SCRATCH_CAP) break;
    size += bytes;
    n++;
    for (const p of r) parts.push(p);
  }
  new DataView(cnt.buffer).setUint32(0, n, true);
  const out = new Uint8Array(size);
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
    textOut: (dv.getInt32(48, true) & 16) !== 0,
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

// ── catalog queries ─────────────────────────────────────────────────────
/** Read-only copy of the JS-side mirror of the loaded catalog. */
export const catalogList = () => catalog.map((m) => ({ ...m }));

/** Newest free text model id, or '' when the loaded catalog has none. Never
 *  returns a paid model. Candidates must be free, priced ':free', and produce
 *  text. Picks the greatest `created`; ties break on the lexicographically
 *  greater id. Records without `created` (0) sort last. */
export function newestFreeModelId() {
  let best = null;
  for (const m of catalog) {
    if (!m.free || !m.id.endsWith(':free') || m.textOut === false) continue;
    if (!best || m.created > best.created || (m.created === best.created && m.id > best.id)) best = m;
  }
  return best ? best.id : '';
}
