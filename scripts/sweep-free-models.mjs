// sweep-free-models.mjs — live Capability Tier Sweep over every Free Model.
//
// Drives the REAL dist/agent.wasm + js/bridge.js over the Proxy, so the Scanner
// under test is the one we ship. Search is canned (fixed markdown per task) so
// the model is the only variable; every raw SSE stream is saved, because a live
// failure only becomes an offline regression if you kept the bytes.
//
// Usage:  node scripts/sweep-free-models.mjs [--only substr] [--limit N]
//                                            [--run .scratch/sweep/<dir>] [--rpm 20]
// Resumes: a model with a results file in the run dir is skipped.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);

const RPM = Number(arg('--rpm', 20));
const GAP_MS = Math.ceil(60000 / RPM);           // one request at a time, paced
const ONLY = arg('--only');
const LIMIT = Number(arg('--limit', 0));
const STAMP = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const RUN = arg('--run') || join(ROOT, '.scratch/sweep', STAMP);

// ── browser shims (bridge -> search.js/sessions.js touch window+localStorage) ──
globalThis.window = globalThis;
globalThis.location = { origin: 'http://localhost:8000' };
globalThis.document = { createElement: () => ({}), querySelector: () => null, body: { appendChild: () => {} } };
globalThis.localStorage = {};                     // no keys -> keyless search only

const WASM = readFileSync(join(ROOT, 'dist/agent.wasm'));
const write = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const slug = (id) => id.replace(/[^a-z0-9]+/gi, '_');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── canned search corpus ───────────────────────────────────────────────
// Shaped as the real upstream APIs, so js/search.js does its real parsing,
// fmt() and URL-dedupe work. T4 is well-formed but about the wrong subject:
// empty markdown would make tool_result_flush skip the role:"tool" entry, and
// a model that receives nothing correctly answers from its own knowledge, so
// the Search Budget would never be exhausted and L4 never measured.
const CORPUS = {
  zig: {
    wikipedia: { query: { search: [{ title: 'Zig (programming language)', snippet: 'Zig is a general-purpose <b>programming language</b>. Version 0.15.2 is the current stable release.' }] } },
    hn: { hits: [{ title: 'Zig 0.15.2 released', url: 'https://ziglang.org/download/0.15.2/release-notes.html', points: 412, num_comments: 190 }] },
    ddg: { Heading: 'Zig', AbstractText: 'Zig 0.15.2 is the current stable release of the Zig programming language.', AbstractURL: 'https://ziglang.org/', RelatedTopics: [] },
    se: { items: [{ title: 'How do I check my Zig version?', link: 'https://stackoverflow.com/q/70000001', score: 24, is_answered: true }] },
    gh: { items: [{ full_name: 'ziglang/zig', html_url: 'https://github.com/ziglang/zig', stargazers_count: 38000, description: 'General-purpose programming language and toolchain' }] },
  },
  rust: {
    wikipedia: { query: { search: [{ title: 'Rust (programming language)', snippet: 'Rust first appeared in 2010 and reached 1.0 in May 2015.' }] } },
    hn: { hits: [{ title: 'Announcing Rust 1.0', url: 'https://blog.rust-lang.org/2015/05/15/Rust-1.0.html', points: 1400, num_comments: 500 }] },
    ddg: { Heading: 'Rust', AbstractText: 'Rust 1.0 was released on 15 May 2015. Zig first appeared in 2016.', AbstractURL: 'https://www.rust-lang.org/', RelatedTopics: [] },
    se: { items: [{ title: 'When was Rust 1.0 released?', link: 'https://stackoverflow.com/q/70000002', score: 31, is_answered: true }] },
    gh: { items: [{ full_name: 'rust-lang/rust', html_url: 'https://github.com/rust-lang/rust', stargazers_count: 98000, description: 'Empowering everyone to build reliable software' }] },
  },
  // Well-formed, plausible, and about something else entirely.
  irrelevant: {
    wikipedia: { query: { search: [{ title: 'Sourdough', snippet: 'Sourdough bread is made by the fermentation of dough using wild <b>lactobacillaceae</b> and yeast.' }] } },
    hn: { hits: [{ title: 'My sourdough starter is three years old', url: 'https://example.com/sourdough-starter', points: 88, num_comments: 41 }] },
    ddg: { Heading: 'Sourdough', AbstractText: 'Sourdough is a bread made by fermenting dough with naturally occurring lactobacilli.', AbstractURL: 'https://en.wikipedia.org/wiki/Sourdough', RelatedTopics: [] },
    se: { items: [{ title: 'Why is my dough not rising?', link: 'https://cooking.stackexchange.com/q/12345', score: 9, is_answered: true }] },
    gh: { items: [{ full_name: 'hendricius/the-bread-code', html_url: 'https://github.com/hendricius/the-bread-code', stargazers_count: 3000, description: 'Learn how to master the art of baking' }] },
  },
};

