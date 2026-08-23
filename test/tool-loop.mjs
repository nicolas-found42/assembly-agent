// tool-loop.mjs — regression + contract tests for the Turn loop in js/bridge.js.
// Drives runTurn()'s single on(event) interface (ADR-0007). No network: chat
// fetch is stubbed with canned SSE streams, because driving real Scanner bytes
// is deliberate (ADR-0002). Search enters through runTurn()'s opts.search seam
// as canned result records (ADR-0002 amendment) — no fetch interception below
// the Fan-out. Guards the bug where a turn that spent all MAX_TOOL_ROUNDS on
// searches ended with no final answer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── browser shims (bridge -> search.js/sessions.js touch window+localStorage) ──
globalThis.window = globalThis;
globalThis.location = { origin: 'http://localhost:8000' };
globalThis.document = { createElement: () => ({}), querySelector: () => null, body: { appendChild: () => {} } };
globalThis.localStorage = {};

const WASM = readFileSync(new URL('../dist/agent.wasm', import.meta.url));
const enc = new TextEncoder();

// ── canned SSE bodies ──────────────────────────────────────────────────
const sse = (lines) => new Response(
  new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(enc.encode(`data: ${l}\n\n`)); c.close(); },
  }),
  { headers: { 'content-type': 'text/event-stream' } },
);

const toolCallSSE = (id, query) => sse([
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ id, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query }) } }] } }] }),
  '[DONE]',
]);
const twoCallSSE = (idA, qA, idB, qB) => sse([
  JSON.stringify({ choices: [{ delta: { tool_calls: [
    { index: 0, id: idA, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: qA }) } },
    { index: 1, id: idB, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: qB }) } },
  ] } }] }),
  '[DONE]',
]);
const textSSE = (text) => sse([
  JSON.stringify({ choices: [{ delta: { content: text } }] }),
  '[DONE]',
]);

// ── the search seam: adapters handed to runTurn() instead of fetch fakes ──
// Contract (js/bridge.js opts.search): async search(query) returns the SAME
// record the Fan-out builds — { markdown, sources, failures, perSource }.
// Adapters never reject; failures ride the failures field.
const STUB_MD = '### [STUB] Seam fixture\nhttps://stub.example/seam\ninjected record body\n';
const record = (failures = []) => ({
  markdown: failures.length ? '' : STUB_MD,
  sources: failures.length ? 0 : 1,
  failures,
  perSource: failures.length ? [] : [{ tag: 'STUB', hits: 1, ms: 0 }],
});
/** search(query) -> record, remembering every query it served. */
function stubSearch(rec = record()) {
  const seen = [];
  const search = async (query) => { seen.push(query); return rec; };
  search.seen = seen;
  return search;
}

// ── fetch stub: serves the wasm, records chat payloads, replays a script ──
let script = [];      // per-call Response factories
let calls = [];       // recorded request bodies
globalThis.fetch = async (url, opts) => {
  if (String(url) === 'dist/agent.wasm') return new Response(WASM);
  calls.push(JSON.parse(opts.body));
  const next = script.shift();
  assert.ok(next, `unexpected extra chat call #${calls.length}`);
  return next();
};

const bridge = await import('../js/bridge.js');
const { MAX_TOOL_ROUNDS, BUDGET_NUDGE } = bridge;
await bridge.initEngine();

/** Drive one runTurn() with a canned script; returns the aggregated seen-view,
 *  the raw event log, the persist call log, the TurnSummary, and the search
 *  adapter the turn used. Default persist records P1/P2/P3-style entries. */
async function drive(text, responses, model = 'x/y:free', search = stubSearch(), persist = null) {
  bridge.clearHistory();
  bridge.appendHistory(0, 'system prompt');
  script = responses.slice();
  calls = [];
  const seen = { rounds: 0, tools: [], results: [], finals: [], errors: [], done: 0, delta: '' };
  const events = [];
  const persists = [];
  const on = (ev) => {
    events.push(ev);
    switch (ev.type) {
      case 'round-started': seen.rounds++; break;
      case 'delta': seen.delta += ev.text; break;
      case 'tool-started': seen.tools.push(ev.query); break;
      case 'tool-finished': seen.results.push(ev.result); break;
      case 'round-final': seen.finals.push(ev.text); break;
      case 'errored': seen.errors.push(ev.message); break;
      case 'done': seen.done++; break;
      default: break;
    }
  };
  const recordPersist = () => { persists.push(persists.length); };
  const summary = await bridge.runTurn(text, {
    key: '', model, on,
    persist: persist || recordPersist,
    search,
  });
  // Label persist calls by SITE, not arrival order: P1 pre-gate, P2 after a
  // natural round-final, P3 after the nudged pass — whose round-started
  // carries round === MAX_TOOL_ROUNDS.
  const nudged = events.some((ev) => ev.type === 'round-started' && ev.round === MAX_TOOL_ROUNDS);
  const labeled = persists.map((_, i) => (i === 0 ? 'P1' : nudged ? 'P3' : 'P2'));
  return { seen, search, events, persists: labeled, summary };
}

