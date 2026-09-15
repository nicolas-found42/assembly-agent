// streams.test.mjs — WAT engine stream contracts (R08.3).
//
// Drives the REAL engine (dist/agent.wasm) through js/bridge.js — the same
// loading path the browser uses: initEngine() -> scratchWrite() -> sse_feed()
// -> renderDrain(). No network, no model calls: every input is either a
// synthetic fixture from test/fixtures/streams/ or a literal built here from
// its decoded text (JSON.stringify puts the escapes on the wire).
//
// Everything pinned below is DERIVED from src/agent.wat (memory map, control
// slots, $decode_inplace, Tool Call Table, capacity constants) and from the
// clients under js/ — no expected ABI value is invented.
//
// Chunk invariance — the core property: equivalent valid streams yield
// equivalent logical results regardless of chunking. One logical stream is
// driven through many chunk sequences (whole stream, 1/2/3/7/13-byte chunks,
// one chunk per line, splits inside tokens, seeded random partitions) and the
// extracted results must be identical. The matrix runs in a CHILD process with
// a hard process-level timeout, because the engine is synchronous: a wasm hang
// would block this process's event loop and no in-process timer could fire.
//
// BOUNDED BEHAVIOUR, NOT TRAPS — the engine answers malformed or excessive
// input with a documented outcome, never a hang or silent corruption. err
// codes below are the WAT's own $cErrCode values:
//   1  "error" event on a data: line -> state 3, message at err_ptr()/err_len()
//   2  history arena (96 KiB) full   -> state 3, the entry is dropped
//   3  SSE line over 16384 B         -> state stays 1, that line is dropped,
//                                       scanning continues after its LF
//   6  heap exhausted (256 pages)    -> the args fragment is dropped
//   (4/5 belong to models_load and are out of the stream scanner's scope.)
// Malformed inputs must return normally: no WebAssembly trap, and the state
// slot stays inside 0..3. An err code is a documented outcome, not a failure.
//
// RUN
//   node --test test/streams.test.mjs                        whole suite
//   STREAMS_SEED=<seed> node --test test/streams.test.mjs    whole suite, other seed
//   STREAMS_SEED=<seed> STREAMS_CHILD=property \
//     STREAMS_REPLAY=<fixture>:<case> node test/streams.test.mjs
//     replays exactly one chunking of one fixture, e.g.
//     STREAMS_SEED=20260914 STREAMS_CHILD=property \
//       STREAMS_REPLAY=tool-parallel:rand-3 node test/streams.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
 REPO_ROOT, loadCorpus, loadFixture, loadFixtures, loadCaptured,
} from './fixtures/streams/load.mjs';

// ── browser shims (bridge -> search.js touches window+localStorage) ──
globalThis.window = globalThis;
globalThis.location = { origin: 'http://localhost:8000' };
globalThis.document = { createElement: () => ({}), querySelector: () => null, body: { appendChild: () => { } } };
globalThis.localStorage = {};

const WASM = readFileSync(new URL('../dist/agent.wasm', import.meta.url));
globalThis.fetch = async (url) => {
 if (String(url) === 'dist/agent.wasm') return new Response(WASM);
 throw new Error(`streams.test: no network allowed (${url})`);
};

const bridge = await import('../js/bridge.js');
const THIS_FILE = fileURLToPath(import.meta.url);

// ── engine ABI constants, read off src/agent.wat ─────────────────────────
// CONTROL SLOTS (i32) — the addresses js/bridge.js also reads directly.
const CTRL = {
 STATE: 0x04, ERR_CODE: 0x08, HEAP_BUMP: 0x20, REM_LEN: 0x24,
 TOOL_ARGS_PTR: 0x28, TOOL_ARGS_LEN: 0x2C, TC_NAME_LEN: 0x34,
 CUR_LEN: 0x3C, TOKENS_OUT: 0x44, RENDER_OVERFLOW: 0x48,
 TC_OVERFLOW: 0x74,
};
const TOOL_TABLE = { MAX: 8, FIELD_CAP: 64 };  // Tool Call Table: 8 slots, id/name clamped to 64 B
const SSE_LINE_CAP = 0x4000;           // remainder line buffer (16 KiB)
const RENDER_CAP = 0x20000;            // pending markdown buffer (128 KiB)
const HISTORY_CAP = 0x20000 - 0x8000;  // 96 KiB history arena
const HEAP_PAGE_CEILING = 256;         // heap_alloc refuses to grow past this
const STATES = new Set([0, 1, 2, 3]);  // idle | stream | done | err

// ── harness ───────────────────────────────────────────────────────────────

const MAX_STAGING = 0x10000;  // bridge.scratchWrite() copies at most 64 KiB

/** A fresh engine through the browser's own loading path. */
async function engine() {
 const e = await bridge.initEngine();
 bridge.resetRender();
 return e;
}

/** The logical result of a turn, read straight out of the engine's memory. */
function extract(e) {
 const dv = new DataView(bridge.memBuf());
 const i32 = (addr) => dv.getInt32(addr, true);
 const count = e.tc_count();
 const out = e.scratch() + 0xF000;
 const calls = [];
 for (let i = 0; i < count; i++) {
  e.tc_get(i, out);
  const o = new DataView(bridge.memBuf(), out, 24);
  calls.push({
   id: bridge.str(o.getInt32(0, true), o.getInt32(4, true)),
   name: bridge.str(o.getInt32(8, true), o.getInt32(12, true)),
   args: bridge.str(o.getInt32(16, true), o.getInt32(20, true)),
  });
 }
 return {
  state: i32(CTRL.STATE),
  errCode: i32(CTRL.ERR_CODE),
  err: bridge.str(e.err_ptr(), e.err_len()),
  remLen: i32(CTRL.REM_LEN),
  render: bridge.str(e.render_ptr(), e.render_len()),
  renderOverflow: i32(CTRL.RENDER_OVERFLOW),
  // tokens_out (0x44) is a GLOBAL counter, never reset per turn, so it is not
  // part of a turn's logical result; restart/reuse asserts it separately.
  content: i32(CTRL.CUR_LEN),
  pending: e.tool_pending(),
  count,
  overflow: i32(CTRL.TC_OVERFLOW),
  calls,
  legacyName: bridge.str(0x6040, i32(CTRL.TC_NAME_LEN)),
  legacyArgs: bridge.str(i32(CTRL.TOOL_ARGS_PTR), i32(CTRL.TOOL_ARGS_LEN)),
 };
}

