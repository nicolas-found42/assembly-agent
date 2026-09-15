// tool-loop.mjs — regression + contract tests for the Turn loop in js/bridge.js.
// Drives runTurn()'s single on(event) interface (ADR-0007). No network: chat
// fetch is stubbed with canned SSE streams, because driving real Scanner bytes
// is deliberate (ADR-0002). Search enters through runTurn()'s opts.search seam
// as canned result records (ADR-0002 amendment) — no fetch interception below
// the Fan-out. Every turn now opens with the mandatory initial research
// through that seam, so the seam sees one query before the first chat POST.
// Guards the bug where a turn that spent all its search rounds ended with no
// final answer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── browser shims (bridge -> search.js touches window+localStorage) ──
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
// Contract (js/bridge.js opts.search): async search(query, { fresh, plan })
// returns the SAME record the Fan-out builds — { markdown, sources, failures,
// perSource }. The initial lookup carries { fresh: true, plan } (the plan
// routes the Fan-out); failures ride the failures field.
// The page-read seam (opts.read) is separate: these tests are search-only, so
// every read fails cleanly instead of reaching the network.
const STUB_MD = '### [STUB] Seam fixture\nhttps://stub.example/seam\ninjected record body\n';
const record = (failures = []) => ({
  markdown: failures.length ? '' : STUB_MD,
  sources: failures.length ? 0 : 1,
  failures,
  perSource: failures.length ? [] : [{ tag: 'STUB', hits: 1, ms: 0 }],
});
/** Page-read seam: a failing record, so the application-controlled reads stay
 *  out of these search-only cases (no network below the seam). */
const failedRead = async (url) => ({ ok: false, url, status: 'failed', reason: 'no read seam in this test' });

/** search(query, opts) -> record, remembering every call and how many chat
 *  POSTs had already happened when it arrived (research must come first). */
function stubSearch(rec = record()) {
  const seen = [];
  const search = async (query, opts) => { seen.push({ query, opts, chatCalls: calls.length }); return rec; };
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
const { MAX_RESEARCH_ROUNDS } = await import('../js/research.js');
const { BUDGET_NUDGE } = bridge;
await bridge.initEngine();

const SYSTEM = 'system prompt';
const SEARCHES = MAX_RESEARCH_ROUNDS - 1; // the initial lookup spends the first round

/**
 * Drive one runTurn() with a canned script; returns the aggregated seen-view,
 * the raw event log, the persist call log, the TurnSummary, the recorded chat
 * payloads, and the search adapter the turn used. Persists are labelled by
 * SITE from the last request body: P1 the user message, P2 a settled answer,
 * P3 the nudged (budget-exhausted) answer.
 */
async function drive(text, responses, opts = {}) {
  const {
    model = 'x/y:free', key = '', search = stubSearch(), persist = null,
    tools, retry, correct, seed = [], read = failedRead,
  } = opts;
  bridge.clearHistory();
  for (const [role, content] of seed) bridge.appendHistory(role, content);
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
  const recordPersist = () => {
    const last = calls.at(-1);
    const nudged = !!last && last.messages.some((m) => m.content === BUDGET_NUDGE);
    persists.push(calls.length === 0 ? 'P1' : nudged ? 'P3' : 'P2');
  };
  const summary = await bridge.runTurn(text, {
    system: SYSTEM, getKey: () => key, model, on,
    persist: persist || recordPersist,
    search, read, tools, retry, correct,
  });
  return { seen, search, events, persists, summary, calls: calls.slice() };
}

// ── 1. plain finish: research first, one round, one final ───────────────
{
  const out = await drive('explain wasm', [() => textSSE('hello there')]);
  const { seen, search } = out;
  assert.equal(seen.rounds, 1, 'plain finish: 1 model round');
  assert.deepEqual(seen.finals, ['hello there'], 'plain finish: final text');
  assert.equal(seen.tools.length, 0, 'plain finish: no tool call');
  assert.equal(calls.length, 1, 'plain finish: 1 chat call');
  assert.equal(seen.done, 1, 'plain finish: done once');
  assert.deepEqual(search.seen.map((s) => s.query), ['explain wasm'], 'plain finish: initial research query');
  assert.equal(search.seen[0].opts.fresh, true, 'plain finish: initial lookup asks for fresh results');
  assert.equal(search.seen[0].opts.plan.kind, 'general', 'plain finish: the plan routes the initial lookup');
  assert.equal(search.seen[0].chatCalls, 0, 'plain finish: research precedes every chat POST');
  const msgs = calls[0].messages;
  assert.equal(msgs[0].role, 'system', 'plain finish: system prompt rides opts, not history');
  assert.ok(msgs[0].content.startsWith(SYSTEM), 'plain finish: system prompt is the caller string');
  assert.match(msgs[0].content, /Clock source: device\.$/, 'plain finish: the clock line closes the system message');
  assert.ok(msgs.some((m) => m.role === 'user' && m.content === `Web search results for "explain wasm":\n\n${STUB_MD.trim()}`),
    'plain finish: research results ride a plain user message');
  assert.equal(msgs.filter((m) => m.role === 'user').length, 2, 'plain finish: question + research results');
  console.log('ok  : plain finish -> research before the first POST, single round, single final');
}

// ── 2. one tool round then an answer ────────────────────────────────────
{
  const { seen, search } = await drive('q', [
    () => toolCallSSE('call_1', 'wasm'),
    () => textSSE('the answer'),
  ]);
  assert.equal(seen.rounds, 2, 'tool+answer: 2 rounds');
  assert.deepEqual(search.seen.map((s) => s.query), ['q', 'wasm'], 'tool+answer: initial research then the tool query');
  assert.equal(search.seen[1].chatCalls, 1, 'tool+answer: model search arrives after the first POST');
  assert.deepEqual(seen.results, [record()], 'tool+answer: whole record forwarded to tool-finished');
  assert.deepEqual(seen.tools, ['wasm'], 'tool+answer: query forwarded');
  assert.deepEqual(seen.finals, ['the answer'], 'tool+answer: final text');
  assert.ok(calls[0].tools, 'tool+answer: 1st call offers tools');
  assert.ok(calls[1].tools, 'tool+answer: 2nd call still offers tools');
  const toolMsg = calls[1].messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg?.content, STUB_MD, 'tool+answer: injected markdown fed back');
  console.log('ok  : one tool round -> answer');
}

