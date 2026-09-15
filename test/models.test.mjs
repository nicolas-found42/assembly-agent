// models.test.mjs — catalog TLV/serialization, capacity, and free-model selection.
// No network: the catalog is fed straight into the wasm load path through the
// loadCatalogFromRecords() hook, plus one loadCatalog() pass against a fetch
// stub so the architecture.output_modalities -> textOut mapping is covered.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── browser shims (bridge -> search.js/sessions.js touch window+localStorage) ──
globalThis.window = globalThis;
globalThis.location = { origin: 'http://localhost:8000' };
globalThis.document = { createElement: () => ({}), querySelector: () => null, body: { appendChild: () => {} } };
globalThis.localStorage = {};

const WASM = readFileSync(new URL('../dist/agent.wasm', import.meta.url));
globalThis.fetch = async (url) => {
  if (String(url) === 'dist/agent.wasm') return new Response(WASM);
  throw new Error(`unexpected fetch ${url}`);
};

const bridge = await import('../js/bridge.js');
await bridge.initEngine();
const M = await import('../js/models.js');

/** Catalog record: free, ':free', text-output unless overridden. */
const rec = (id, over = {}) => ({
  id, name: id, ctx: 1000, created: 100, pp: 0, pc: 0,
  free: true, vision: false, reasoning: false, tools: false, textOut: true,
  lat: 0, tps: 0, ...over,
});
const findById = (id) => {
  const n = M.applyView(4, M.DEFAULT_DESC[4], 0, '');
  for (let i = 0; i < n; i++) { const m = M.visibleModel(i); if (m.id === id) return m; }
  return null;
};

// ── 1. TLV round-trip: fields intact, flags bit 16 carries textOut ──────
{
  const n = M.loadCatalogFromRecords([
    rec('a/old:free', { created: 5, ctx: 131072, pp: 1e6, pc: 2e6, vision: true }),
    rec('b/new:free', { created: 6, textOut: false }),
  ]);
  assert.equal(n, 2, 'TLV: both records loaded');
  assert.equal(M.catalogSize(), 2, 'TLV: catalogSize matches');

  const nv = M.applyView(4, M.DEFAULT_DESC[4], 0, '');
  assert.equal(nv, 2, 'TLV: filter returns both');
  assert.equal(M.visibleModel(0).id, 'b/new:free',
    'TLV: LATEST desc — the required "Newest" initial sort — puts the newest first');

  const newer = M.visibleModel(0);
  assert.equal(newer.textOut, false, 'TLV: image-only record reports textOut false');
  assert.equal(newer.flags & 16, 0, 'TLV: textOut false leaves bit 16 clear');

  const older = M.visibleModel(1);
  assert.equal(older.textOut, true, 'TLV: text record reports textOut true');
  assert.equal(older.flags & 16, 16, 'TLV: textOut true sets bit 16');
  assert.equal(older.flags & 2, 2, 'TLV: vision bit still packed alongside bit 16');
  assert.equal(older.ctx, 131072, 'TLV: ctx round-trips');
  assert.equal(older.pp, 1e6, 'TLV: prompt price round-trips');
  assert.equal(older.pc, 2e6, 'TLV: completion price round-trips');
  assert.equal(older.created, 5, 'TLV: created round-trips');
  console.log('ok  : TLV round-trip + textOut flag bit 16');
}