/**
 * One turn: feed `bytes` split at the chunk lengths in `sizes` (null = the
 * whole stream as one delivery, the reference), then extract the result.
 * A requested chunk larger than the 64 KiB staging area is fed in 64 KiB
 * pieces, exactly like the browser's bridge loop does with 60 KiB pieces.
 */
function feedTurn(e, bytes, sizes = null) {
 e.begin_turn();
 bridge.resetRender();
 const total = bytes.length;
 let off = 0;
 let k = 0;
 while (off < total) {
  let n = Math.min(sizes?.[k] ?? total - off, total - off);
  k += 1;
  while (n > 0) {
   const take = Math.min(n, MAX_STAGING);
   const { ptr, len } = bridge.scratchWrite(bytes.subarray(off, off + take));
   e.sse_feed(ptr, len);
   off += take;
   n -= take;
  }
 }
 return extract(e);
}

const chunksOf = (n, size) => Array.from({ length: Math.ceil(n / size) }, (_, i) => Math.min(size, n - i * size));

/** One chunk per LF-terminated line; the unterminated tail (if any) is last. */
function lineChunks(bytes) {
 const sizes = [];
 for (let i = 0, last = 0; i < bytes.length; i++) {
  if (bytes[i] === 10) { sizes.push(i + 1 - last); last = i + 1; }
 }
 if (sizes.reduce((a, b) => a + b, 0) < bytes.length) sizes.push(bytes.length - sizes.reduce((a, b) => a + b, 0));
 return sizes;
}

/** Deterministic PRNG (mulberry32): same seed -> same partitions forever. */
function mulberry32(seed) {
 let a = seed >>> 0;
 return () => {
  a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 0x10000_0000;
 };
}

const FNV = (s) => {
 let h = 0x811C_9DC5;
 for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x0100_0193); }
 return h >>> 0;
};

// The chunk matrix. Deterministic in (fixture, len, seed): a case label names a
// reproducible boundary list, so a failure is replayable with one command.
const RANDOM_CASES = 8;
const MAX_CHUNK_CALLS = 60_000; // feed-call budget bound per case
const MAX_CASES = 300;          // per-fixture case limit (the corpus today runs 300 cases)

function caseList(bytes, name, seed) {
 const len = bytes.length;
 const out = [{ label: 'single', sizes: [len] }];
 for (const size of [1, 2, 3, 7, 13]) {
  if (Math.ceil(len / size) <= MAX_CHUNK_CALLS) out.push({ label: `every-${size}`, sizes: chunksOf(len, size) });
 }
 out.push({ label: 'lines', sizes: lineChunks(bytes) });
 // splits inside the Scanner's own tokens: the boundary lands mid-token
 for (const token of ['"delta"', '"content"', '"tool_calls"', '"arguments"', '"id"', '"name"']) {
  const pos = bytes.indexOf(token);
  if (pos < 0) continue;
  for (const k of [1, 2, 3]) {
   if (pos + k < len) out.push({ label: `split-${token}@${k}`, sizes: [pos + k, len - pos - k] });
  }
 }
 const rng = mulberry32(FNV(`${seed}:${name}`));
 for (let i = 0; i < RANDOM_CASES; i++) {
  const cuts = 1 + Math.floor(rng() * 12);
  const cutsAt = Array.from({ length: cuts }, () => 1 + Math.floor(rng() * (len - 1))).sort((a, b) => a - b);
  const sizes = [];
  let prev = 0;
  for (const c of cutsAt) { if (c !== prev) { sizes.push(c - prev); prev = c; } }
  if (prev < len) sizes.push(len - prev);
  out.push({ label: `rand-${i}`, sizes });
 }
 return out.slice(0, MAX_CASES);
}

const compact = (sizes) => {
 const s = sizes.map(String).join(',');
 if (s.length <= 120) return `[${s}]`;
 return `[${sizes.slice(0, 24).join(',')}, …${sizes.length} chunks]`;
};

// ── child driver: the seeded chunking matrix ─────────────────────────────
// Spawned by the property test below with STREAMS_CHILD=property. Runs the
// whole matrix (or one STREAMS_REPLAY case) and exits 0/1; the parent asserts
// the exit status, so a wasm hang cannot fake a green run here.
const DEFAULT_SEED = 20260914;

async function propertyChild() {
 const seed = Number(process.env.STREAMS_SEED || DEFAULT_SEED);
 const replay = process.env.STREAMS_REPLAY || '';
 const corpus = loadCorpus();
 let cases = 0;
 let matched = false;
 for (const { name, bytes } of corpus) {
  const list = caseList(bytes, name, seed);
  const chosen = replay ? list.filter((c) => `${name}:${c.label}` === replay) : list;
  if (replay && chosen.length) matched = true;
  for (const c of chosen) {
   // two engines: the reference and the chunked run must not share
   // non-reset state (err code and message are not cleared per turn)
   const ref = feedTurn(await engine(), bytes, null);
   const report = (detail) => {
    console.error(`STREAMS FAILURE seed=${seed} fixture=${name} case=${c.label} sizes=${compact(c.sizes)}`);
    console.error(`replay: STREAMS_SEED=${seed} STREAMS_CHILD=property STREAMS_REPLAY=${name}:${c.label} node test/streams.test.mjs`);
    for (const line of detail) console.error(line);
    process.exit(1);
   };
   let got;
   try {
    got = feedTurn(await engine(), bytes, c.sizes);
   } catch (err) {
    report([`trap while feeding: ${err}`]);
   }
   if (JSON.stringify(got) !== JSON.stringify(ref)) {
    report([`reference: ${JSON.stringify(ref)}`, `chunked:   ${JSON.stringify(got)}`]);
   }
   cases += 1;
  }
 }
 if (replay && !matched) {
  console.error(`STREAMS FAILURE replay target not found: ${replay} (corpus: ${corpus.map((f) => f.name).join(', ')})`);
  process.exit(1);
 }
 console.log(`STREAMS CHILD OK fixtures=${corpus.length} cases=${cases} seed=${seed}${replay ? ` replay=${replay}` : ''}`);
}