// ── 3. budget exhausted -> nudged final pass (the regression) ───────────
{
  const responses = [];
  for (let i = 0; i < SEARCHES; i++) responses.push(() => toolCallSSE(`call_${i}`, `q${i}`));
  responses.push(() => textSSE('forced final answer'));
  const out = await drive('hard question', responses);
  const { seen } = out;

  assert.equal(seen.tools.length, SEARCHES, `exhausted: ${SEARCHES} model searches after the initial one`);
  assert.equal(out.search.seen.length, MAX_RESEARCH_ROUNDS, 'exhausted: initial + model searches spend the whole budget');
  assert.equal(calls.length, MAX_RESEARCH_ROUNDS, 'exhausted: one extra final call');
  assert.equal(seen.rounds, MAX_RESEARCH_ROUNDS, 'exhausted: final pass gets its own round');
  assert.deepEqual(seen.finals, ['forced final answer'], 'exhausted: user gets a final answer');
  assert.equal(seen.errors.length, 0, 'exhausted: no error surfaced');

  const last = calls.at(-1);
  assert.equal(last.tools, undefined, 'exhausted: final pass sends no tools');
  const nudgeIdx = last.messages.findLastIndex((m) => m.content === BUDGET_NUDGE);
  assert.equal(nudgeIdx, last.messages.length - 1, 'exhausted: nudge is the single appended message, dead last');
  assert.equal(last.messages.filter((m) => m.role === 'user').length, 3,
    'exhausted: only the question, the research results and the nudge speak as user');

  // the nudge is scaffolding — it must not survive into history / saved sessions
  const hist = bridge.historyMessages();
  assert.ok(!hist.some((m) => m.content === BUDGET_NUDGE), 'exhausted: nudge absent from history');
  assert.ok(hist.some((m) => m.role === 1 && m.content.startsWith('Web search results for "hard question":')),
    'exhausted: research results stay in history');
  assert.equal(hist.at(-1).content, 'forced final answer', 'exhausted: answer stored');
  assert.equal(hist.at(-1).role, 2, 'exhausted: answer stored as assistant');
  assert.equal(hist.at(-1).tool_call_id, '', 'exhausted: answer carries no tool meta');
  console.log('ok  : budget exhausted -> nudged final pass, nudge not persisted');
}

// ── 4. final pass yields nothing -> explicit notice, never a silent empty ──
{
  const responses = [];
  for (let i = 0; i < SEARCHES; i++) responses.push(() => toolCallSSE(`c${i}`, `q${i}`));
  responses.push(() => textSSE('   '));
  const { seen } = await drive('hard question', responses);
  assert.equal(seen.finals.length, 1, 'empty final: still exactly one final');
  assert.match(seen.finals[0], /Search budget/, 'empty final: explains the budget');
  assert.equal(seen.errors.length, 0, 'empty final: no error surfaced');
  console.log('ok  : empty final pass -> explanatory notice');
}