// ── 1. plain finish: one round, one final, no extra call ────────────────
{
  const { seen } = await drive('hi', [() => textSSE('hello there')]);
  assert.equal(seen.rounds, 1, 'plain finish: 1 round');
  assert.deepEqual(seen.finals, ['hello there'], 'plain finish: final text');
  assert.equal(seen.tools.length, 0, 'plain finish: no tool call');
  assert.equal(calls.length, 1, 'plain finish: 1 chat call');
  assert.equal(seen.done, 1, 'plain finish: done once');
  console.log('ok  : plain finish -> single round, single final');
}

// ── 2. one tool round then an answer ────────────────────────────────────
{
  const { seen, search } = await drive('q', [
    () => toolCallSSE('call_1', 'wasm'),
    () => textSSE('the answer'),
  ]);
  assert.equal(seen.rounds, 2, 'tool+answer: 2 rounds');
  assert.deepEqual(search.seen, ['wasm'], 'tool+answer: query forwarded to the injected search');
  assert.deepEqual(seen.results, [record()], 'tool+answer: whole record forwarded to tool-finished');
  assert.deepEqual(seen.tools, ['wasm'], 'tool+answer: query forwarded');
  assert.deepEqual(seen.finals, ['the answer'], 'tool+answer: final text');
  assert.ok(calls[1].tools, 'tool+answer: 2nd call still offers tools');
  const toolMsg = calls[1].messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg?.content, STUB_MD, 'tool+answer: injected markdown fed back');
  console.log('ok  : one tool round -> answer');
}

// ── 3. budget exhausted -> nudged final pass (the regression) ───────────
{
  const responses = [];
  for (let i = 0; i < MAX_TOOL_ROUNDS; i++) responses.push(() => toolCallSSE(`call_${i}`, `q${i}`));
  responses.push(() => textSSE('forced final answer'));
  const { seen } = await drive('hard question', responses);

  assert.equal(seen.tools.length, MAX_TOOL_ROUNDS, `exhausted: ${MAX_TOOL_ROUNDS} tool calls`);
  assert.equal(calls.length, MAX_TOOL_ROUNDS + 1, 'exhausted: one extra final call');
  assert.equal(seen.rounds, MAX_TOOL_ROUNDS + 1, 'exhausted: final pass gets its own round');
  assert.deepEqual(seen.finals, ['forced final answer'], 'exhausted: user gets a final answer');
  assert.equal(seen.errors.length, 0, 'exhausted: no error surfaced');

  const last = calls[MAX_TOOL_ROUNDS];
  assert.equal(last.tools, undefined, 'exhausted: final pass sends no tools');
  const nudgeIdx = last.messages.findLastIndex((m) => m.content === BUDGET_NUDGE);
  assert.equal(nudgeIdx, last.messages.length - 1, 'exhausted: nudge is the single appended message, dead last');
  assert.equal(last.messages.filter((m) => m.role === 'user').length, 2,
    'exhausted: only the question and the nudge speak as user');

  // the nudge is scaffolding — it must not survive into history / saved sessions
  const hist = bridge.historyMessages();
  assert.ok(!hist.some((m) => m.content === BUDGET_NUDGE), 'exhausted: nudge absent from history');
  assert.equal(hist.at(-1).content, 'forced final answer', 'exhausted: answer stored');
  assert.equal(hist.at(-1).role, 2, 'exhausted: answer stored as assistant');
  assert.equal(hist.at(-1).tool_call_id, '', 'exhausted: answer carries no tool meta');
  console.log('ok  : budget exhausted -> nudged final pass, nudge not persisted');
}

