// tool-loop.mjs — regression tests for the tool-round budget in js/bridge.js.
// No network: fetch is stubbed with canned SSE streams. Guards the bug where a
// turn that spent all MAX_TOOL_ROUNDS on searches ended with no final answer.
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
const textSSE = (text) => sse([
  JSON.stringify({ choices: [{ delta: { content: text } }] }),
  '[DONE]',
]);

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

/** Drive one send() with a canned script; returns the observed callbacks. */
async function drive(text, responses, model = 'x/y:free') {
  bridge.clearHistory();
  bridge.appendHistory(0, 'system prompt');
  script = responses.slice();
  calls = [];
  const seen = { rounds: 0, tools: [], finals: [], errors: [], done: 0, delta: '' };
  await bridge.send(text, {
    onRoundStart() { seen.rounds++; },
    onDelta(d) { seen.delta += d; },
    onToolStart(n, a) { seen.tools.push(a.query); },
    onToolDone() {},
    onRoundFinal(t) { seen.finals.push(t); },
    onError(m) { seen.errors.push(m); },
    onDone() { seen.done++; },
  }, { key: '', model });
  return seen;
}

// search.js is imported by bridge directly, so stub it at the network layer.
// One wikipedia hit is enough: an all-failing search yields empty markdown and
// tool_result_flush would skip the role-3 entry, changing what we're testing.
const chatFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u === 'dist/agent.wasm' || u.includes('/api/chat') || u.includes('openrouter.ai')) return chatFetch(url, opts);
  if (u.includes('wikipedia.org')) {
    return new Response(JSON.stringify({ query: { search: [{ title: 'Stub', snippet: 'snippet' }] } }),
      { headers: { 'content-type': 'application/json' } });
  }
  throw new Error('offline');
};

// ── 1. plain finish: one round, one final, no extra call ────────────────
{
  const seen = await drive('hi', [() => textSSE('hello there')]);
  assert.equal(seen.rounds, 1, 'plain finish: 1 round');
  assert.deepEqual(seen.finals, ['hello there'], 'plain finish: final text');
  assert.equal(seen.tools.length, 0, 'plain finish: no tool call');
  assert.equal(calls.length, 1, 'plain finish: 1 chat call');
  assert.equal(seen.done, 1, 'plain finish: onDone once');
  console.log('ok  : plain finish -> single round, single final');
}

// ── 2. one tool round then an answer ────────────────────────────────────
{
  const seen = await drive('q', [
    () => toolCallSSE('call_1', 'wasm'),
    () => textSSE('the answer'),
  ]);
  assert.equal(seen.rounds, 2, 'tool+answer: 2 rounds');
  assert.deepEqual(seen.tools, ['wasm'], 'tool+answer: query forwarded');
  assert.deepEqual(seen.finals, ['the answer'], 'tool+answer: final text');
  assert.ok(calls[1].tools, 'tool+answer: 2nd call still offers tools');
  const roles = calls[1].messages.map((m) => m.role);
  assert.ok(roles.includes('tool'), 'tool+answer: tool result fed back');
  console.log('ok  : one tool round -> answer');
}

// ── 3. budget exhausted -> nudged final pass (the regression) ───────────
{
  const responses = [];
  for (let i = 0; i < MAX_TOOL_ROUNDS; i++) responses.push(() => toolCallSSE(`call_${i}`, `q${i}`));
  responses.push(() => textSSE('forced final answer'));
  const seen = await drive('hard question', responses);

  assert.equal(seen.tools.length, MAX_TOOL_ROUNDS, `exhausted: ${MAX_TOOL_ROUNDS} tool calls`);
  assert.equal(calls.length, MAX_TOOL_ROUNDS + 1, 'exhausted: one extra final call');
  assert.equal(seen.rounds, MAX_TOOL_ROUNDS + 1, 'exhausted: final pass gets its own round');
  assert.deepEqual(seen.finals, ['forced final answer'], 'exhausted: user gets a final answer');
  assert.equal(seen.errors.length, 0, 'exhausted: no error surfaced');

  const last = calls[MAX_TOOL_ROUNDS];
  assert.equal(last.tools, undefined, 'exhausted: final pass sends no tools');
  assert.equal(last.messages.at(-1).content, BUDGET_NUDGE, 'exhausted: nudge appended last');
  assert.equal(last.messages.at(-1).role, 'user', 'exhausted: nudge is a user message');

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
  const seen = await drive('hard question', responses);
  assert.equal(seen.finals.length, 1, 'empty final: still exactly one final');
  assert.match(seen.finals[0], /Search budget/, 'empty final: explains the budget');
  console.log('ok  : empty final pass -> explanatory notice');
}

// ── 5. paid model with no key never reaches the network ────────────────
{
  const seen = await drive('hi', [], 'openai/gpt-4o');
  assert.equal(calls.length, 0, 'paid+anon: no chat call');
  assert.equal(seen.errors.length, 1, 'paid+anon: one error');
  assert.match(seen.errors[0], /needs your own key/, 'paid+anon: actionable message');
  assert.equal(seen.done, 1, 'paid+anon: onDone once');
  console.log('ok  : paid model without key blocked before network');
}

// ── 6. mid-loop HTTP error stops the turn cleanly ───────────────────────
{
  const seen = await drive('q', [
    () => toolCallSSE('call_1', 'wasm'),
    () => new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }),
  ]);
  assert.deepEqual(seen.errors, ['rate limited — Free tier busy — try again in a minute or add your own key in SET to bypass.'], 'http error: message surfaced');
  assert.equal(seen.finals.length, 0, 'http error: no bogus final');
  assert.equal(seen.done, 1, 'http error: onDone once');
  console.log('ok  : mid-loop HTTP error surfaces and stops');
}

console.log('ALL TOOL-LOOP PASS');
