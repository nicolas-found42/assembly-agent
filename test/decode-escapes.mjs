// decode-escapes.mjs — a JSON string that ENDS with an escape must keep it.
// No network. Regression for the off-by-one in $decode_inplace: the guard that
// rejects a trailing lone backslash also rejected a complete 2-byte escape
// sitting flush against the closing quote.
//
// Providers chunk tool-call arguments wherever they like. Cohere ends a chunk
// right after an escaped quote on every tool call, so `{"query": "..."}` came
// back as `{query": ...` — malformed, JSON.parse failed, and we sent
// `arguments: ""` and earned a 400. Fixture is the real captured stream.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = globalThis;
globalThis.location = { origin: 'http://localhost:8000' };
globalThis.document = { createElement: () => ({}), querySelector: () => null, body: { appendChild: () => {} } };
globalThis.localStorage = {};

const WASM = readFileSync(new URL('../dist/agent.wasm', import.meta.url));
globalThis.fetch = async (u) => {
  if (String(u) === 'dist/agent.wasm') return new Response(WASM);
  throw new Error('offline');
};

const bridge = await import('../js/bridge.js');
await bridge.initEngine();
const E = bridge.eng();
const enc = new TextEncoder();

/** Feed SSE lines into a fresh turn; return the staged tool call + render. */
function feed(lines) {
  E.begin_turn();
  bridge.resetRender();
  for (const l of lines) {
    const { ptr, len } = bridge.scratchWrite(enc.encode(`${l}\n\n`));
    E.sse_feed(ptr, len);
  }
  const render = bridge.renderDrain();
  const dv = new DataView(bridge.memBuf());
  const args = bridge.str(dv.getInt32(0x28, true), dv.getInt32(0x2C, true));
  const name = bridge.str(0x6040, dv.getInt32(0x34, true));
  const out = { pending: E.tool_pending(), name, args, render };
  E.end_turn();
  return out;
}

const tc = (frag) => `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":${JSON.stringify(frag)}}}]}}]}`;
const content = (text) => `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}`;

// ── 1. the real stream: arguments must reassemble into parseable JSON ───
{
  const raw = readFileSync(new URL('./fixtures/cohere-north-mini-code-toolcall.sse', import.meta.url), 'utf8');
  const r = feed(raw.split('\n').filter(Boolean));
  assert.equal(r.pending, 1, 'cohere: tool call staged');
  assert.equal(r.name, 'web_search', 'cohere: tool name read');
  const parsed = JSON.parse(r.args); // threw before the fix
  assert.equal(typeof parsed.query, 'string', 'cohere: query is a string');
  assert.ok(parsed.query.length > 0, 'cohere: query non-empty');
  console.log(`ok  : real cohere stream -> {"query":"${parsed.query}"}`);
}

// ── 2. a chunk that ends exactly on an escaped quote ───────────────────
// Fragments are the DECODED text; JSON.stringify puts the escape on the wire
// flush against the closing quote, which is the shape Cohere sends.
{
  const r = feed([tc('{"'), tc('q": "'), tc('hi"}')]);
  assert.equal(r.args, '{"q": "hi"}', 'split on escapes: args reassembled');
  assert.deepEqual(JSON.parse(r.args), { q: 'hi' }, 'split on escapes: parses');
  console.log('ok  : fragments ending on an escaped quote keep the quote');
}

// ── 3. every 2-byte escape, flush against the closing quote ────────────
{
  for (const want of ['a"', 'a\\', 'a\n', 'a\t', 'a\b', 'a\f', 'a\r']) {
    const r = feed([content(want)]);
    assert.equal(r.render, want, `trailing escape in ${JSON.stringify(want)} decoded`);
  }
  // \/ is legal JSON but JSON.stringify never emits it — write it by hand.
  const slash = feed(['data: {"choices":[{"delta":{"content":"a\\/"}}]}']);
  assert.equal(slash.render, 'a/', 'trailing \\/ decoded');
  console.log('ok  : content deltas keep a trailing 2-byte escape');
}

// ── 4. a truncated \u escape must not read past the string ─────────────
{
  const r = feed(['data: {"choices":[{"delta":{"content":"ok \\u12"}}]}']);
  assert.equal(new DataView(bridge.memBuf(), 4, 4).getInt32(0, true) !== 3, true, 'truncated \\u: no error state');
  assert.ok(r.render.startsWith('ok '), 'truncated \\u: text before it survives');
  assert.ok(!r.render.includes('\uFFFD'.repeat(2)), 'truncated \\u: no garbage run');
  console.log('ok  : truncated \\u escape stops cleanly');
}

console.log('ALL DECODE-ESCAPE PASS');