// ── 4. final pass yields nothing -> explicit notice, never a silent empty ──
{
  const responses = [];
  for (let i = 0; i < MAX_TOOL_ROUNDS; i++) responses.push(() => toolCallSSE(`c${i}`, `q${i}`));
  responses.push(() => textSSE('   '));
  const { seen } = await drive('hard question', responses);
  assert.equal(seen.finals.length, 1, 'empty final: still exactly one final');
  assert.match(seen.finals[0], /Search budget/, 'empty final: explains the budget');
  console.log('ok  : empty final pass -> explanatory notice');
}

// ── 5. paid model with no key never reaches the network ────────────────
{
  const { seen, search, persists, summary } = await drive('hi', [], 'openai/gpt-4o');
  assert.equal(calls.length, 0, 'paid+anon: no chat call');
  assert.equal(search.seen.length, 0, 'paid+anon: no search either');
  assert.equal(seen.errors.length, 1, 'paid+anon: one error');
  assert.match(seen.errors[0], /needs your own key/, 'paid+anon: actionable message');
  assert.equal(seen.done, 1, 'paid+anon: done once');
  // gate sits AFTER the first save point: the user message persisted, nothing else did
  assert.deepEqual(persists, ['P1'], 'paid+anon: exactly P1 fired before the gate');
  assert.equal(summary.ok, false, 'paid+anon: TurnSummary reports failure');
  console.log('ok  : paid model without key blocked before network');
}

// ── 6. mid-loop HTTP error stops the turn cleanly ───────────────────────
{
  const { seen, persists, summary } = await drive('q', [
    () => toolCallSSE('call_1', 'wasm'),
    () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }),
  ]);
  assert.deepEqual(seen.errors, ['rate limited — Free tier busy — try again in a minute or add your own key in SET to bypass.'], 'http error: message surfaced');
  assert.equal(seen.finals.length, 0, 'http error: no bogus final');
  assert.equal(seen.done, 1, 'http error: done once');
  assert.deepEqual(persists, ['P1'], 'http error: past P1, no further persists');
  assert.equal(summary.ok, false, 'http error: TurnSummary reports failure');
  assert.ok(summary.error, 'http error: TurnSummary carries the error');
  console.log('ok  : mid-loop HTTP error surfaces and stops');
}

// ── 7. parallel Tool Calls: one search + one role-tool message per call id ──
{
  const { seen, search } = await drive('two things', [
    () => twoCallSSE('call_a', 'zig', 'call_b', 'rust'),
    () => textSSE('the answer'),
  ]);
  assert.equal(seen.rounds, 2, 'parallel: 2 rounds');
  assert.deepEqual(seen.tools, ['zig', 'rust'], 'parallel: tool-started fires once per call, in call order');
  assert.deepEqual(search.seen, ['zig', 'rust'], 'parallel: one search per call id, in call order');
  const tools = calls[1].messages.filter((m) => m.role === 'tool');
  assert.deepEqual(tools.map((t) => t.tool_call_id), ['call_a', 'call_b'], 'parallel: one role-tool message per call id');
  assert.ok(tools.every((t) => t.content === STUB_MD), 'parallel: each call carries the record markdown');
  const asst = calls[1].messages.find((m) => m.role === 'assistant');
  assert.deepEqual(asst.tool_calls.map((c) => c.id), ['call_a', 'call_b'], 'parallel: assistant coalesces both calls');
  console.log('ok  : parallel tool calls -> one search + role-tool message per id');
}

// ── 8. adapter failure tolerance: misses ride the record, never a rejection ──
{
  const { seen, search } = await drive('q', [
    () => toolCallSSE('call_1', 'wasm'),
    () => textSSE('answered from context'),
  ], 'x/y:free', stubSearch(record(['wikipedia'])));
  assert.deepEqual(search.seen, ['wasm'], 'failure: query still reaches the adapter');
  assert.deepEqual(seen.errors, [], 'failure: adapter rejection would surface here — none did');
  assert.deepEqual(seen.results, [record(['wikipedia'])], 'failure: record with failures forwarded untouched');
  assert.deepEqual(seen.finals, ['answered from context'], 'failure: turn completes');
  console.log('ok  : adapter failures ride the record, turn completes');
}

