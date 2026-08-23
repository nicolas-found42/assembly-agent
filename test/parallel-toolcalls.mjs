// parallel-toolcalls.mjs — the Scanner must keep parallel Tool Calls apart.
// No network. Regression for the single-slot staging bug: `sse_feed` appended
// every `"arguments":"` fragment on every `tool_calls` line into one
// accumulator, so two parallel calls concatenated into `{...}{...}`,
// `JSON.parse` failed in `pendingToolCall()`, and we sent `arguments: ""` and
// earned a 400. Fixture is the real captured stream. See
// `docs/adr/0003-parallel-tool-calls.md`.
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

/** Feed SSE lines into a fresh turn; return the whole staged tool call table. */
function feed(lines) {
  E.begin_turn();
  bridge.resetRender();
  for (const l of lines) {
    const { ptr, len } = bridge.scratchWrite(enc.encode(`${l}\n\n`));
    E.sse_feed(ptr, len);
  }
  const render = bridge.renderDrain();
  const count = E.tc_count();
  const out = E.scratch() + 0xF000;
  const calls = [];
  for (let i = 0; i < count; i++) {
    E.tc_get(i, out);
    const o = new DataView(bridge.memBuf(), out, 24);
    calls.push({
      id: bridge.str(o.getInt32(0, true), o.getInt32(4, true)),
      name: bridge.str(o.getInt32(8, true), o.getInt32(12, true)),
      args: bridge.str(o.getInt32(16, true), o.getInt32(20, true)),
    });
  }
  const dv = new DataView(bridge.memBuf());
  const r = {
    pending: E.tool_pending(),
    count,
    overflow: dv.getInt32(0x74, true),
    calls,
    render,
    // slot 0 still aliases the legacy control slots that pendingToolCall() reads
    legacyName: bridge.str(0x6040, dv.getInt32(0x34, true)),
    legacyArgs: bridge.str(dv.getInt32(0x28, true), dv.getInt32(0x2C, true)),
  };
  E.end_turn();
  return r;
}

// ── 1. the real two-call stream: one slot per call ─────────────────────
{
  const raw = readFileSync(new URL('./fixtures/lfm-2.6b-parallel-toolcalls.sse', import.meta.url), 'utf8');
  const r = feed(raw.split('\n').filter(Boolean));

  assert.equal(r.count, 2, 'lfm: two tool calls staged');
  assert.equal(r.pending, 1, 'lfm: tool call pending');
  assert.deepEqual(r.calls.map((c) => c.name), ['web_search', 'web_search'], 'lfm: both names read');
  assert.deepEqual(r.calls.map((c) => c.id),
    ['chatcmpl-tool-b394e6b97a3a92d2', 'chatcmpl-tool-b300b48aaf306311'],
    'lfm: each call keeps its own id');

  // Concatenated before the fix: {"query": "...ziglang.org"}{"query": "Zig 0.15.2..."}
  assert.deepEqual(JSON.parse(r.calls[0].args),
    { query: 'Zig programming language latest stable version official site ziglang.org' },
    'lfm: slot 0 args parse to the first query');
  assert.deepEqual(JSON.parse(r.calls[1].args),
    { query: 'Zig 0.15.2 release notes stable version confirmation' },
    'lfm: slot 1 args parse to the second query');

  console.log(`ok  : real lfm stream -> 2 calls, ${r.calls.map((c) => JSON.parse(c.args).query.slice(0, 18) + '…').join(' | ')}`);
}

// ── 2. the single-call stream still stages exactly one call ───────────
{
  const raw = readFileSync(new URL('./fixtures/cohere-north-mini-code-toolcall.sse', import.meta.url), 'utf8');
  const r = feed(raw.split('\n').filter(Boolean));

  assert.equal(r.count, 1, 'cohere: exactly one tool call');
  assert.equal(r.overflow, 0, 'cohere: no overflow');
  assert.equal(r.calls[0].id, 'web_search_dvjmkcahfsc6', 'cohere: call id read');
  assert.equal(r.calls[0].name, 'web_search', 'cohere: call name read');
  assert.deepEqual(JSON.parse(r.calls[0].args),
    { query: 'Zig programming language current stable version' },
    'cohere: args unchanged');
  // slot 0 must stay readable at the legacy addresses pendingToolCall() uses
  assert.equal(r.legacyName, r.calls[0].name, 'cohere: slot 0 name aliases 0x6040/0x34');
  assert.equal(r.legacyArgs, r.calls[0].args, 'cohere: slot 0 args alias 0x28/0x2C');
  console.log('ok  : single-call stream -> 1 call, slot 0 aliases the legacy slots');
}