// ── task battery ───────────────────────────────────────────────────────
// fixture(round) picks the corpus entry for that Tool Round, so T3 can answer
// a second, different search.
const TASKS = [
  {
    id: 'T1', repeats: 3, expectSearch: true,
    prompt: 'What is the current stable version of the Zig programming language?',
    fixture: () => CORPUS.zig,
    measures: ['L1', 'L2', 'L3'],
  },
  {
    id: 'T2', repeats: 1, expectSearch: false,
    prompt: 'What is 17 multiplied by 3? Answer with the number.',
    fixture: () => CORPUS.zig,
    measures: [],
  },
  {
    id: 'T3', repeats: 1, expectSearch: true,
    prompt: 'Which came first, the 1.0 release of Rust or the first appearance of Zig? Search for each separately.',
    fixture: (round) => (round === 0 ? CORPUS.zig : CORPUS.rust),
    measures: ['L1', 'L2'],
  },
  {
    id: 'T4', repeats: 1, expectSearch: true,
    prompt: 'What is the current stable version of the Zig programming language?',
    fixture: () => CORPUS.irrelevant,
    measures: ['L1', 'L4'],
  },
];

// ── fetch interceptor ──────────────────────────────────────────────────
// Chat calls go to the real Proxy. Search calls are served from the corpus.
// Chat bodies are buffered, then re-emitted with the ORIGINAL chunk boundaries:
// the Scanner sees byte-for-byte what the network produced, and we get the raw
// text for finish_reason before bridge consumes the stream.
let CASE = null;      // { fixture, statuses[], raws[], round }
const realFetch = globalThis.fetch;
const jsonRes = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u === 'dist/agent.wasm') return new Response(WASM);

  const f = CASE?.fixture?.(CASE.round) ?? CORPUS.zig;
  if (u.includes('wikipedia.org')) return jsonRes(f.wikipedia);
  if (u.includes('hn.algolia.com')) return jsonRes(f.hn);
  if (u.includes('api.duckduckgo.com')) return jsonRes(f.ddg);
  if (u.includes('api.stackexchange.com')) return jsonRes(f.se);
  if (u.includes('api.github.com')) return jsonRes(f.gh);

  const isChat = u.includes('/api/chat') || u.includes('openrouter.ai');
  if (!isChat) throw new Error(`offline: ${u}`);

  if (CASE) await sleep(GAP_MS);                  // pace only real network calls
  const res = await realFetch(url, opts);
  CASE?.statuses.push(res.status);

  if (!res.ok) {                                  // let bridge read the error body
    const text = await res.text();
    CASE?.raws.push(text);
    return new Response(text, { status: res.status, headers: res.headers });
  }

  const chunks = [];
  const reader = res.body.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  CASE?.raws.push(Buffer.concat(chunks.map(Buffer.from)).toString('utf8'));

  return new Response(new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); },
  }), { status: res.status, headers: res.headers });
};