// ── 9. persist timing: P2 on normal completion, P3 on the exhausted path ──
{
  // happy path: one tool round then an answer -> P1 after user msg, P2 after round-final
  let out = await drive('q', [
    () => toolCallSSE('call_1', 'wasm'),
    () => textSSE('the answer'),
  ]);
  assert.deepEqual(out.persists, ['P1', 'P2'],
    'persist timing: happy path saves at P1 and P2, never P3');

  // budget exhausted: all MAX_TOOL_ROUNDS rounds spend tools + forced final -> P3, not P2
  const responses = [];
  for (let i = 0; i < MAX_TOOL_ROUNDS; i++) responses.push(() => toolCallSSE(`call_${i}`, `q${i}`));
  responses.push(() => textSSE('forced final answer'));
  out = await drive('hard question', responses);
  assert.deepEqual(out.persists, ['P1', 'P3'],
    'persist timing: exhausted/nudged path saves at P1 and P3, never P2');
  console.log('ok  : persist timing -> P1+P2 normal, P1+P3 exhausted');
}

// ── 10. checkAccess: free models open to everyone, keyed models need a key ──
{
  const BLOCKED_REASON = 'This model needs your own key — open SET and add sk-or-… Anonymous users can use any :free model.';
  assert.deepEqual(bridge.checkAccess('x/y:free', ''), { ok: true }, 'checkAccess: free model, no key -> ok');
  assert.deepEqual(bridge.checkAccess('openai/gpt-4o', ''), { ok: false, reason: BLOCKED_REASON },
    'checkAccess: paid model, no key -> blocked with the exact reason string');
  assert.deepEqual(bridge.checkAccess('openai/gpt-4o', 'sk-or-x'), { ok: true }, 'checkAccess: paid model with key -> ok');
  assert.deepEqual(bridge.checkAccess('x/y:free', 'sk-or-x'), { ok: true }, 'checkAccess: free model with key -> ok');
  assert.deepEqual(bridge.checkAccess(undefined, ''), { ok: false, reason: BLOCKED_REASON },
    'checkAccess: missing model counts as non-free -> blocked');
  console.log('ok  : checkAccess unit cases');
}

// ── 11. tool-finished payload shape + exact event sequence ─────────────
{
  const out = await drive('q', [
    () => toolCallSSE('call_1', 'wasm'),
    () => textSSE('the answer'),
  ]);
  const fin = out.events.find((ev) => ev.type === 'tool-finished');
  assert.equal(typeof fin.name, 'string', 'tool-finished: name is a string');
  assert.equal(fin.name, 'web_search', 'tool-finished: name identifies the tool');
  assert.equal(fin.query, 'wasm', 'tool-finished: carries the query');
  assert.deepEqual(fin.result, record(), 'tool-finished: result is the whole webSearch record');
  assert.deepEqual(
    out.events.map((ev) => ev.type),
    ['round-started', 'tool-started', 'tool-finished', 'round-started', 'delta', 'round-final', 'done'],
    'events: exact sequence for one tool round then an answer (the streamed answer is a delta)',
  );
  const starts = out.events.filter((ev) => ev.type === 'round-started');
  assert.deepEqual(starts.map((ev) => ev.round), [0, 1], 'events: round-started carries round index 0 then 1');
  console.log('ok  : tool-finished shape + event sequence');
}

// ── 12. TurnSummary: plain finish and error turns ───────────────────────
{
  const good = await drive('hi', [() => textSSE('hello there')]);
  assert.equal(good.summary.ok, true, 'summary: plain finish ok');
  assert.equal(good.summary.rounds, 1, 'summary: plain finish rounds');
  assert.equal(good.summary.text, 'hello there', 'summary: plain finish text');

  const bad = await drive('q', [
    () => toolCallSSE('call_1', 'wasm'),
    () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }),
  ]);
  assert.equal(bad.summary.ok, false, 'summary: error turn not ok');
  assert.ok(bad.summary.error, 'summary: error turn carries an error');
  console.log('ok  : TurnSummary shape for finish + error');
}

// ── 13. abort mid-stream: aborted event, P1 only, no further persists ──
{
  const abortStream = () => new Response(
    new ReadableStream({
      start(c) { c.error(new DOMException('The operation was aborted.', 'AbortError')); },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
  const out = await drive('q', [abortStream]);
  assert.equal(out.events.filter((ev) => ev.type === 'aborted').length, 1,
    'abort: exactly one aborted event');
  assert.equal(out.events.at(-1).type, 'done', 'abort: turn closes with done');
  assert.deepEqual(out.persists, ['P1'], 'abort: past P1, no further persists');
  assert.equal(out.summary.ok, false, 'abort: summary not ok');
  assert.equal(out.summary.aborted, true, 'abort: summary carries the aborted flag');
  console.log('ok  : abort mid-stream -> aborted event, P1-only persists');
}

console.log('ALL TOOL-LOOP PASS');
