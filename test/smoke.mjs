// ASM::AGENT engine smoke tests — node ≥18, no network.
// Instantiates dist/agent.wasm and asserts the full export surface.
import { readFileSync } from 'node:fs';

const wasm = readFileSync(new URL('../dist/agent.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, {});
const e = instance.exports;
const mem = e.memory;
const SCRATCH = e.scratch();
const enc = new TextEncoder();
const dec = new TextDecoder();

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log('ok  :', msg);
  else { console.error('FAIL:', msg); failures++; }
};

const u8 = (ptr, len) => new Uint8Array(mem.buffer, ptr, len);
const str = (ptr, len) => dec.decode(u8(ptr, len));
const dv = () => new DataView(mem.buffer);
const i32 = (ptr) => dv().getInt32(ptr, true);
const u32 = (ptr) => dv().getUint32(ptr, true);
function putScratch(bytes, off = 0) { u8(SCRATCH + off, bytes.length).set(bytes); }
function putStr(s, off = 0) { putScratch(enc.encode(s), off); }
const len = (s) => enc.encode(s).length;

// ── 1. init + MAGIC ────────────────────────────────────────────────────
e.init();
ok(u32(0) === 0x41534d31, 'MAGIC == 0x41534D31 ("ASM1")');

// ── 2. heap_alloc: monotonic, non-overlap, grows memory ────────────────
{
  const pages0 = mem.buffer.byteLength / 65536;
  let prev = -1, good = true;
  for (let i = 0; i < 160; i++) {
    const p = e.heap_alloc(4096);
    if (p === 0 || p <= prev) good = false;
    prev = p;
  }
  const pages1 = mem.buffer.byteLength / 65536;
  ok(good, 'heap_alloc monotonic non-overlap');
  ok(pages1 > pages0, `memory grew ${pages0} -> ${pages1} pages`);
}

// ── 3. history roundtrip incl. tool meta ───────────────────────────────
{
  putStr('You are terse.', 0);
  putStr('What is WAT?', 2048);
  putStr('call_xyz', 4096);
  putStr('web_search', 6144);
  putStr('{"query":"wat"}', 8192);
  e.history_append(0, SCRATCH, len('You are terse.'), 0, 0, 0, 0, 0, 0);
  e.history_append(1, SCRATCH + 2048, len('What is WAT?'), 0, 0, 0, 0, 0, 0);
  e.history_append(2, SCRATCH, 0, SCRATCH + 4096, len('call_xyz'),
    SCRATCH + 6144, len('web_search'), SCRATCH + 8192, len('{"query":"wat"}'));
  ok(e.history_count() === 3, 'history_count == 3');

  const out = SCRATCH + 0xF000;
  e.history_get(2, out);
  ok(i32(out) === 2, 'entry 2 role == assistant');
  ok(str(i32(out + 4), i32(out + 8)) === '', 'entry 2 content empty');
  ok(str(i32(out + 12), i32(out + 16)) === 'call_xyz', 'entry 2 tcid roundtrip');
  ok(str(i32(out + 20), i32(out + 24)) === 'web_search', 'entry 2 name roundtrip');
  ok(str(i32(out + 28), i32(out + 32)) === '{"query":"wat"}', 'entry 2 args roundtrip');

  e.history_get(1, out);
  ok(str(i32(out + 4), i32(out + 8)) === 'What is WAT?', 'entry 1 content roundtrip');

  e.history_clear();
  ok(e.history_count() === 0, 'history_clear resets count');
}

// ── 4. TLV models_load + sort + filter ─────────────────────────────────
{
  const MODELS = [
    { id: 'aaa/free',  name: 'Free Model', ctx: 8192,    created: 100, pp: 0,    pc: 0,    flags: 1,  lat: 0, tps: 0 },
    { id: 'bbb/big',   name: 'Big Model',  ctx: 1048576, created: 300, pp: 1.5,  pc: 6,    flags: 10, lat: 2, tps: 3 },
    { id: 'ccc/mid',   name: 'Mid Model',  ctx: 131072,  created: 200, pp: 0.25, pc: 1,    flags: 4,  lat: 1, tps: 19 },
  ];
  const blob = [];
  const u32b = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return [...b]; };
  const u16b = (v) => [v & 255, (v >> 8) & 255];
  const f64b = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); return [...b]; };
  const strb = (s) => { const b = enc.encode(s); return [...u16b(b.length), ...b]; };
  blob.push(...u32b(MODELS.length));
  for (const m of MODELS)
    blob.push(1, ...strb(m.id), 2, ...strb(m.name), 3, ...u32b(m.ctx), 4, ...u32b(m.created),
      5, ...f64b(m.pp), 6, ...f64b(m.pc), 7, ...u32b(m.flags), 8, ...u32b(m.lat), 9, ...u32b(m.tps));
  putScratch(Uint8Array.from(blob));
  const n = e.models_load(SCRATCH, blob.length);
  ok(n === 3, `models_load returned 3 (got ${n})`);

  e.models_sort(1, 1); // context desc
  let cnt = e.models_filter(0, SCRATCH, 0);
  ok(cnt === 3, 'filter no-mask count 3');
  const rec = (i) => {
    const a = e.models_visible_rec(i);
    return { id: str(i32(a), i32(a + 4)), ctx: i32(a + 16), flags: i32(a + 48), tps: i32(a + 44) };
  };
  ok(rec(0).id === 'bbb/big' && rec(1).id === 'ccc/mid' && rec(2).id === 'aaa/free',
    'context-desc order: big, mid, free');

  cnt = e.models_filter(1, SCRATCH, 0); // FREE pill
  ok(cnt === 1 && rec(0).id === 'aaa/free', 'filter mask=FREE -> aaa/free');

  cnt = e.models_filter(16, SCRATCH, 0); // CTX>=128K
  ok(cnt === 2, 'filter mask=CTX128K -> 2 models');

  cnt = e.models_filter(32, SCRATCH, 0); // TPS top-20
  ok(cnt === 2, 'filter mask=TPS-TOP20 -> 2 models');

  putStr('BIG');
  cnt = e.models_filter(0, SCRATCH, 3);
  ok(cnt === 1 && rec(0).id === 'bbb/big', 'query "BIG" case-fold matches big only');

  putStr('nomatchxyz');
  cnt = e.models_filter(0, SCRATCH, 10);
  ok(cnt === 0, 'query "nomatchxyz" -> 0');

  e.models_sort(0, 0); // price asc
  e.models_filter(0, SCRATCH, 0);
  ok(rec(0).id === 'aaa/free', 'price asc puts free first');
}

