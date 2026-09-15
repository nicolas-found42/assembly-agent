// research.test.mjs — the mandated initial research + query-planning boundary.
// Runs real runTurn() turns against canned SSE streams (no network) and a
// seam-level search adapter, exactly like tool-loop.mjs. Covers: the planner
// unit cases, research-before-answer for every question shape and both model
// tool capabilities, cache bypass, minimization at the doSearch boundary,
// failure/empty/partial results, the research budget, cancellation during
// research, mid-turn key removal, and the wording-correction pass.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── browser shims (bridge -> search.js touches window+localStorage) ──
globalThis.window = globalThis;
globalThis.location = { origin: 'http://localhost:8000' };
globalThis.document = { createElement: () => ({}), querySelector: () => null, body: { appendChild: () => {} } };
globalThis.localStorage = {};

const WASM = readFileSync(new URL('../dist/agent.wasm', import.meta.url));
const enc = new TextEncoder();

const answer = 'A plain answer.';
const SYSTEM = 'You are ASM::AGENT, a helpful and careful assistant.';

// ── canned SSE bodies ────────────────────────────────────────────────────
const sse = (lines) => new Response(
  new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(enc.encode(`data: ${l}\n\n`)); c.close(); },
  }),
  { headers: { 'content-type': 'text/event-stream' } },
);
const textSSE = (text) => sse([
  JSON.stringify({ choices: [{ delta: { content: text } }] }),
  '[DONE]',
]);
const toolCallSSE = (id, query) => sse([
  JSON.stringify({ choices: [{ delta: { tool_calls: [{ id, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query }) } }] } }] }),
  '[DONE]',
]);

// ── seam + fetch stubs ───────────────────────────────────────────────────
const STUB_MD = '### [STUB] fixture\nhttps://stub.example/x\nbody\n';
const record = (over = {}) => ({ markdown: STUB_MD, sources: 1, failures: [], perSource: [{ tag: 'STUB', hits: 1, ms: 0 }], ...over });
function stubSearch(rec = record()) {
  const seen = [];
  const search = async (query, opts) => { seen.push({ query, opts, chatCalls: calls.length }); return rec; };
  search.seen = seen;
  return search;
}

let script = [];
let calls = [];
globalThis.fetch = async (url, opts) => {
  if (String(url) === 'dist/agent.wasm') return new Response(WASM);
  calls.push(JSON.parse(opts.body));
  const next = script.shift();
  assert.ok(next, `unexpected extra chat call #${calls.length}`);
  return next();
};

const bridge = await import('../js/bridge.js');
const { planQuery, minimizeQuery, MAX_RESEARCH_ROUNDS } = await import('../js/research.js');
const { BUDGET_NUDGE } = bridge;
await bridge.initEngine();

/** One runTurn() with a canned script. Overrides mirror the shipped opts. */
async function drive(text, responses, opts = {}) {
  const {
    system = SYSTEM, key = '', model = 'x/y:free', search = stubSearch(),
    persist = null, tools, retry, correct, acceptCorrection, seed = [],
  } = opts;
  const keyFn = typeof key === 'function' ? key : () => key;
  bridge.clearHistory();
  for (const [role, content] of seed) bridge.appendHistory(role, content);
  script = responses.slice();
  calls = [];
  const events = [];
  const persists = [];
  const seen = { rounds: 0, finals: [], errors: [], tools: [], done: 0 };
  const on = (ev) => {
    events.push(ev);
    switch (ev.type) {
      case 'round-started': seen.rounds++; break;
      case 'round-final': seen.finals.push(ev.text); break;
      case 'errored': seen.errors.push(ev.message); break;
      case 'tool-started': seen.tools.push(ev.query); break;
      case 'done': seen.done++; break;
      default: break;
    }
  };
  const summary = await bridge.runTurn(text, {
    system, getKey: keyFn, model, on,
    persist: persist || (() => persists.push(calls.length)),
    search, tools, retry, correct, acceptCorrection,
  });
  return { events, seen, persists, summary, search, calls: calls.slice() };
}

const kinds = (out) => out.events.map((e) => e.type);