// ── engine ─────────────────────────────────────────────────────────────
const bridge = await import(join(ROOT, 'js/bridge.js'));
const { MAX_TOOL_ROUNDS } = bridge;
const { PRESETS } = await import(join(ROOT, 'js/sessions.js'));
const SYSTEM = PRESETS['BASIC AGENT'];
await bridge.initEngine();

/** Run one (model, task, repeat). Never throws: a crash is a recorded result. */
async function runCase(model, task, rep) {
  CASE = { fixture: task.fixture, statuses: [], raws: [], round: 0 };
  const seen = { rounds: 0, queries: [], finals: [], errors: [], delta: '' };
  bridge.clearHistory();
  bridge.appendHistory(0, SYSTEM);
  let crash = null;
  try {
    await bridge.send(task.prompt, {
      onRoundStart() { seen.rounds++; },
      onDelta(d) { seen.delta += d; },
      onToolStart(n, a) { seen.queries.push({ name: n, query: a.query }); },
      onToolDone() { CASE.round++; },
      onRoundFinal(t) { seen.finals.push(t); },
      onError(m) { seen.errors.push(String(m)); },
      onDone() {},
    }, { key: '', model });
  } catch (err) { crash = String(err?.stack || err); }

  const raw = CASE.raws.join('\n\n===== next request =====\n\n');
  const rawPath = join(RUN, 'raw', slug(model), `${task.id}.${rep}.sse`);
  write(rawPath, raw);
  const c = { ...CASE };
  CASE = null;

  return {
    task: task.id, rep, statuses: c.statuses, crash,
    rounds: seen.rounds, toolCalls: seen.queries, errors: seen.errors,
    final: seen.finals.at(-1) ?? '',
    finishReasons: [...raw.matchAll(/"finish_reason"\s*:\s*"([^"]+)"/g)].map((m) => m[1]),
    usage: (() => { const m = raw.match(/"usage"\s*:\s*(\{[^}]*\})/); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } })(),
    charsOut: seen.delta.length,
    toolText: lastToolText(),
    rawPath: rawPath.replace(ROOT, ''),
  };
}

/** The canned markdown the model actually received, for quality check 3. */
function lastToolText() {
  return bridge.historyMessages().filter((m) => m.role === 3).map((m) => m.content).join('\n');
}

// ── scoring ────────────────────────────────────────────────────────────
const STOP = new Set(['what', 'which', 'the', 'is', 'of', 'and', 'for', 'with', 'answer', 'search', 'separately', 'current', 'each', 'first']);
const words = (s) => String(s).toLowerCase().match(/[a-z0-9.]{4,}/g) || [];

// Not the model's fault: a 429, or a provider outage delivered INSIDE a 200
// stream (OpenRouter forwards 502/503/504 as an SSE error event, so the HTTP
// status is 200 and the turn still dies). Both mean "not tested".
const OUTAGE = /rate.?limit|too many requests|upstream|overloaded|temporarily|idle timeout|unavailable/i;
const throttled = (r) => r.statuses.includes(429) || r.errors.some((e) => OUTAGE.test(e));
const rejected = (r) => r.statuses.some((s) => s >= 400 && s !== 429);
const calledTool = (r) => r.toolCalls.some((t) => t.name === 'web_search');
const fallback = (r) => /^Search budget \(\d+ rounds\) spent/.test(r.final.trim());

/** L2 is a mechanical proxy, not a judgement: does the query share a
 *  significant word with the question it was asked? */
const queryRelevant = (r, task) => {
  const want = new Set(words(task.prompt).filter((w) => !STOP.has(w)));
  return r.toolCalls.some((t) => words(t.query).some((w) => want.has(w)));
};

function quality(r) {
  const final = r.final.trim();
  const urls = [...r.toolText.matchAll(/https?:\/\/\S+/g)].map((m) => m[0].replace(/[.,)]+$/, ''));
  const sentences = final.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length >= 40);
  return {
    nonEmpty: final.length > 0,
    notFallback: final.length > 0 && !fallback(r),
    citesResult: urls.some((u) => final.includes(u)),
    noLoop: new Set(sentences).size === sentences.length,
  };
}