// ── suite ─────────────────────────────────────────────────────────────────

if (process.env.STREAMS_CHILD === 'property') {
 await propertyChild();
 process.exit(0);
}

const T = (name, fn) => test(name, { timeout: 30_000 }, fn);
const B = (s) => Buffer.from(s, 'utf8');
const CAPTURED_BYTES = new Map(loadCaptured().map((f) => [f.name, f.bytes]));
const contentLine = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n`;
const callLine = (list) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: list } }] })}\n`;
const opener = (i, id, name, args = '') => ({ index: i, id, type: 'function', function: { name, arguments: args } });
const argFrag = (i, text) => ({ index: i, function: { arguments: text } });

// ── loading path ─────────────────────────────────────────────────────────

T('loading path: dist/agent.wasm has zero imports and the exports js/ calls', async () => {
 const mod = await WebAssembly.compile(WASM);
 assert.deepEqual(WebAssembly.Module.imports(mod), [], 'the module must be self-contained');
 const names = new Set(WebAssembly.Module.exports(mod).map((x) => x.name));
 for (const need of ['init', 'begin_turn', 'sse_feed', 'end_turn', 'tc_count', 'tc_get', 'tool_pending', 'render_ptr', 'render_len', 'render_reset', 'scratch', 'memory']) {
  assert.ok(names.has(need), `missing export ${need}`);
 }
 const e = await engine();
 assert.equal(e.history_count(), 0, 'initEngine clears history');
 assert.equal(typeof e.scratch(), 'number', 'scratch() is an address');
});

T('loading path: the fixtures are synthetic and inert (no URLs, no credentials)', () => {
 const corpus = loadCorpus();
 for (const { name, bytes } of corpus) {
  const text = bytes.toString('utf8');
  assert.ok(!text.includes('http'), `${name}: no URL in a fixture`);
  assert.ok(!text.includes('Bearer'), `${name}: no Authorization in a fixture`);
  assert.ok(!text.includes(['SYNTHETIC', 'SECRET', 'SENTINEL'].join('-')), `${name}: no secret material`);
  assert.ok(text.length > 0 && text.length < 64 * 1024, `${name}: tiny (${text.length} B)`);
 }
 assert.equal(loadFixtures().length, 10, 'the authored corpus is what the suite documents');
 assert.equal(loadCaptured().length, 2, 'both captured streams ride the property corpus');
});

// ── UTF-8 across byte boundaries ─────────────────────────────────────────

T('utf-8: a 4-byte character split across two chunk deliveries decodes once', async () => {
 const e = await engine();
 const text = 'Zig 𝄞!';
 const wire = B(contentLine(text));
 const ref = feedTurn(e, wire);
 assert.equal(ref.render, text, 'the whole delivery is the baseline');
 const seq = Buffer.from('𝄞', 'utf8');
 assert.equal(seq.length, 4, '𝄞 is a 4-byte sequence');
 const at = wire.indexOf(seq); // the byte offset of the sequence
 for (const k of [1, 2, 3]) { // each byte boundary inside the sequence
  const r = feedTurn(e, wire, [at + k]);
  assert.equal(r.render, text, `split ${k} bytes into the sequence`);
  assert.equal(JSON.stringify(r), JSON.stringify(ref), `split inside a 4-byte char at byte ${k}`);
 }
});

T('utf-8: every possible split point of a mixed-width stream yields the same result', async () => {
 const e = await engine();
 const text = 'A𝄞BéC漢D';
 const wire = B(contentLine(text));
 const ref = feedTurn(e, wire);
 for (let cut = 1; cut < wire.length; cut++) {
  const r = feedTurn(e, wire, [cut]);
  assert.equal(JSON.stringify(r), JSON.stringify(ref), `single split at offset ${cut}`);
 }
});

T('utf-8: the text-utf8 fixture renders its characters byte-exact under 1-byte chunking', async () => {
 const e = await engine();
 const bytes = loadFixture('text-utf8');
 const ref = feedTurn(e, bytes);
 const one = feedTurn(e, bytes, chunksOf(bytes.length, 1));
 assert.equal(one.render, ref.render);
 assert.equal(ref.render, 'Zig ⚡ café漢字 𝄞…', 'the fixture decodes to its authored text');
});

// ── SSE line/event variants ──────────────────────────────────────────────

T('sse: \\n and \\r\\n line endings agree on every boundary variant', async () => {
 const e = await engine();
 const lf = B(contentLine('a') + contentLine('b'));
 const crlf = B(contentLine('a').replace(/\n$/, '\r\n') + contentLine('b').replace(/\n$/, '\r\n'));
 assert.equal(JSON.stringify(feedTurn(e, crlf)), JSON.stringify(feedTurn(e, lf)), 'CRLF == LF');
 // a split that leaves the CR alone in one chunk and the LF in the next
 const at = crlf.indexOf('\r\n');
 const r = feedTurn(e, crlf, [at + 1, crlf.length - at - 1]);
 assert.equal(r.render, 'ab', 'a CR in one chunk and its LF in the next still terminates the line');
 assert.equal(JSON.stringify(r), JSON.stringify(feedTurn(e, lf)), 'CRLF split at the CR/LF boundary == LF');
});

T('sse: data: with and without the space after the colon feed the same event', async () => {
 const e = await engine();
 const spaced = feedTurn(e, B(contentLine('x')));
 const tight = feedTurn(e, B(`data:${contentLine('x').slice(6)}`));
 assert.equal(tight.render, 'x', 'data:{...} is accepted');
 assert.equal(JSON.stringify(tight), JSON.stringify(spaced), 'no-space and space forms agree');
});