// ── 5. paid model with no key never reaches the network ────────────────
{
  const { seen, search, persists, summary } = await drive('hi', [], { model: 'openai/gpt-4o' });
  assert.equal(calls.length, 0, 'paid+anon: no chat call');
  assert.equal(search.seen.length, 0, 'paid+anon: no search either');
  assert.equal(seen.errors.length, 1, 'paid+anon: one error');
  assert.match(seen.errors[0], /needs your API key/, 'paid+anon: actionable message');
  assert.equal(seen.done, 1, 'paid+anon: done once');
  // gate sits AFTER the first save point: the user message persisted, nothing else did
  assert.deepEqual(persists, ['P1'], 'paid+anon: exactly P1 fired before the gate');
  assert.equal(summary.ok, false, 'paid+anon: TurnSummary reports failure');
  assert.deepEqual(summary.research, { query: '', sources: 0, failures: [] }, 'paid+anon: no research ran');
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
  assert.equal(summary.research.query, 'q', 'http error: the research that ran is reported');
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
  assert.deepEqual(search.seen.map((s) => s.query), ['two things', 'zig', 'rust'], 'parallel: one search per call id, in call order');
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
  ], { search: stubSearch(record(['wikipedia'])) });
  assert.deepEqual(search.seen.map((s) => s.query), ['q', 'wasm'], 'failure: both queries still reach the adapter');
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

  // budget exhausted: SEARCHES tool rounds + forced final -> P3, not P2
  const responses = [];
  for (let i = 0; i < SEARCHES; i++) responses.push(() => toolCallSSE(`call_${i}`, `q${i}`));
  responses.push(() => textSSE('forced final answer'));
  out = await drive('hard question', responses);
  assert.deepEqual(out.persists, ['P1', 'P3'],
    'persist timing: exhausted/nudged path saves at P1 and P3, never P2');
  console.log('ok  : persist timing -> P1+P2 normal, P1+P3 exhausted');
}

// ── 10. checkAccess: free models open to everyone, keyed models need a key ──
{
  const BLOCKED_REASON = 'This model needs your API key — add one in Settings, or choose a free model.';
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
  const started = out.events.find((ev) => ev.type === 'research-started');
  const finished = out.events.find((ev) => ev.type === 'research-finished');
  assert.deepEqual(started, { type: 'research-started', query: 'q' }, 'research-started: query only');
  assert.equal(finished.query, 'q', 'research-finished: carries the query');
  assert.equal(finished.markdown, STUB_MD, 'research-finished: carries the markdown');
  assert.equal(finished.sources, 1, 'research-finished: carries the source count');
  assert.deepEqual(finished.failures, [], 'research-finished: carries the failure list');
  assert.equal(finished.hits, 1, 'research-finished: carries the hit count');
  assert.deepEqual(
    out.events.map((ev) => ev.type),
    ['research-started', 'sources', 'research-finished', 'sources', 'round-started', 'tool-started',
      'sources', 'tool-finished', 'round-started', 'delta', 'round-final', 'done'],
    'events: exact sequence for one tool round then an answer (the streamed answer is a delta)',
  );
  const sourceLists = out.events.filter((ev) => ev.type === 'sources').map((ev) => ev.list);
  assert.deepEqual(sourceLists.map((l) => l.length), [1, 1, 1],
    'events: the sources list carries the discovered URL after every mutation');
  assert.equal(sourceLists[0][0].url, 'https://stub.example/seam', 'events: the searched URL is on the first list');
  assert.equal(sourceLists.at(-1)[0].status, 'ok',
    'events: a failed read never demotes a source the search already found');
  assert.deepEqual(sourceLists[0].map((r) => r.id), sourceLists.at(-1).map((r) => r.id),
    'events: record ids stay stable across snapshots');
  const starts = out.events.filter((ev) => ev.type === 'round-started');
  assert.deepEqual(starts.map((ev) => ev.round), [0, 1], 'events: round-started carries round index 0 then 1');
  console.log('ok  : tool-finished + research event shapes, exact event sequence');
}

// ── 12. TurnSummary: plain finish and error turns ───────────────────────
{
  const good = await drive('hi', [() => textSSE('hello there')]);
  assert.equal(good.summary.ok, true, 'summary: plain finish ok');
  assert.equal(good.summary.rounds, 1, 'summary: plain finish rounds');
  assert.equal(good.summary.text, 'hello there', 'summary: plain finish text');
  assert.deepEqual(good.summary.research, { query: 'assistant greeting etiquette', sources: 1, failures: [] },
    'summary: greeting turn researches etiquette, not user words');

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
  assert.equal(out.summary.research.query, 'q', 'abort: the research that ran is reported');
  console.log('ok  : abort mid-stream -> aborted event, P1-only persists');
}

// ── 14. retry: no user append, no P1, but research runs fresh again ────
{
  const out = await drive('retried question', [() => textSSE('second try')], {
    retry: true,
    seed: [[1, 'retried question'], [2, '']],
  });
  assert.deepEqual(out.persists, ['P2'], 'retry: no user persist point');
  assert.deepEqual(out.search.seen.map((s) => s.query), ['retried question'], 'retry: research runs again');
  assert.equal(out.search.seen[0].opts.fresh, true, 'retry: research is fresh, not cached');
  assert.deepEqual(out.seen.finals, ['second try'], 'retry: answer settles');
  const users = bridge.historyMessages().filter((m) => m.role === 1).map((m) => m.content);
  assert.equal(users.length, 2, 'retry: the question is not stored twice');
  assert.equal(users[0], 'retried question', 'retry: the original question stays first');
  assert.ok(users[1].startsWith('Web search results for "retried question":'), 'retry: fresh results follow');
  console.log('ok  : retry -> fresh research, no duplicate user message');
}

console.log('ALL TOOL-LOOP PASS');