/** Levels are computed per model across its whole battery. n/a is not a fail. */
function tierFor(results) {
  const by = (id) => results.filter((r) => r.task === id && !throttled(r));
  const t1 = by('T1'), t3 = by('T3'), t4 = by('T4'), t2 = by('T2');
  const searchTasks = [...t1, ...t3, ...t4];
  const na = 'n/a';

  const L0 = searchTasks.length === 0 ? na : !searchTasks.every(rejected);
  const L1 = searchTasks.length === 0 ? na : searchTasks.some(calledTool);
  const L2 = (() => {
    const cands = [...t1, ...t3].filter(calledTool);
    if (!cands.length) return na;
    return cands.some((r) => queryRelevant(r, TASKS.find((t) => t.id === r.task)));
  })();
  // L3 — stopped by itself, inside the Search Budget, with a real answer.
  const L3 = (() => {
    const cands = t1.filter(calledTool);
    if (!cands.length) return na;
    return cands.some((r) => r.toolCalls.length < MAX_TOOL_ROUNDS && quality(r).notFallback);
  })();
  // L4 — only observable when the Search Budget actually ran out.
  const L4 = (() => {
    const spent = t4.filter((r) => r.toolCalls.length >= MAX_TOOL_ROUNDS);
    if (!spent.length) return na;
    return spent.some((r) => quality(r).notFallback);
  })();

  const levels = { L0, L1, L2, L3, L4 };
  let tier = -1;
  for (const [k, v] of Object.entries(levels)) if (v === true) tier = Number(k[1]);
  return {
    tier, levels,
    t1Passes: `${t1.filter((r) => quality(r).notFallback && calledTool(r)).length}/${t1.length || 0}`,
    t2NoSearch: t2.length ? !t2.some(calledTool) : na,   // yes == correct: it did not search
    worstStatus: Math.max(0, ...results.flatMap((r) => r.statuses)),
    throttledCases: results.filter(throttled).map((r) => `${r.task}.${r.rep}`),
  };
}