T('sse: comments, event: lines and blank lines are ignored, scanning continues', async () => {
 const e = await engine();
 const r = feedTurn(e, B(':\n: keep-alive\nevent: ping\n\nid: 7\ndata: junk\n\n'));
 assert.equal(r.render, '', 'nothing is decoded from non-data lines');
 assert.equal(r.state, 1, 'state stays streaming');
 assert.equal(r.errCode, 0, 'no error recorded');
});

T('sse: a missing final newline leaves the last event unprocessed (bounded)', async () => {
 const e = await engine();
 const tail = 'data: {"choices":[{"delta":{"content":"never proce';
 const r = feedTurn(e, B(contentLine('kept') + tail));
 assert.equal(r.render, 'kept', 'terminated events are processed');
 assert.equal(r.remLen, tail.length, 'the unterminated tail stays buffered');
 assert.equal(r.state, 1, 'no error state');
 assert.equal(r.errCode, 0, 'no error code');
});

T('sse: a bare CR is not a line terminator (documented limitation)', async () => {
 const e = await engine();
 const a = 'data: {"choices":[{"delta":{"content":"a"}}]}\r';
 const b = 'data: {"choices":[{"delta":{"content":"b"}}]}\r';
 const held = feedTurn(e, B(a + b));
 assert.equal(held.render, '', 'nothing is processed while no LF arrives');
 assert.equal(held.remLen, (a + b).length, 'both CR lines sit in the remainder buffer');
 assert.equal(held.errCode, 0, 'no error');
 // when an LF finally arrives the merged line is processed: only the first
 // event of the merged line is honoured, and the trailing CR is stripped.
 const merged = feedTurn(e, B(a + b + '\n'));
 assert.equal(merged.render, 'a', 'a CR-merged line yields only its first event');
 assert.equal(merged.remLen, 0, 'the line is consumed');
});

T('sse: data: [DONE] ends the stream with state 2', async () => {
 const e = await engine();
 const r = feedTurn(e, B(contentLine('a') + 'data: [DONE]\n'));
 assert.equal(r.state, 2, '[DONE] -> state 2');
 assert.equal(r.render, 'a', 'content before [DONE] is kept');
 const r2 = feedTurn(e, B('data: x [DONE]\n'));
 assert.equal(r2.state, 1, '[DONE] not at the payload start is not a terminator');
 assert.equal(r2.render, '', 'and its payload is not JSON');
});

// ── JSON escape boundaries ───────────────────────────────────────────────

T('escapes: every 2-byte escape decodes, including hand-written \\/', async () => {
 const e = await engine();
 for (const want of ['a"b', 'c\\d', 'e\nf', 'g\th', 'i\bj', 'k\fl', 'm\ro', 'p\u00e9q']) {
  const r = feedTurn(e, B(contentLine(want)));
  assert.equal(r.render, want, `wire ${JSON.stringify(JSON.stringify(want))} decodes to ${JSON.stringify(want)}`);
 }
 const slash = feedTurn(e, B(contentLine('q/r\\s')));
 assert.equal(slash.render, 'q/r\\s', 'the \\u005c and \\u002f round trip');
 const handSlash = feedTurn(e, B('data: {"choices":[{"delta":{"content":"a\\/b"}}]}\n'));
 assert.equal(handSlash.render, 'a/b', '\\/ is legal JSON the engine decodes although JSON.stringify never emits it');
});

T('escapes: a \\uXXXX escape split across deliveries still decodes', async () => {
 const e = await engine();
 const wire = B(contentLine('é'));
 const ref = feedTurn(e, wire);
 assert.equal(ref.render, 'é');
 for (let cut = 1; cut < wire.length; cut++) {
  const r = feedTurn(e, wire, [cut]);
  assert.equal(r.render, 'é', `\\u00e9 split at offset ${cut}`);
 }
});

T('escapes: a surrogate pair split across deliveries still decodes to one code point', async () => {
 const e = await engine();
 const wire = B(contentLine('😀'));
 const ref = feedTurn(e, wire);
 assert.equal(ref.render, '😀');
 for (let cut = 1; cut < wire.length; cut++) {
  const r = feedTurn(e, wire, [cut]);
  assert.equal(r.render, '😀', `surrogate pair split at offset ${cut}`);
 }
 const halves = feedTurn(e, B(contentLine('\ud83d')));
 assert.equal(halves.render, '\uFFFD', 'a lone high surrogate becomes U+FFFD');
});

T('escapes: the text-escapes fixture decodes to its documented string', async () => {
 const e = await engine();
 const bytes = loadFixture('text-escapes');
 const ref = feedTurn(e, bytes);
 const one = feedTurn(e, bytes, chunksOf(bytes.length, 1));
 assert.equal(one.render, ref.render);
 assert.equal(ref.render, 'a "q" b\\\\ c/d \n \t \b \f \ré漢😀truncated ');
});

T('escapes: a truncated \\uXXXX is bounded — the prefix survives, no error, scan continues', async () => {
 const e = await engine();
 const r = feedTurn(e, B('data: {"choices":[{"delta":{"content":"ok \\u12"}}]}\n' + contentLine('after')));
 assert.equal(r.state, 1, 'no error state');
 assert.equal(r.errCode, 0, 'no error code');
 assert.ok(r.render.startsWith('ok '), `render is ${JSON.stringify(r.render)}`);
 assert.ok(r.render.includes('after'), 'the next line is processed normally');
 assert.ok(!r.render.includes('\uFFFD\uFFFD'), 'no garbage run');
});

T('escapes: a \\uXXXX truncated at the very end of the delivery is bounded, never a hang', async () => {
 const e = await engine();
 // no LF after the escape: the engine stops decoding inside the string and
 // the unterminated tail stays in the remainder buffer — it must return
 const r = feedTurn(e, B('data: {"choices":[{"delta":{"content":"kept \\u1'));
 assert.equal(r.state, 1, 'no error state');
 assert.equal(r.errCode, 0, 'no error code');
 assert.equal(r.render, '', 'nothing was decoded from the unterminated line');
 assert.ok(r.remLen > 0, 'the tail stays buffered for a later delivery');
});