// ── 2. loadCatalog(): output_modalities mapping + rank maps ─────────────
{
  const or = (id, created, architecture, pricing = { prompt: '0', completion: '0' }) => ({
    id, name: `Name ${id}`, context_length: 131072, created, pricing,
    architecture, supported_parameters: ['tools'],
  });
  const texts = [
    or('new-model:free', 300, { input_modalities: ['text'], output_modalities: ['text'] }),
    or('img-model:free', 400, { input_modalities: ['image'], output_modalities: ['image'] }),
    or('paid-model', 500, { input_modalities: ['text'], output_modalities: ['text'] },
      { prompt: '0.000001', completion: '0.000002' }),
    or('legacy-free:free', 200, { input_modalities: ['text'] }), // no output_modalities
  ];
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'dist/agent.wasm') return new Response(WASM);
    seen.push(u);
    const body = u.includes('sort=latency') ? { data: [texts[3], texts[0]] }
      : u.includes('sort=throughput') ? { data: [texts[0]] }
        : { data: texts };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };

  assert.equal(await M.loadCatalog(), 4, 'loadCatalog: 4 records loaded');
  assert.equal(seen.length, 3, 'loadCatalog: catalog + both rank-map fetches');

  assert.equal(M.newestFreeModelId(), 'new-model:free',
    'loadCatalog: image-only and paid models are never picked as the free default');
  assert.equal(findById('new-model:free').textOut, true,
    'loadCatalog: output_modalities [text] -> textOut true');
  assert.equal(findById('img-model:free').textOut, false,
    'loadCatalog: output_modalities [image] -> textOut false');
  assert.equal(findById('legacy-free:free').textOut, true,
    'loadCatalog: missing output_modalities counts as text (back-compat)');
  assert.equal(findById('paid-model').flags & 1, 0, 'loadCatalog: paid model is not flagged free');

  const nv = M.applyView(4, M.DEFAULT_DESC[4], 0, '');
  assert.equal(nv, 4, 'loadCatalog: all 4 visible');
  assert.equal(M.visibleModel(0).id, 'paid-model',
    'loadCatalog: initial Newest sort is newest-first across the whole catalog');
  assert.equal(M.visibleModel(1).id, 'img-model:free',
    'loadCatalog: Newest sort ranks by created, not by price');

  assert.equal(findById('legacy-free:free').lat, 1, 'loadCatalog: latency rank map applied');
  assert.equal(findById('new-model:free').lat, 2, 'loadCatalog: latency rank map, 2nd entry');
  assert.equal(findById('new-model:free').tps, 1, 'loadCatalog: throughput rank map applied');
  console.log('ok  : loadCatalog output_modalities mapping + rank maps');
}

// ── 3. newest free wins on greatest created ─────────────────────────────
{
  M.loadCatalogFromRecords([
    rec('old/a:free', { created: 10 }),
    rec('new/b:free', { created: 30 }),
    rec('mid/c:free', { created: 20 }),
  ]);
  assert.equal(M.newestFreeModelId(), 'new/b:free', 'selection: greatest created wins');
  console.log('ok  : newest free model -> greatest created');
}

// ── 4. paid and non-':free' entries are never selected ──────────────────
{
  M.loadCatalogFromRecords([
    rec('paid/z', { free: false, pp: 3e6, pc: 15e6, created: 99 }),
    rec('zero-price/x', { free: true, created: 98 }), // zero price but no ':free' id
    rec('free/y:free', { created: 1 }),
  ]);
  assert.equal(M.newestFreeModelId(), 'free/y:free',
    'selection: paid and non-:free zero-price models are skipped');
  console.log('ok  : paid / non-:free catalog entries never selected');
}

// ── 5. empty free pool -> '' (never a paid model) ───────────────────────
{
  assert.equal(M.loadCatalogFromRecords([]), 0, 'load: empty catalog loads 0');
  assert.equal(M.newestFreeModelId(), '', 'selection: empty catalog -> no default');
  assert.equal(M.catalogSize(), 0, 'load: empty catalog resets the count');

  M.loadCatalogFromRecords([
    rec('paid/a', { free: false, pp: 1e6, pc: 2e6, created: 5 }),
    rec('zero/b', { free: true, created: 6 }),
  ]);
  assert.equal(M.newestFreeModelId(), '', 'selection: no free candidate -> empty string');
  console.log('ok  : empty free pool -> empty string');
}

// ── 6. ties resolve deterministically (lexicographic id) ────────────────
{
  const tied = [rec('aaa/x:free', { created: 7 }), rec('zzz/y:free', { created: 7 }), rec('mmm/z:free', { created: 7 })];
  M.loadCatalogFromRecords(tied);
  assert.equal(M.newestFreeModelId(), 'zzz/y:free', 'selection: created tie -> lexicographically greater id');
  M.loadCatalogFromRecords([...tied].reverse());
  assert.equal(M.newestFreeModelId(), 'zzz/y:free', 'selection: tie-break independent of catalog order');
  console.log('ok  : ties break lexicographically, order-independent');
}