/** Assert the turn researched before it answered, whatever the question was. */
function assertResearchedFirst(out, label, expected) {
  assert.equal(kinds(out)[0], 'research-started', `${label}: the turn opens with research`);
  assert.equal(kinds(out)[1], 'research-finished', `${label}: research settles before any model round`);
  assert.equal(kinds(out)[2], 'round-started', `${label}: the first model round follows research`);
  assert.equal(out.search.seen[0].chatCalls, 0, `${label}: no chat POST happens before the research fetch`);
  assert.deepEqual(out.search.seen[0].opts, { fresh: true }, `${label}: the initial lookup asks for fresh results`);
  assert.match(out.search.seen[0].query, expected, `${label}: planned query`);
  assert.equal(out.seen.finals.length, 1, `${label}: exactly one answer`);
  assert.equal(out.seen.done, 1, `${label}: turn closes once`);
}

// ── 1. planner units: minimizeQuery is the privacy boundary ─────────────
{
  const q1 = minimizeQuery('contact jane.doe@example.com about the weather in Paris');
  assert.ok(!q1.includes('jane.doe@example.com'), 'minimize: email stripped');
  assert.ok(q1.includes('weather') && q1.includes('Paris'), 'minimize: public topic kept');
  assert.ok(!/\b(the|in|about)\b/i.test(q1), 'minimize: filler words dropped from every query');
  assert.match(minimizeQuery('What is the tallest building in the world?'), /^tallest building world/i,
    'minimize: interrogative filler stripped from a plain question');

  assert.ok(!minimizeQuery('my key is sk-or-abc123 use it').includes('sk-or'), 'minimize: sk-or key stripped');
  assert.ok(!minimizeQuery('send bearer abcdef0123456789 now').includes('abcdef0123456789'), 'minimize: bearer token stripped');
  assert.ok(!minimizeQuery('Authorization: Bearer abcdef0123456789').includes('abcdef0123456789'), 'minimize: header token stripped');
  assert.ok(!minimizeQuery('use tvly-dev-abcdef123456 for this').includes('tvly-'), 'minimize: tvly key stripped');
  assert.ok(!minimizeQuery('key BSAabcdef1234567890 here').includes('BSAabcdef'), 'minimize: brave key stripped');
  assert.ok(!minimizeQuery('jina_abcdef1234567890 token').includes('jina_'), 'minimize: jina key stripped');
  assert.ok(!minimizeQuery('api_key=abcdef1234567890 works').includes('abcdef1234567890'), 'minimize: labeled key stripped');

  const longQuoted = `summarize "${'s'.repeat(500)}"`;
  assert.ok(!minimizeQuery(longQuoted).includes('ssss'), 'minimize: long quoted span stripped');
  assert.equal(minimizeQuery(longQuoted), 'summarize', 'minimize: surrounding words survive');
  assert.equal(minimizeQuery("I can't believe it won't work, it doesn't matter"),
    "can't believe won't work, doesn't matter",
    'minimize: apostrophes are not quote spans; filler goes, contractions stay');

  const urlQuery = minimizeQuery('read https://example.com/page?token=secret123 now');
  assert.ok(!urlQuery.includes('secret123'), 'minimize: URL query string stripped');
  assert.ok(urlQuery.includes('https://example.com/page'), 'minimize: URL base kept');

  const many = minimizeQuery(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '));
  assert.ok(many.split(' ').length <= 12, 'minimize: capped at 12 tokens');
  const longTokens = minimizeQuery(Array.from({ length: 20 }, () => 'averylongtoken'.repeat(3)).join(' '));
  assert.ok(longTokens.length <= 160, 'minimize: capped at 160 characters');
  assert.equal(minimizeQuery('   '), '', 'minimize: blank stays blank');
  console.log('ok  : minimizeQuery strips secrets, quotes and URL params, caps size');
}

// ── 2. planner units: planQuery branches ────────────────────────────────
{
  assert.equal(planQuery('hi'), 'assistant greeting etiquette', 'plan: greeting -> etiquette query');
  assert.equal(planQuery('Hello!'), 'assistant greeting etiquette', 'plan: greeting punctuation tolerated');
  assert.equal(planQuery('hey there'), 'assistant greeting etiquette', 'plan: "hey there" is a greeting');

  const PRIVATE = 'Please write an email to my landlord about the broken sink in the kitchen and explain that the repair was never done, that I have asked twice, and that I would like a reduction in the rent until it is fixed.';
  const privateQ = planQuery(PRIVATE);
  assert.equal(privateQ, 'how to write a clear email', 'plan: private writing ask -> task guidance');
  assert.ok(!/landlord|kitchen|sink|rent|repair/i.test(privateQ), 'plan: private material never reaches the query');

  const followQ = planQuery('continue', { history: ['what is a binary search tree', 'ok thanks'] });
  assert.equal(followQ, 'binary search tree', 'plan: continuation borrows the substantive earlier message');
  assert.equal(planQuery('shorter', { history: [] }), 'general knowledge', 'plan: continuation without history -> generic');
  assert.equal(planQuery('continue', { history: [PRIVATE] }), 'how to write a clear email',
    'plan: continuation reuses the private-writing derivation, not the private text');

  const translateQ = planQuery('translate this into French: the meeting is on Monday');
  assert.equal(translateQ, 'French translation', 'plan: translation -> target language + translation');
  assert.ok(planQuery('translate this text into Spanish please').includes('translation'), 'plan: translation asks always mention translation');

  assert.equal(planQuery('who won the 2018 world cup'), 'won 2018 world cup', 'plan: default -> minimized user text');
  assert.equal(planQuery(''), 'general knowledge', 'plan: empty -> generic query');
  assert.equal(planQuery('sk-or-abc123'), 'general knowledge', 'plan: fully stripped -> generic query');
  console.log('ok  : planQuery branches are deterministic and private');
}

// ── 3. invariant: research precedes the answer for every question shape ──
{
  const PRIVATE = 'Please write an email to my landlord about the broken sink in the kitchen and explain that the repair was never done, that I have asked twice, and that I would like a reduction in the rent until it is fixed.';
  const scenarios = [
    { name: 'default persona', text: 'explain the water cycle', system: SYSTEM, expect: /water cycle/ },
    {
      name: 'assistant that forbids searching', text: 'explain the water cycle',
      system: 'Never search the web. Answer only from what you already know.', expect: /water cycle/,
    },
    { name: 'greeting', text: 'hello', system: SYSTEM, expect: /greeting/ },
    {
      name: 'follow-up', text: 'continue', system: SYSTEM,
      seed: [[1, 'what is a binary search tree']], expect: /binary search tree/,
    },
    { name: 'private writing', text: PRIVATE, system: SYSTEM, expect: /write/, forbid: /landlord|sink|rent/i },
    { name: 'translation', text: 'translate this into French: the meeting is on Monday', system: SYSTEM, expect: /translation/ },
    {
      name: 'retry', text: 'explain the water cycle', system: SYSTEM,
      seed: [[1, 'explain the water cycle'], [2, '']], retry: true, expect: /water cycle/,
    },
    {
      // turn 2 continuation: the stored research message of turn 1 is not "user text"
      name: 'follow-up after a researched turn', text: 'continue', system: SYSTEM,
      seed: [
        [1, 'what is a binary search tree'], [2, 'A tree, sorted.'],
        [1, `Web search results for "binary search tree":\n\n### [STUB] huge blob\nhttps://stub.example/bst\nlots of result text`],
        [2, 'Trees keep order.'],
      ],
      expect: /binary search tree$/, forbid: /huge blob|stub\.example/,
    },
  ];
  for (const s of scenarios) {
    for (const tools of [false, true]) {
      const label = `${s.name} (${tools ? 'tools offered' : 'no tools'})`;
      const out = await drive(s.text, [() => textSSE(answer)], {
        system: s.system, seed: s.seed, retry: s.retry, tools,
      });
      assertResearchedFirst(out, label, s.expect);
      if (s.forbid) {
        assert.ok(!s.forbid.test(out.search.seen[0].query), `${label}: the query carries no private words`);
      }
      assert.equal(out.calls[0].tools === undefined, !tools, `${label}: tool declaration follows opts.tools`);
      assert.equal(out.calls[0].messages[0].content, s.system, `${label}: the caller system prompt rides the request`);
    }
  }
  // A tools-capable model that does call the tool: research still comes first.
  const out = await drive('explain the water cycle', [
    () => toolCallSSE('call_1', 'water cycle evaporation'),
    () => textSSE(answer),
  ]);
  assertResearchedFirst(out, 'tool-calling model', /water cycle/);
  assert.deepEqual(out.search.seen.map((s) => s.query), ['explain water cycle', 'water cycle evaporation'],
    'tool-calling model: initial research (minimized), then the model-initiated search');
  assert.equal(out.search.seen[1].opts, undefined, 'tool-calling model: later searches may reuse the cache');
  assert.equal(out.seen.finals.length, 1, 'tool-calling model: one final answer');
  console.log('ok  : initial research precedes the answer for every shape and both capabilities');
}

// ── 4. minimization at the doSearch boundary, initial and model-initiated ──
{
  const out = await drive('look up sk-or-abc123 and jane.doe@example.com for the weather in Paris', [() => textSSE(answer)]);
  const initial = out.search.seen[0].query;
  assert.ok(!initial.includes('sk-or-abc123'), 'boundary: initial query drops the API key');
  assert.ok(!initial.includes('jane.doe@example.com'), 'boundary: initial query drops the email');
  assert.ok(initial.includes('weather') && initial.includes('Paris'), 'boundary: initial query keeps the topic');

  const quoted = await drive(`what does this passage mean: "${'s'.repeat(500)}"`, [() => textSSE(answer)]);
  assert.ok(!quoted.search.seen[0].query.includes('ssss'), 'boundary: initial query drops a 500-char quoted secret');

  const modelQuery = `sk-or-abc123 jane.doe@example.com "${'s'.repeat(500)}" weather`;
  const toolOut = await drive('q', [
    () => toolCallSSE('call_1', modelQuery),
    () => textSSE(answer),
  ]);
  const searched = toolOut.search.seen[1].query;
  assert.ok(!searched.includes('sk-or-abc123'), 'boundary: model query drops the API key');
  assert.ok(!searched.includes('jane.doe@example.com'), 'boundary: model query drops the email');
  assert.ok(!searched.includes('ssss'), 'boundary: model query drops the quoted secret');
  assert.ok(searched.includes('weather'), 'boundary: model query keeps the topic');
  assert.equal(toolOut.seen.tools[0], searched, 'boundary: tool-started reports what was actually searched');
  console.log('ok  : queries are minimized at the doSearch boundary');
}

// ── 5. failure, empty and partial results still answer exactly once ─────
{
  const failure = await drive('q', [() => textSSE(answer)], {
    search: stubSearch(record({ markdown: '', sources: 0, failures: ['wikipedia'], perSource: [] })),
  });
  assert.equal(failure.seen.finals.length, 1, 'failure: still exactly one answer');
  const notice = failure.calls[0].messages.at(-1).content;
  assert.ok(notice.startsWith('Web search results for "q":'), 'failure: the notice names the query');
  assert.match(notice, /no usable results/, 'failure: the notice is explicit about the failure');
  const fin = failure.events.find((e) => e.type === 'research-finished');
  assert.deepEqual(fin.failures, ['wikipedia'], 'failure: research-finished reports the failed source');
  assert.equal(fin.markdown, '', 'failure: research-finished reports no markdown, never invented results');

  const empty = await drive('q', [() => textSSE(answer)], {
    search: stubSearch(record({ markdown: '   ', sources: 0, perSource: [] })),
  });
  assert.equal(empty.seen.finals.length, 1, 'empty: still exactly one answer');
  assert.match(empty.calls[0].messages.at(-1).content, /no usable results/, 'empty: failure line explains itself');

  const partial = await drive('q', [() => textSSE(answer)], {
    search: stubSearch(record({ failures: ['espn'] })),
  });
  assert.equal(partial.seen.finals.length, 1, 'partial: still exactly one answer');
  assert.ok(partial.calls[0].messages.at(-1).content.includes(STUB_MD.trim()), 'partial: real markdown still used');

  // No answer may start while the research is still in flight.
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = [];
  const deferred = async (query, opts) => { seen.push({ query, opts, chatCalls: calls.length }); await gate; return record(); };
  deferred.seen = seen;
  const pending = drive('q', [() => textSSE(answer)], { search: deferred });
  assert.equal(calls.length, 0, 'pending research: no chat POST yet');
  assert.ok(bridge.streaming(), 'pending research: the turn counts as streaming');
  release();
  const settled = await pending;
  assert.equal(settled.seen.finals.length, 1, 'pending research: the answer comes after research settles');
  assert.equal(seen[0].chatCalls, 0, 'pending research: the research call itself came before any chat POST');
  console.log('ok  : failure/empty/partial results answer once, never before research settles');
}

// ── 6. budget: the initial lookup spends round 1 of MAX_RESEARCH_ROUNDS ──
{
  const responses = [];
  for (let i = 0; i < MAX_RESEARCH_ROUNDS - 1; i++) responses.push(() => toolCallSSE(`c${i}`, `q${i}`));
  responses.push(() => textSSE('the final answer'));
  const out = await drive('hard question', responses);

  assert.equal(out.search.seen.length, MAX_RESEARCH_ROUNDS, `budget: ${MAX_RESEARCH_ROUNDS} searches in total`);
  assert.equal(out.seen.tools.length, MAX_RESEARCH_ROUNDS - 1, 'budget: the model spends the remaining rounds');
  assert.equal(out.calls.filter((c) => c.tools).length <= MAX_RESEARCH_ROUNDS, true, 'budget: never more tool rounds than the cap');
  assert.equal(out.calls.length, MAX_RESEARCH_ROUNDS, 'budget: the capped turn still makes the answer round');
  const last = out.calls.at(-1);
  assert.equal(last.tools, undefined, 'budget: the 5th model round runs with tools disabled');
  assert.equal(last.messages.findLastIndex((m) => m.content === BUDGET_NUDGE), last.messages.length - 1,
    'budget: the nudge is the last message and stays out of history');
  assert.equal(bridge.historyMessages().some((m) => m.content === BUDGET_NUDGE), false, 'budget: nudge never persisted');
  assert.deepEqual(out.seen.finals, ['the final answer'], 'budget: the forced pass produces the answer');
  console.log('ok  : initial + 4 tool rounds -> final tools-disabled pass');
}

// ── 7. stop() during research: no answer, no later POST, aborted ────────
{
  let streamingDuringResearch = false;
  const search = async () => {
    streamingDuringResearch = bridge.streaming();
    bridge.stop();
    return record();
  };
  const out = await drive('q', [() => textSSE('must never be sent')], { search });
  assert.equal(streamingDuringResearch, true, 'cancel: the turn is in flight while research runs');
  assert.equal(calls.length, 0, 'cancel: no chat POST after stop');
  assert.equal(out.seen.finals.length, 0, 'cancel: no fabricated answer');
  assert.equal(out.seen.rounds, 0, 'cancel: no model round starts');
  assert.equal(out.summary.aborted, true, 'cancel: summary reports the abort');
  assert.equal(out.summary.ok, false, 'cancel: summary is not ok');
  assert.ok(kinds(out).includes('aborted'), 'cancel: aborted event emitted');
  assert.equal(kinds(out).at(-1), 'done', 'cancel: turn closes with done');
  assert.equal(bridge.streaming(), false, 'cancel: the turn is no longer streaming');
  console.log('ok  : stop() during research -> no chat POST, no answer, aborted');
}

// ── 8. key removed mid-turn: the next paid round never starts ───────────
{
  // Key present until the first paid POST has happened, gone afterwards.
  const key = () => (calls.length === 0 ? 'sk-or-first' : '');
  const out = await drive('q', [() => toolCallSSE('c1', 'q1'), () => textSSE('never sent')], {
    key, model: 'openai/gpt-4o',
  });
  assert.equal(calls.length, 1, 'key removal: only the first paid POST happened');
  assert.equal(out.seen.errors.length, 1, 'key removal: one error surfaces');
  assert.match(out.seen.errors[0], /removed/, 'key removal: clear message');
  assert.equal(out.seen.rounds, 1, 'key removal: the second round never starts');
  assert.equal(out.summary.ok, false, 'key removal: summary reports failure');
  assert.match(out.summary.error, /removed/, 'key removal: summary carries the error');
  assert.equal(out.calls[0].messages.some((m) => m.role === 'user' && m.content.startsWith('Web search results')), true,
    'key removal: research still ran in the first round');
  console.log('ok  : key removal mid-turn stops before the next paid POST');
}

{
  const CORRECT = 'Check the wording. Rewrite the answer in simple English. Keep the same facts.';
  const out = await drive('q', [() => textSSE('first answer'), () => textSSE('corrected answer')], { correct: CORRECT });
  assert.deepEqual(out.seen.finals, ['first answer', 'corrected answer'], 'correct: final is re-emitted after the rewrite');
  assert.equal(out.summary.text, 'corrected answer', 'correct: summary carries the corrected answer');
  assert.equal(out.calls.length, 2, 'correct: exactly one extra round');
  assert.equal(out.calls[1].tools, undefined, 'correct: tools disabled in the rewrite round');
  assert.equal(out.calls[1].messages.at(-1).content, CORRECT, 'correct: instructions are the final user message');
  assert.equal(out.calls.filter((c) => c.messages.some((m) => m.content === CORRECT)).length, 1, 'correct: never more than one rewrite');
  assert.deepEqual(out.search.seen.map((s) => s.query), ['q'], 'correct: research is not reopened');
  assert.equal(out.seen.errors.length, 0, 'correct: no error surfaced');
  assert.equal(out.persists.length >= 2, true, 'correct: the turn saves the settled answer');
  // The selected model id must ride on EVERY chat POST body — a dropped
  // model field makes the Proxy answer 403 NOT_FREE (regression).
  assert.equal(out.calls.every((c) => c.model === 'x/y:free'), true,
    'correct: every POST body carries the selected model id');
  const paid = await drive('q', [() => textSSE('paid answer')], { key: 'sk-or-test', model: 'openai/gpt-x' });
  assert.equal(paid.calls.every((c) => c.model === 'openai/gpt-x'), true,
    'byo: every POST body carries the selected model id');


  // A failing rewrite keeps the original answer and stays quiet about it.
  const fail = await drive('q', [
    () => textSSE('first answer'),
    () => new Response(JSON.stringify({ error: { message: 'upstream broke' } }), { status: 500 }),
  ], { correct: CORRECT });
  assert.deepEqual(fail.seen.finals, ['first answer'], 'correct failure: the original answer stands alone');
  assert.equal(fail.summary.ok, true, 'correct failure: the turn is still a success');
  assert.equal(fail.summary.text, 'first answer', 'correct failure: summary keeps the original');
  assert.deepEqual(fail.seen.errors, [], 'correct failure: no error is shown for the optional pass');

  // An empty rewrite keeps the original answer too.
  const blank = await drive('q', [() => textSSE('first answer'), () => textSSE('   ')], { correct: CORRECT });
  assert.equal(blank.summary.text, 'first answer', 'correct empty: summary keeps the original');
  assert.deepEqual(blank.seen.finals, ['first answer'], 'correct empty: no empty final emitted');
  console.log('ok  : correction runs once, tools off, keeps the answer on failure');
}

// ── 10. history integrity: superseded drafts never destroy the standing answer
{
  const lastAssistant = () => {
    const msgs = bridge.historyMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 2 && !msgs[i].tool_call_id) return msgs[i].content;
    }
    return null;
  };

  // A zero-output correction failure must leave the original in context.
  await drive('q', [
    () => textSSE('the standing answer'),
    () => new Response(JSON.stringify({ error: { message: 'wiring down' } }), { status: 500 }),
  ], { correct: 'Rewrite the answer in simple English.' });
  assert.equal(lastAssistant(), 'the standing answer', 'correct fail: the original answer stays in history');

  // A rewrite rejected by acceptCorrection is dropped, the original stays.
  await drive('q', [() => textSSE('the standing answer'), () => textSSE('a rewrite')], {
    correct: 'Rewrite the answer in simple English.',
    acceptCorrection: () => false,
  });
  assert.equal(lastAssistant(), 'the standing answer', 'correct rejected: the original answer stays in history');
  const afterReject = bridge.historyMessages();
  assert.equal(afterReject.filter((m) => m.role === 2 && m.content === 'a rewrite').length, 0,
    'correct rejected: the rejected rewrite leaves no trace');

  // An accepted rewrite replaces the draft: exactly one assistant answer remains.
  await drive('q', [() => textSSE('the standing answer'), () => textSSE('the corrected answer')], {
    correct: 'Rewrite the answer in simple English.',
  });
  const afterAccept = bridge.historyMessages().filter((m) => m.role === 2 && !m.tool_call_id);
  assert.equal(afterAccept.length, 1, 'correct accepted: exactly one assistant answer in context');
  assert.equal(afterAccept[0].content, 'the corrected answer', 'correct accepted: the rewrite is the answer');

  // An empty hedge attempt leaves the original denial answer standing.
  await drive('q', [() => textSSE('There is no such thing.'), () => textSSE('   ')]);
  assert.equal(lastAssistant(), 'There is no such thing.', 'hedge empty: the original answer stays in history');

  console.log('ok  : failed or rejected rewrites never remove the standing answer');
}

console.log('ALL RESEARCH PASS');