T('escapes: an unknown escape emits the character itself, a trailing lone backslash stops decoding', async () => {
 const e = await engine();
 assert.equal(feedTurn(e, B(contentLine('a\qb'))).render, 'aqb', '\\q -> q');
 assert.equal(feedTurn(e, B(contentLine('tail\\'))).render, 'tail\\', 'the lone backslash survives as a byte');
 assert.equal(feedTurn(e, B(contentLine('after'))).render, 'after', 'the next event is untouched');
});

// ── tool calls: parallel, interleaved, distinct ──────────────────────────

T('tools: the captured two-call stream stages two distinct calls, any chunking', async () => {
 const e = await engine();
 const bytes = CAPTURED_BYTES.get('lfm-2.6b-parallel-toolcalls');
 for (const sizes of [null, chunksOf(bytes.length, 1), lineChunks(bytes), chunksOf(bytes.length, 64)]) {
  const r = feedTurn(e, bytes, sizes);
  assert.equal(r.count, 2, 'two calls staged');
  assert.equal(r.pending, 1, 'tool_pending true');
  assert.deepEqual(r.calls.map((c) => c.name), ['web_search', 'web_search'], 'both names read');
  assert.deepEqual(r.calls.map((c) => c.id),
   ['chatcmpl-tool-b394e6b97a3a92d2', 'chatcmpl-tool-b300b48aaf306311'], 'each call keeps its own id');
  assert.deepEqual(JSON.parse(r.calls[0].args), { query: 'Zig programming language latest stable version official site ziglang.org' });
  assert.deepEqual(JSON.parse(r.calls[1].args), { query: 'Zig 0.15.2 release notes stable version confirmation' });
 }
});

T('tools: the captured single-call stream stages one call and slot 0 aliases the legacy slots', async () => {
 const e = await engine();
 const bytes = CAPTURED_BYTES.get('cohere-north-mini-code-toolcall');
 for (const sizes of [null, chunksOf(bytes.length, 1), lineChunks(bytes)]) {
  const r = feedTurn(e, bytes, sizes);
  assert.equal(r.count, 1, 'exactly one call');
  assert.equal(r.overflow, 0, 'no overflow');
  assert.equal(r.calls[0].id, 'web_search_dvjmkcahfsc6', 'call id read');
  assert.equal(r.calls[0].name, 'web_search', 'call name read');
  assert.deepEqual(JSON.parse(r.calls[0].args), { query: 'Zig programming language current stable version' });
  assert.equal(r.legacyName, r.calls[0].name, 'slot 0 name aliases 0x6040/0x34');
  assert.equal(r.legacyArgs, r.calls[0].args, 'slot 0 args alias 0x28/0x2C');
 }
});

T('tools: the tool-parallel fixture keeps three calls apart under 1-byte chunking', async () => {
 const e = await engine();
 const bytes = loadFixture('tool-parallel');
 const ref = feedTurn(e, bytes);
 const want = [
  { id: 'syn_a', name: 'web_search', args: '{"query": "first"}' },
  { id: 'syn_b', name: 'lookup', args: '{"query": "second"}' },
  { id: 'syn_c', name: 'fetch_page', args: '{"url": "/synthetic/page?x=1"}' },
 ];
 assert.equal(ref.render, 'searching…', 'content on the delta line is rendered');
 assert.deepEqual(ref.calls, want, 'three calls with distinct ids, names and arguments');
 const one = feedTurn(e, bytes, chunksOf(bytes.length, 1));
 assert.deepEqual(one.calls, want, '1-byte chunking stages the same three calls');
 assert.equal(one.overflow, 0, 'no overflow');
});

T('tools: fragments streamed one per line agree with calls packed on one line', async () => {
 const e = await engine();
 const want = [
  { id: 'syn_a', name: 'web_search', args: '{"query": "alpha"}' },
  { id: 'syn_b', name: 'web_search', args: '{"query": "beta"}' },
  { id: 'syn_c', name: 'web_search', args: '{"query": "gamma"}' },
 ];
 const packed = feedTurn(e, B(callLine(want.map((c, i) => opener(i, c.id, c.name, c.args)))));
 const streamed = feedTurn(e, B([
  callLine([opener(0, 'syn_a', 'web_search')]), callLine([argFrag(0, '{"query": "')]), callLine([argFrag(0, 'alpha')]), callLine([argFrag(0, '"}')]),
  callLine([opener(1, 'syn_b', 'web_search')]), callLine([argFrag(1, '{"query": "')]), callLine([argFrag(1, 'beta')]), callLine([argFrag(1, '"}')]),
  callLine([opener(2, 'syn_c', 'web_search')]), callLine([argFrag(2, '{"query": "')]), callLine([argFrag(2, 'gamma')]), callLine([argFrag(2, '"}')]),
 ].join('')));
 assert.deepEqual(packed.calls, want, 'packed: three complete calls on one line');
 assert.deepEqual(streamed.calls, want, 'streamed: one fragment per line');
 assert.deepEqual(JSON.stringify(packed), JSON.stringify(streamed), 'packed and streamed agree');
});

T('tools: slot order is the order of "id":" occurrences, not the index field', async () => {
 const e = await engine();
 const r = feedTurn(e, B(callLine([
  opener(7, 'first', 'web_search', '{"query": "one"}'),
  opener(0, 'second', 'lookup', '{"query": "two"}'),
 ])));
 assert.deepEqual(r.calls.map((c) => c.id), ['first', 'second'], 'slot 0 then slot 1');
 assert.deepEqual(r.calls.map((c) => c.name), ['web_search', 'lookup'], 'each name lands on its own slot');
 assert.deepEqual(r.calls.map((c) => JSON.parse(c.args).query), ['one', 'two'], 'args never mix');
});