// ── 5. SSE stream (a): split mid-JSON + escapes ────────────────────────
{
  e.history_clear();
  e.render_reset();
  e.begin_turn();
  const head = 'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel';
  const tail = 'lo\\nW\\u00f6rld \\u00e9"}}]}\n\n';
  e.sse_feed(SCRATCH, 0); // no-op sanity
  putStr(head);
  e.sse_feed(SCRATCH, len(head));
  ok(e.render_len() === 0, 'partial line buffered, nothing rendered yet');
  putStr(tail);
  e.sse_feed(SCRATCH, len(tail));

  const expected = 'Hello\nWörld é';
  const got = str(e.render_ptr(), e.render_len());
  ok(got === expected, `decoded render == ${JSON.stringify(expected)} (got ${JSON.stringify(got)})`);

  putStr('data: [DONE]\n');
  e.sse_feed(SCRATCH, len('data: [DONE]\n'));
  ok(i32(0x04) === 2, '[DONE] -> state 2');
  e.end_turn();
  ok(i32(0x04) === 0, 'end_turn -> state 0');
  ok(e.history_count() === 1, 'assistant entry finalized');

  const out = SCRATCH + 0xF000;
  e.history_get(0, out);
  ok(str(i32(out + 4), i32(out + 8)) === expected, 'history content matches decoded stream');
}

// ── 6. SSE stream (b): tool_calls deltas across 3 feeds ────────────────
{
  e.history_clear();
  e.render_reset();
  e.begin_turn();
  const f1 = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"web_search","arguments":""}}]}}]}\n\n';
  const f2 = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"qu"}}]}}]}\n\n';
  const f3 = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ery\\": \\"wasm\\"}"}}]}}]}\n\n';

  putStr(f1); e.sse_feed(SCRATCH, len(f1));
  ok(e.tool_pending() === 1, 'tool_pending after id delta');
  ok(str(0x6000, i32(0x30)) === 'call_abc', 'tcid captured');
  ok(str(0x6040, i32(0x34)) === 'web_search', 'tool name captured');

  putStr(f2); e.sse_feed(SCRATCH, len(f2));
  putStr(f3); e.sse_feed(SCRATCH, len(f3));
  const args = str(i32(0x28), i32(0x2C));
  ok(args === '{"query": "wasm"}', `args assembled across feeds (got ${args})`);

  putStr('data: [DONE]\n'); e.sse_feed(SCRATCH, len('data: [DONE]\n'));
  e.end_turn();
  ok(e.tool_pending() === 1, 'tool meta survives end_turn');

  // tool result round trip
  const md = '### [WIKIPEDIA] WebAssembly\nhttps://en.wikipedia.org/wiki/WebAssembly\nsnippet here';
  putStr(md);
  e.tool_result_append(SCRATCH, len(md));
  e.tool_result_flush();
  ok(e.history_count() === 2, 'tool entry appended');

  const out = SCRATCH + 0xF000;
  e.history_get(1, out);
  ok(i32(out) === 3, 'tool entry role 3');
  ok(str(i32(out + 4), i32(out + 8)) === md, 'tool result content roundtrip');
  ok(str(i32(out + 12), i32(out + 16)) === 'call_abc', 'tool entry carries tcid');
}

// ── 7. error event capture ─────────────────────────────────────────────
{
  e.begin_turn();
  const line = 'data: {"error":{"message":"Rate limited","code":429}}\n';
  putStr(line); e.sse_feed(SCRATCH, len(line));
  ok(i32(0x04) === 3, 'error line -> state 3');
  ok(str(e.err_ptr(), e.err_len()) === 'Rate limited', 'error message captured');
}

// ── 8. memstats ────────────────────────────────────────────────────────
{
  const out = SCRATCH + 0xF000;
  e.memstats(out);
  ok(i32(out) === 3 && i32(out + 4) === 2 && i32(out + 16) === 3,
    'memstats: state/msg_count/model_count coherent');
  ok(i32(out + 8) > 0x90000 && i32(out + 24) > 0, 'memstats: heap + tokens nonzero');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
