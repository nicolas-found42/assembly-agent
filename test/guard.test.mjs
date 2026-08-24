// guard.test.mjs — pure guard functions: denial detection, hedge gate, arg repair
// TDD per bridge contract; includes real eval failure as case.
// Run: node test/guard.test.mjs
import assert from 'node:assert/strict';

const guard = await import('../js/guard.js');
const { looksLikeDenial, hedgeNeeded, HEDGE_PASS_NUDGE, repairToolArgs } = guard;

// ── looksLikeDenial ─────────────────────────────────────────────
{
  assert.equal(looksLikeDenial('The 2026 Tour de France has not yet been held'), true, 'denial: Tour de France not yet held');
  assert.equal(looksLikeDenial('This event has not been held yet'), true, 'denial: has not been held');
  assert.equal(looksLikeDenial('There does not exist any record'), true, 'denial: does not exist');
  assert.equal(looksLikeDenial('It never took place'), true, 'denial: never took place');
  assert.equal(looksLikeDenial('hello world'), false, 'non-denial: hello');
  assert.equal(looksLikeDenial('The Tour de France 2026 will be held in July'), false, 'non-denial: future event neutral');
  assert.equal(looksLikeDenial(''), false, 'non-denial: empty');
  assert.equal(looksLikeDenial(null), false, 'non-denial: null');
  console.log('ok  : looksLikeDenial');
}

// ── hedgeNeeded ─────────────────────────────────────────────────
// contract: denial phrasing AND (empty evidence OR denied-subject absent)
{
  // real eval failure: answer denies 2026 Tour, evidence empty -> hedgeNeeded=true
  assert.equal(hedgeNeeded('The 2026 Tour de France has not yet been held', ''), true, 'hedge: real eval failure empty evidence');
  assert.equal(hedgeNeeded('The 2026 Tour de France has not yet been held', '   '), true, 'hedge: whitespace evidence is empty');

  // denial but evidence contains subject -> no hedge needed
  assert.equal(hedgeNeeded('The 2026 Tour de France has not yet been held', '### [WIKIPEDIA] Tour de France\n2026 Tour de France is scheduled...'), false, 'hedge: subject present -> no hedge');

  // denial + irrelevant evidence (subject absent) -> hedge needed
  assert.equal(hedgeNeeded('The 2026 Tour de France has not yet been held', 'Some unrelated page about cooking'), true, 'hedge: irrelevant evidence -> hedge');

  // non-denial never hedges, even with empty evidence
  assert.equal(hedgeNeeded('The Tour de France is a famous race', ''), false, 'hedge: non-denial with empty evidence -> no hedge');
  assert.equal(hedgeNeeded('Hello world', ''), false, 'hedge: non-denial empty -> no hedge');

  // denial with null evidence -> hedge
  assert.equal(hedgeNeeded('The 2026 Tour de France has not yet been held', null), true, 'hedge: null evidence');
  console.log('ok  : hedgeNeeded');
}

// ── HEDGE_PASS_NUDGE ────────────────────────────────────────────
{
  assert.equal(typeof HEDGE_PASS_NUDGE, 'string', 'nudge is string');
  assert.ok(HEDGE_PASS_NUDGE.length > 20, 'nudge non-empty');
  // must be honest uncertainty rewrite instruction and mention not calling search / tool
  const lower = HEDGE_PASS_NUDGE.toLowerCase();
  assert.ok(lower.includes('uncertain') || lower.includes('unknown') || lower.includes('honest'), 'nudge mentions uncertainty/honest');
  assert.ok(lower.includes('search') || lower.includes('tool') || lower.includes('evidence'), 'nudge references search/tool/evidence');
  console.log('ok  : HEDGE_PASS_NUDGE');
}

// ── repairToolArgs ──────────────────────────────────────────────
{
  // valid JSON
  assert.deepEqual(repairToolArgs('{"query": "rust"}'), { ok: true, query: 'rust' }, 'repair: valid JSON');
  assert.deepEqual(repairToolArgs('{"query":"webassembly"}'), { ok: true, query: 'webassembly' }, 'repair: compact JSON');

  // malformed args '{"query": "rust"' -> repair yields rust (required case)
  assert.deepEqual(repairToolArgs('{"query": "rust"'), { ok: true, query: 'rust' }, 'repair: missing closing brace salvage');

  // truncated mid-quote? also salvaged via regex
  assert.deepEqual(repairToolArgs('{"query": "rust'), { ok: true, query: 'rust' }, 'repair: missing quote+brace');

  // extra fields ignored
  assert.deepEqual(repairToolArgs('{"query": "hello", "other": 1}'), { ok: true, query: 'hello' }, 'repair: extra fields');

  // no query -> null
  assert.equal(repairToolArgs('{"q": "rust"}'), null, 'repair: no query field -> null');
  assert.equal(repairToolArgs('not json at all'), null, 'repair: garbage -> null');
  assert.equal(repairToolArgs(''), null, 'repair: empty -> null');
  assert.equal(repairToolArgs(null), null, 'repair: null input -> null');

  // query with spaces
  assert.deepEqual(repairToolArgs('{"query": "2026 Tour de France"}'), { ok: true, query: '2026 Tour de France' }, 'repair: spaces');

  console.log('ok  : repairToolArgs');
}

// ── zero imports check (guard.js must be pure) ─────────────────
{
  const src = (await import('node:fs')).readFileSync(new URL('../js/guard.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('import '), 'guard.js ZERO imports: no import statement');
  assert.ok(!src.includes("from '"), 'guard.js ZERO imports: no from clause');
  console.log('ok  : guard.js zero imports');
}

console.log('ALL GUARD PASS');