T('tools: the Scanner stages what the line carries — the documented interleaving rule', async () => {
 const e = await engine();
 // ADR-0003 / CONTEXT.md: "id":" opens the next slot; "name":" and
 // "arguments":" land on the slot open at that point. Fragments for a slot
 // that arrives AFTER a later id opened are staged on that later slot — the
 // captured streams never interleave, so the rule is asserted as documented.
 const r = feedTurn(e, B([
  callLine([opener(0, 'A', 'web_search', '{"query": "')]),
  callLine([opener(1, 'B', 'web_search', '{"query": "')]),
  callLine([argFrag(0, 'alpha"}')]),
  callLine([argFrag(1, 'beta"}')]),
 ].join('')));
 assert.equal(r.count, 2, 'both calls staged');
 assert.deepEqual(r.calls[0].args, '{"query": "', 'the fragment before the second id stays on slot 0');
 assert.equal(r.calls[1].args, '{"query": "alpha"}beta"}', 'fragments after a later id land on the open slot');
});

T('tools: an empty id opens no slot; args before any id land on slot 0', async () => {
 const e = await engine();
 const empty = feedTurn(e, B(callLine([opener(0, '', 'web_search', '{"query": "e"}')])));
 assert.equal(empty.count, 0, 'an empty id keys no role-3 entry, so it opens nothing');
 assert.equal(empty.pending, 0, 'tool_pending stays false');
 assert.equal(empty.legacyArgs, '{"query": "e"}', 'the arguments still reached slot 0\'s accumulator');
 const first = feedTurn(e, B([
  callLine([argFrag(0, '{"query": "')]),
  callLine([opener(0, 'late', 'web_search', 'x"}')]),
 ].join('')));
 assert.equal(first.count, 1, 'the later id opens slot 0');
 assert.equal(first.calls[0].args, '{"query": "x"}', 'the earlier fragment is already in slot 0');
 const soloName = feedTurn(e, B(callLine([opener(0, 'k', 'web_search')])));
 assert.equal(soloName.calls[0].args, '', 'a call without arguments stages empty args');
});

// ── empty / malformed / incomplete / interruption / restart ──────────────

T('empty input: no render, no calls, no error, nothing buffered', async () => {
 const e = await engine();
 assert.equal(JSON.stringify(feedTurn(e, new Uint8Array(0))), JSON.stringify({
  state: 1, errCode: 0, err: '', remLen: 0, render: '', renderOverflow: 0,
  content: 0, pending: 0, count: 0, overflow: 0, calls: [],
  legacyName: '', legacyArgs: '',
 }));
 const lf = feedTurn(e, B('\n\n\n'));
 assert.equal(lf.render, '', 'LF-only input processes empty lines and renders nothing');
 assert.equal(lf.state, 1, 'still streaming');
});

T('malformed input: junk is ignored and the next valid event still lands', async () => {
 const e = await engine();
 const bytes = loadFixture('malformed');
 const r = feedTurn(e, bytes);
 assert.equal(r.render, 'survivor', 'the valid event is processed');
 assert.equal(r.state, 2, '[DONE] still ends the stream');
 assert.equal(r.errCode, 0, 'no error code');
 assert.equal(r.count, 0, 'nothing staged');
 assert.deepEqual(feedTurn(e, bytes, chunksOf(bytes.length, 1)), r, '1-byte chunking agrees');
});

T('malformed input: a hostile corpus never traps and always reports a legal state', async () => {
 const e = await engine();
 const hostile = [
  ['empty', new Uint8Array(0)],
  ['NUL', Uint8Array.of(0)],
  ['invalid utf-8', Uint8Array.of(0xff, 0xfe, 0xc0, 0x80)],
  ['unterminated json', B('data: {"choices":[{"delta":{"content":"unterminated\n')],
  ['unbalanced braces', B('data: {"choices":[{"delta":{"content":"}}}]"}}]}\n')],
  ['deep nesting', B('data: {"a":' + '['.repeat(512) + ']' + '\n')],
  ['lone surrogate on the wire', B('data: {"choices":[{"delta":{"content":"\\ud800"}}]}\n')],
  ['json with no delta and no tool_calls', B('data: {"a":' + '1'.repeat(256) + '\n')],
  ['error without message', B('data: {"error":{"code":500}}\n')],
  ['error with an unclosed message', B('data: {"error":"message":"unclosed\n')],
  ['data: x [DONE]', B('data: x [DONE]\n')],
  ['no prefix', B('x')],
  ['empty payload', B('data:   \n')],
 ];
 for (const [label, bytes] of hostile) {
  let r;
  assert.doesNotThrow(() => { r = feedTurn(e, bytes); }, `hostile: ${label} must not trap`);
  assert.ok(STATES.has(r.state), `hostile: ${label} -> state stays legal, got ${r.state}`);
  assert.ok(Number.isInteger(r.errCode), `hostile: ${label} -> errCode is an integer, got ${r.errCode}`);
 }
});

T('malformed input: an error event without a message is still a documented state 3', async () => {
 const e = await engine();
 const r = feedTurn(e, B('data: {"error":{"code":500}}\n'));
 assert.equal(r.state, 3, 'state 3');
 assert.equal(r.errCode, 1, 'error-event err code');
 assert.equal(r.err, '', 'no message captured');
 assert.equal(r.render, '', 'nothing rendered');
});