// ── 7. records without created (0) sort last ────────────────────────────
{
  M.loadCatalogFromRecords([
    rec('zero-created:free', { created: 0 }),
    rec('old/low:free', { created: 1 }),
  ]);
  assert.equal(M.newestFreeModelId(), 'old/low:free', 'selection: created 0 sorts last');

  M.loadCatalogFromRecords([rec('b/x:free', { created: 0 }), rec('a/y:free', { created: 0 })]);
  assert.equal(M.newestFreeModelId(), 'b/x:free', 'selection: all-zero created still deterministic');
  console.log('ok  : missing created sorts last');
}

// ── 8. textOut false excluded even when newest and free ─────────────────
{
  M.loadCatalogFromRecords([
    rec('img/only:free', { textOut: false, created: 99 }),
    rec('txt/ok:free', { created: 1 }),
  ]);
  assert.equal(M.newestFreeModelId(), 'txt/ok:free',
    'selection: newest free model must also produce text');
  console.log('ok  : text-less free models excluded');
}

// ── 9. catalogList() is a read-only copy ────────────────────────────────
{
  M.loadCatalogFromRecords([rec('keep/me:free', { created: 42 }), rec('old/one:free', { created: 1 })]);
  const list = M.catalogList();
  assert.equal(list.length, 2, 'catalogList: mirrors the loaded records');
  list[0].created = -1;
  list.pop();
  assert.equal(M.newestFreeModelId(), 'keep/me:free', 'catalogList: mutating the copy does not touch module state');
  console.log('ok  : catalogList() returns a copy');
}

// ── 10. capacity: the wasm region holds 512 records, prefix-loaded ──────
{
  const many = [];
  for (let i = 0; i < 600; i++) many.push(rec(`m${String(i).padStart(3, '0')}/x:free`, { created: i }));
  const n = M.loadCatalogFromRecords(many);
  assert.equal(n, 512, 'capacity: wasm region loads exactly 512 of 600 records');
  assert.equal(M.catalogSize(), 512, 'capacity: catalogSize reports the loaded count');
  assert.equal(M.catalogList().length, 512, 'capacity: the mirror holds only loaded records');
  assert.equal(M.applyView(4, M.DEFAULT_DESC[4], 0, ''), 512, 'capacity: filter walks all 512 loaded');
  assert.equal(M.visibleModel(0).id, 'm511/x:free', 'capacity: newest loaded record is first');
  assert.equal(M.visibleModel(511).id, 'm000/x:free', 'capacity: oldest loaded record is last');
  assert.equal(M.newestFreeModelId(), 'm511/x:free',
    'capacity: selection considers only loaded records, not the dropped tail');

  const mid = M.visibleModel(511 - 300);
  assert.equal(mid.id, 'm300/x:free', 'capacity: records load in order, no shifting');
  assert.equal(mid.created, 300, 'capacity: intact record fields past the load point');
  assert.equal(mid.ctx, 1000, 'capacity: intact ctx past the load point');
  assert.equal(mid.flags & 16, 16, 'capacity: flag bit 16 intact past the load point');

  const ids = new Set();
  for (let i = 0; i < 512; i++) ids.add(M.visibleModel(i).id);
  assert.equal(ids.size, 512, 'capacity: no duplicates or uninitialised slots');
  assert.ok(!ids.has('m599/x:free'), 'capacity: the dropped tail never reaches wasm');
  console.log('ok  : 512-record wasm cap -> prefix load, newest selection bounded');
}

// ── 11. oversized blob truncates by prefix instead of overrunning ───────
{
  const huge = rec('c/z:free', { name: 'n'.repeat(0x10000) });
  const n = M.loadCatalogFromRecords([rec('a/x:free'), rec('b/y:free'), huge]);
  assert.equal(n, 2, 'capacity: a record too large for the 64 KiB staging area is dropped with the rest');
  assert.equal(M.newestFreeModelId(), 'b/y:free', 'capacity: mirror matches the staged prefix');
  console.log('ok  : staging-area overflow truncates the prefix');
}

console.log('ALL MODELS PASS');