// ── model list ─────────────────────────────────────────────────────────
async function freeModels() {
  const r = await realFetch('https://openrouter.ai/api/v1/models');
  if (!r.ok) throw new Error(`models list: HTTP ${r.status}`);
  const all = (await r.json()).data || [];
  return all
    .filter((m) => String(m.id).endsWith(':free'))
    .filter((m) => !ONLY || m.id.includes(ONLY))
    .map((m) => ({ id: m.id, ctx: m.context_length || 0, declaresTools: (m.supported_parameters || []).includes('tools') }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ── run ────────────────────────────────────────────────────────────────
const models = await freeModels();
const todo = LIMIT ? models.slice(0, LIMIT) : models;
mkdirSync(join(RUN, 'models'), { recursive: true });
console.log(`sweep -> ${RUN.replace(ROOT, '')}`);
console.log(`${todo.length} Free Model(s), ${TASKS.reduce((n, t) => n + t.repeats, 0)} cases each, ${GAP_MS}ms between requests\n`);

for (const m of todo) {
  const out = join(RUN, 'models', `${slug(m.id)}.json`);
  if (existsSync(out)) { console.log(`skip  ${m.id} (already done)`); continue; }
  const results = [];
  for (const task of TASKS) {
    for (let rep = 0; rep < task.repeats; rep++) {
      const r = await runCase(m.id, task, rep);
      results.push(r);
      const mark = throttled(r) ? '429' : rejected(r) ? 'ERR' : calledTool(r) ? `${r.toolCalls.length} call(s)` : 'no call';
      console.log(`  ${m.id}  ${task.id}.${rep}  ${mark}  rounds=${r.rounds}  final=${r.final.trim().length}ch`);
    }
  }
  const score = tierFor(results);
  write(out, JSON.stringify({ model: m, score, results }, null, 2));
  console.log(`done  ${m.id}  ->  L${score.tier < 0 ? '?' : score.tier}  T1 ${score.t1Passes}\n`);
}

// ── report ─────────────────────────────────────────────────────────────
// Re-score from the saved cases rather than trusting the stored score: scoring
// rules change, the recorded requests do not. Keeps old runs comparable.
const rows = readdirSync(join(RUN, 'models'))
  .map((f) => JSON.parse(readFileSync(join(RUN, 'models', f), 'utf8')))
  .map((row) => ({ ...row, score: tierFor(row.results) }));
const yn = (v) => (v === true ? 'yes' : v === false ? 'NO' : 'n/a');
// citesResult is only meaningful where citing is correct: T4's canned results
// are deliberately about the wrong subject, so citing them would be the fault.
const CITABLE = new Set(['T1', 'T3']);
const q = (rs) => {
  const scored = rs.filter((r) => !throttled(r) && r.final.trim());
  const na = { nonEmpty: 'n/a', notFallback: 'n/a', citesResult: 'n/a', noLoop: 'n/a' };
  if (!scored.length) return na;
  const agg = {};
  for (const k of ['nonEmpty', 'notFallback', 'noLoop']) agg[k] = scored.every((r) => quality(r)[k]);
  const citable = scored.filter((r) => CITABLE.has(r.task) && calledTool(r));
  agg.citesResult = citable.length ? citable.every((r) => quality(r).citesResult) : 'n/a';
  return agg;
};

let md = `# Free Model Capability Sweep — ${STAMP}\n\n`;
md += `Run: \`${RUN.replace(ROOT, '')}\` · Search Budget: ${MAX_TOOL_ROUNDS} · Preset: \`BASIC AGENT\` · path: Proxy on the Operator Key\n\n`;
md += `Canned search results, so the model is the only variable. A 429 marks a case **not tested**, never failed.\n\n`;
md += `| Free Model | declares tools | Tier | L0 | L1 | L2 | L3 | L4 | T1 | T2 no-search | non-empty | not fallback | cites result | no loop | worst HTTP | not tested |\n`;
md += `|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const { model, score, results } of rows.sort((a, b) => a.score.tier - b.score.tier)) {
  const Q = q(results);
  md += `| \`${model.id}\` | ${model.declaresTools ? 'yes' : 'no'} | ${score.tier < 0 ? '?' : 'L' + score.tier} `
     + `| ${yn(score.levels.L0)} | ${yn(score.levels.L1)} | ${yn(score.levels.L2)} | ${yn(score.levels.L3)} | ${yn(score.levels.L4)} `
     + `| ${score.t1Passes} | ${yn(score.t2NoSearch)} | ${yn(Q.nonEmpty)} | ${yn(Q.notFallback)} | ${yn(Q.citesResult)} | ${yn(Q.noLoop)} | ${score.worstStatus} | ${score.throttledCases.join(' ') || '—'} |\n`;
}
md += `\n## Failures\n\n`;
for (const { model, results } of rows) {
  const bad = results.filter((r) => !throttled(r) && (r.crash || r.errors.length || rejected(r) || !r.final.trim()));
  if (!bad.length) continue;
  md += `### \`${model.id}\`\n\n`;
  for (const r of bad) {
    md += `- **${r.task}.${r.rep}** — statuses \`${r.statuses.join(',') || 'none'}\`, `
       + `${r.toolCalls.length} tool call(s), finish \`${r.finishReasons.join(',') || 'none'}\`, ${r.charsOut} chars out`
       + `${r.errors.length ? `, error: ${r.errors[0]}` : ''}${r.crash ? `, crash: ${r.crash.split('\n')[0]}` : ''}\n`
       + `  - raw: \`${r.rawPath}\`\n`;
  }
  md += `\n`;
}
const reportPath = join(ROOT, 'docs/research', `free-model-capability-sweep-${STAMP}.md`);
write(reportPath, md);
console.log(`report -> ${reportPath.replace(ROOT, '')}`);