T('interruption: end_turn on a partial delivery finalizes nothing extra, next turn is clean', async () => {
 const e = await engine();
 const r1 = feedTurn(e, B('data: {"choices":[{"delta":{"content":"le"'));
 assert.equal(r1.render, '', 'nothing rendered while the line is unterminated');
 assert.ok(r1.remLen > 0, 'the tail stays buffered');
 e.end_turn(); // the bridge's abort path: end_turn then stop feeding
 const base = e.history_count(); // the aborted turn still finalizes one entry
 const r2 = feedTurn(e, B('ak"}}]}\ndata: {"choices":[{"delta":{"content":"fresh"}}]}\n'));
 assert.equal(r2.remLen, 0, 'begin_turn dropped the stale remainder');
 assert.equal(r2.render, 'fresh', 'the abandoned fragment did not resurface');
 e.end_turn();
 assert.equal(e.history_count(), base + 1, 'exactly one more entry for the new turn');
 assert.equal(bridge.historyMessages().at(-1).content, 'fresh', 'the new turn stored only its own content');
 assert.equal(bridge.historyMessages().at(-1).role, 2, 'stored as assistant');
 assert.equal(e.tc_count(), 0, 'the tool table is cleared between turns');
});
T('restart/reuse: consecutive turns share nothing (render, table, counters)', async () => {
 const e = await engine();
 const tok = () => new DataView(bridge.memBuf()).getInt32(CTRL.TOKENS_OUT, true);
 const a = feedTurn(e, B(callLine([opener(0, 'ta', 'web_search', '{"query": "one"}')]) + contentLine('alpha')));
 assert.equal(a.render, 'alpha', 'turn A rendered only its own content');
 assert.equal(a.count, 1, 'turn A staged its call');
 assert.equal(a.overflow, 0, 'turn A counted no overflow');
 const tokA = tok();
 const b = feedTurn(e, B(contentLine('beta')));
 assert.equal(b.render, 'beta', 'turn B renders only turn B');
 assert.equal(b.count, 0, 'begin_turn cleared the table');
 assert.equal(b.overflow, 0, 'begin_turn cleared the overflow counter');
 assert.equal(tok(), tokA + 1, 'tokens_out keeps counting across turns (a global counter at 0x44)');
 assert.equal(b.pending, 0, 'no tool call pending in turn B');
 const c = feedTurn(e, B(callLine([opener(0, 'tc', 'web_search', '{"query": "three"}')])));
 assert.equal(c.count, 1, 'turn C stages its own call');
 assert.equal(c.legacyArgs, '{"query": "three"}', 'slot 0 staging is per-turn');
});

T('render isolation: render is the bridge\'s reset, not the engine\'s begin_turn', async () => {
 const e = await engine();
 feedTurn(e, B(contentLine('one')));
 e.begin_turn(); // the engine does NOT clear the render buffer here
 const { ptr, len } = bridge.scratchWrite(B(contentLine('two')));
 e.sse_feed(ptr, len);
 assert.equal(bridge.str(e.render_ptr(), e.render_len()), 'onetwo', 'render_len keeps accumulating until reset');
 bridge.resetRender();
 e.sse_feed(ptr, len);
 assert.equal(bridge.str(e.render_ptr(), e.render_len()), 'two', 'resetRender() scopes the buffer to one round');
 bridge.renderDrain();
 assert.equal(bridge.renderDrain(), '', 'drained bytes are not re-delivered');
});

// ── capacity / overflow boundaries ───────────────────────────────────────

T('capacity: the SSE line buffer holds 16384 B and drops only the overflowing line', async () => {
 const e = await engine();
 const pre = 'data: {"choices":[{"delta":{"content":"';
 const post = '"}}]}';
 const pad = (n) => pre + 'A'.repeat(n - pre.length - post.length) + post;
 assert.equal(feedTurn(e, B(pad(SSE_LINE_CAP) + '\n')).render.length,
  SSE_LINE_CAP - pre.length - post.length, 'a line of exactly 16384 bytes is still processed');
 const over = feedTurn(e, B(pad(SSE_LINE_CAP + 1) + '\n' + contentLine('recovered')));
 assert.equal(over.errCode, 3, 'err code 3: the line is dropped, scanning continues');
 assert.equal(over.state, 1, 'not an error state');
 assert.equal(over.remLen, 0, 'the remainder buffer is reset after the dropped line');
 assert.equal(over.render, 'recovered', 'the next line is processed normally');
});

T('capacity: the render buffer caps at 131072 B and counts the excess instead of truncating silently', async () => {
 const e = await engine();
 const perLine = 8192;
 let stream = '';
 for (let i = 0; i < 17; i++) stream += contentLine('A'.repeat(perLine));
 const r = feedTurn(e, B(stream));
 assert.equal(r.render.length, RENDER_CAP, 'render stops exactly at the cap');
 assert.ok(r.render.startsWith('A'.repeat(64)), 'the capped bytes are intact');
 assert.equal(r.renderOverflow, 17 * perLine - RENDER_CAP, 'the excess is counted, byte for byte');
 assert.equal(r.errCode, 0, 'counting is not an error');
 e.end_turn(); // the history arena cannot hold 139264 B: documented boundary
 assert.equal(e.history_count(), 0, 'an assistant entry that does not fit the arena is dropped');
 assert.equal(new DataView(bridge.memBuf()).getInt32(CTRL.ERR_CODE, true), 2, 'err code 2');
 // hist_append() sets state 3, but end_turn's epilogue overwrites it with 0:
 // the dropped entry is visible through err_code, not through the state slot
 assert.equal(new DataView(bridge.memBuf()).getInt32(CTRL.STATE, true), 0, 'end_turn always parks the state at 0');
});

T('capacity: the history arena takes 98304 B and its overflow is bounded, not silent', async () => {
 const e = await engine();
 const big = 'x'.repeat(9000);
 const perEntry = 20 + big.length;
 const fits = Math.floor(HISTORY_CAP / perEntry);
 let n = 0;
 for (let i = 0; i < 64; i++) {
  const before = e.history_count();
  bridge.appendHistory(1, big);
  if (e.history_count() === before) break;
  n += 1;
 }
 assert.equal(n, fits, `${fits} entries of ${perEntry} B fit the arena`);
 assert.equal(new DataView(bridge.memBuf()).getInt32(CTRL.STATE, true), 3, 'state 3');
 assert.equal(new DataView(bridge.memBuf()).getInt32(CTRL.ERR_CODE, true), 2, 'err code 2');
 assert.equal(e.history_count(), fits, 'the dropped entry is not counted');
 e.history_clear();
 bridge.appendHistory(1, big);
 assert.equal(e.history_count(), 1, 'history_clear restores the arena');
 const out = e.scratch() + 0xF000;
 e.history_get(0, out);
 const o = new DataView(bridge.memBuf(), out, 36);
 assert.equal(bridge.str(o.getInt32(4, true), o.getInt32(8, true)), big, 'the surviving entry is intact');
});
T('capacity: per-slot argument accumulator grows far beyond its first 4 KiB', async () => {
 const e = await engine();
 const half = 'x'.repeat(64 * 1024);
 const want = `{"query": "${half}"}`;
 const lines = [callLine([opener(0, 'big', 'web_search')])];
 lines.push(callLine([argFrag(0, '{"query": "')]));
 // each fragment must fit one SSE line: the 16384 B line buffer bounds the
 // fragment size a provider may stream, not the accumulator's total
 const step = 8192;
 for (let off = 0; off < half.length; off += step) lines.push(callLine([argFrag(0, half.slice(off, off + step))]));
 lines.push(callLine([argFrag(0, '"}')]));
 const r = feedTurn(e, Buffer.from(lines.join('')));
 assert.equal(r.count, 1, 'one call staged');
 assert.equal(r.calls[0].args, want, '64 KiB reassembles byte-exact');
 assert.equal(r.pending, 1, 'pending while args grow');
});