// ── SSE line builders. Fragments are the DECODED text; JSON.stringify puts
// the escapes on the wire, so nothing here is hand-escaped.
const line = (calls) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] })}`;
const opener = (i, id, name) => ({ index: i, id, type: 'function', function: { name, arguments: '' } });
const frag = (i, text) => ({ index: i, function: { arguments: text } });
const call = (i, id, q) => ({
  index: i, id, type: 'function', function: { name: 'web_search', arguments: `{"query": "${q}"}` },
});

// ── 3. calls packed on one line == calls streamed a fragment at a time ─
{
  const want = [
    { id: 'a1', name: 'web_search', args: '{"query": "alpha"}' },
    { id: 'b2', name: 'web_search', args: '{"query": "beta"}' },
  ];

  const packed = feed([line(want.map((c, i) => ({
    index: i, id: c.id, type: 'function', function: { name: c.name, arguments: c.args },
  })))]);

  const streamed = feed([
    line([opener(0, 'a1', 'web_search')]),
    line([frag(0, '{"query": "')]),
    line([frag(0, 'alpha')]),
    line([frag(0, '"}')]),
    line([opener(1, 'b2', 'web_search')]),
    line([frag(1, '{"query": "')]),
    line([frag(1, 'beta')]),
    line([frag(1, '"}')]),
  ]);

  assert.deepEqual(packed.calls, want, 'packed: two complete calls on one line');
  assert.deepEqual(streamed.calls, want, 'streamed: one fragment per line');
  assert.deepEqual(packed.calls, streamed.calls, 'packed and streamed agree');
  console.log('ok  : one packed line and a fragment-per-line stream agree');
}

// ── 4. a 9th call overflows instead of corrupting the 8th ─────────────
{
  const nine = [];
  for (let i = 0; i < 9; i++) {
    nine.push(line([opener(i, `id${i}`, 'web_search')]));
    nine.push(line([frag(i, `{"query": "q${i}"}`)]));
  }
  const r = feed(nine);

  assert.equal(r.count, 8, 'overflow: table holds 8 calls');
  assert.equal(r.overflow, 1, 'overflow: the 9th call is counted at 0x74');
  assert.equal(r.calls.length, 8, 'overflow: tc_get exposes 8 slots');
  assert.equal(r.calls[7].id, 'id7', 'overflow: 8th slot keeps its own id');
  assert.deepEqual(JSON.parse(r.calls[7].args), { query: 'q7' },
    'overflow: the 9th call does not append onto the 8th');
  assert.deepEqual(r.calls.map((c) => JSON.parse(c.args).query),
    ['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'],
    'overflow: the first 8 calls are intact');
  console.log('ok  : a 9th call bumps tc_overflow and leaves slot 8 intact');
}

// ── 5. no tool call at all: a plain content turn stays a content turn ──
{
  const r = feed(['data: {"choices":[{"delta":{"content":"hello"}}]}']);
  assert.equal(r.count, 0, 'content only: no calls staged');
  assert.equal(r.pending, 0, 'content only: tool_pending false');
  assert.equal(r.render, 'hello', 'content only: delta rendered');
  console.log('ok  : a content-only turn stages nothing');
}

// ── 6. content on the same line as a tool_calls opener survives ───────
// The old args loop bailed with `(then (return))` when a tool_calls line
// carried no `"arguments":"` — returning from the whole line handler where it
// meant to break the loop, so the delta content on that line was dropped.
{
  // no `arguments` key at all — that is what made the old loop bail early
  const r = feed([`data: ${JSON.stringify({
    choices: [{ delta: { content: 'thinking',
      tool_calls: [{ index: 0, id: 'z9', type: 'function', function: { name: 'web_search' } }] } }],
  })}`]);
  assert.equal(r.render, 'thinking', 'same line: content is not swallowed by the walk');
  assert.equal(r.count, 1, 'same line: the call is still staged');
  assert.equal(r.calls[0].name, 'web_search', 'same line: name still read');
  console.log('ok  : delta content on a tool_calls line still renders');
}

// ── 7. "tool_calls" as a finish_reason value, ahead of the delta ───────
// The scanner matches the bare string, so a line that reports
// `finish_reason:"tool_calls"` before its delta puts $tp below $dp. The
// content bound must not go negative there — $find reads its length unsigned.
{
  const r = feed([`data: ${JSON.stringify({
    choices: [{ index: 0, finish_reason: 'tool_calls', delta: { content: 'wrapping up' } }],
  })}`]);
  assert.equal(r.count, 0, 'finish_reason line: nothing staged');
  assert.equal(r.render, 'wrapping up', 'finish_reason line: content still renders');
  console.log('ok  : a finish_reason:"tool_calls" line ahead of the delta is safe');
}

// ── 8. end_turn writes one role-2 entry plus role-4 siblings to history ─
// Ticket 02's contract lives at the HISTORY level: a two-call turn appends
// exactly TWO entries — role 2 carrying call 1 (byte-identical to what a
// single-call turn stores), role 4 carrying call 2 — which buildMessages()
// coalesces back into one assistant message. A single-call turn appends
// exactly one entry, unchanged.
{
  const base = E.history_count();

  feed([line([call(0, 'a1', 'alpha'), call(1, 'b2', 'beta')])]);
  const pair = bridge.historyMessages().slice(base);
  assert.equal(pair.length, 2, 'history: two-call turn appends exactly two entries');
  assert.deepEqual(pair.map((m) => m.role), [2, 4], 'history: roles are 2 then 4');
  assert.equal(pair[0].tool_call_id, 'a1', 'history: role-2 entry carries call 1');
  assert.deepEqual(JSON.parse(pair[0].args), { query: 'alpha' }, 'history: role-2 args are call 1');
  assert.equal(pair[1].tool_call_id, 'b2', 'history: role-4 sibling carries call 2');
  assert.deepEqual(JSON.parse(pair[1].args), { query: 'beta' }, 'history: role-4 args are call 2');

  // the same call alone must store a byte-identical role-2 entry
  const soloBase = E.history_count();
  feed([line([call(0, 'a1', 'alpha')])]);
  const solo = bridge.historyMessages().slice(soloBase);
  assert.equal(solo.length, 1, 'history: single-call turn appends exactly one entry');
  assert.deepEqual(solo[0], pair[0],
    'history: role-2 entry byte-identical to a single-call turn');
  console.log('ok  : end_turn stages role-2 + role-4 siblings, single-call unchanged');
}

console.log('ALL PARALLEL-TOOLCALL PASS');