T('capacity: a 9th call is counted in tc_overflow and cannot corrupt slot 8', async () => {
 const e = await engine();
 const lines = [];
 for (let i = 0; i < 9; i++) lines.push(callLine([opener(i, `syn_${i}`, 'web_search', `{"query": "q${i}"}`)]));
 const r = feedTurn(e, B(lines.join('')));
 assert.equal(r.count, 8, 'the table holds 8 calls');
 assert.equal(r.overflow, 1, 'the 9th is counted at 0x74');
 assert.equal(r.calls[7].id, 'syn_7', 'slot 8 keeps its own id');
 assert.deepEqual(JSON.parse(r.calls[7].args), { query: 'q7' }, 'the 9th call does not append onto slot 8');
 assert.deepEqual(r.calls.map((c) => JSON.parse(c.args).query),
  ['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'], 'the first 8 calls are intact');
 const next = feedTurn(e, B(callLine([opener(0, 'next', 'web_search', '{"query": "n"}')])));
 assert.equal(next.count, 1, 'begin_turn clears the table');
 assert.equal(next.overflow, 0, 'begin_turn clears the overflow counter');
});

T('capacity: id and name are clamped to 64 B per slot; arguments are not', async () => {
 const e = await engine();
 const longId = 'i'.repeat(100);
 const longName = 'n'.repeat(100);
 const r = feedTurn(e, B(callLine([opener(0, longId, longName, '{"query": "z"}')])));
 assert.equal(r.calls[0].id.length, TOOL_TABLE.FIELD_CAP, 'id clamped to 64');
 assert.equal(r.calls[0].name.length, TOOL_TABLE.FIELD_CAP, 'name clamped to 64');
 assert.equal(r.calls[0].id, 'i'.repeat(64), 'the clamp keeps the prefix');
 assert.deepEqual(JSON.parse(r.calls[0].args), { query: 'z' }, 'arguments unaffected');
 // a longer id on a later slot clamps the same way
 const second = feedTurn(e, B(callLine([opener(1, longId, longName)])));
 assert.equal(second.calls[0].id.length, TOOL_TABLE.FIELD_CAP, 'slot 1+ clamp too');
});

T('capacity: an exhausted heap drops the fragment and records err code 6, no trap', async () => {
 const e = await engine();
 const bump = new DataView(bridge.memBuf()).getInt32(CTRL.HEAP_BUMP, true);
 e.heap_alloc(HEAP_PAGE_CEILING * 65536 - bump); // saturate the bump allocator
 assert.equal(new DataView(bridge.memBuf()).getInt32(CTRL.HEAP_BUMP, true),
  HEAP_PAGE_CEILING * 65536, 'the heap is at its ceiling');
 const r = feedTurn(e, B(callLine([opener(0, 'h1', 'web_search', '{"query": "x"}')])));
 assert.equal(r.errCode, 6, 'accum_append recorded the allocation failure');
 assert.equal(r.state, 1, 'no trap, no error state');
 assert.equal(r.count, 1, 'the call is staged');
 assert.equal(r.calls[0].id, 'h1', 'id stored (slot fields need no heap)');
 assert.equal(r.calls[0].args, '', 'the arguments fragment was dropped');
 e.end_turn();
 assert.equal(e.history_count(), 1, 'the turn still finalizes');
});

// ── the seeded chunking matrix (child process, hard timeout) ─────────────

T('property: chunking equivalence over the corpus (seeded, bounded, process-timed)', async () => {
 const seed = Number(process.env.STREAMS_SEED || DEFAULT_SEED);
 const started = Date.now();
 const res = spawnSync(process.execPath, [THIS_FILE], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  env: { ...process.env, STREAMS_CHILD: 'property', STREAMS_SEED: String(seed), STREAMS_REPLAY: '' },
  timeout: 60_000,
  killSignal: 'SIGKILL',
 });
 const out = `${res.stdout || ''}${res.stderr || ''}`;
 if (res.error || res.signal) {
  assert.fail(`the property child was killed after ${Date.now() - started} ms — a synchronous engine hang `
   + `blocks the event loop, so this process-level timeout is the only guard. seed=${seed}\n${out}`);
 }
 assert.equal(res.status, 0, `${out}`);
 const footer = /STREAMS CHILD OK fixtures=(\d+) cases=(\d+) seed=(\d+)/.exec(res.stdout);
 assert.ok(footer, `the child must print its summary, got: ${out}`);
 assert.equal(Number(footer[3]), seed, 'the child ran with the requested seed');
 assert.ok(Number(footer[1]) >= 12, `corpus covers at least 12 fixtures, got ${footer[1]}`);
 assert.ok(Number(footer[2]) >= 100, `the matrix must run a real number of cases, got ${footer[2]}`);
});

T('property: the documented replay command reproduces exactly one case', async () => {
 const res = spawnSync(process.execPath, [THIS_FILE], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  env: { ...process.env, STREAMS_CHILD: 'property', STREAMS_SEED: String(DEFAULT_SEED), STREAMS_REPLAY: 'tool-parallel:every-2' },
  timeout: 30_000,
  killSignal: 'SIGKILL',
 });
 assert.equal(res.status, 0, `${res.stdout || ''}${res.stderr || ''}`);
 const footer = /STREAMS CHILD OK fixtures=(\d+) cases=(1) seed=(\d+) replay=tool-parallel:every-2/.exec(res.stdout);
 assert.ok(footer, `the replayed child reports one case: ${res.stdout}`);
});
