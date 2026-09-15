// evidence.test.mjs — fact-level evidence assessment (js/evidence.js).
// Pure unit tests: no network, no model calls, no clock beyond the local year.
// Covers the motivating NBA regression end to end at the evidence layer: both
// facts matched, a partial answer, a genuine number disagreement, a race whose
// sources agree, the historical-milestone trap (a 1984-85 record night must not
// satisfy a current career-total fact), and scope differences that are not
// conflicts. Plus the repair query and the non-factual escape hatch.
// Run: node --test test/evidence.test.mjs
import assert from 'node:assert/strict';

const { assess, assessIfFactual, repairQuery } = await import('../js/evidence.js');

// The plan shape js/research.js planTask() produces for the motivating question:
// "who has the most points in nba history? how many points od they have?"
const NBA_PLAN = {
  kind: 'factual',
  entities: ['NBA'],
  metrics: ['points'],
  temporal: 'current',
  scope: 'regular season',
  facts: [
    { id: 'f1', label: 'NBA career points leader' },
    { id: 'f2', label: "that leader's career points total" },
  ],
  query: 'NBA all-time career points leaders regular season',
};

/** A single-fact view of the same question, for the narrower cases. */
const TOTAL_PLAN = {
  kind: 'factual',
  entities: ['NBA'],
  metrics: ['points'],
  temporal: 'current',
  scope: null,
  facts: [{ id: 'f1', label: 'NBA career points total' }],
};

// Two sources agreeing: leader named, career total 38,387 both ways.
const LEADER_ITEM = { field: 'NBA career points', value: 38387, unit: 'points', scope: 'regular season', period: 'career total', sourceId: 's1' };
const TOTAL_ITEM = { field: 'career points total', value: '38,387', unit: 'points', scope: 'regular season', period: 'career total', sourceId: 's2' };

// ── 1. supported: metric+entity match, numbers agree ────────────────────
{
  const r = assess(NBA_PLAN, [LEADER_ITEM, TOTAL_ITEM]);
  assert.equal(r.status, 'supported', 'supported: both facts answered by agreeing sources');
  assert.deepEqual(r.supported, ['f1', 'f2'], 'supported: both facts, in plan order');
  assert.deepEqual(r.missing, [], 'supported: nothing missing');
  assert.deepEqual(r.conflicts, [], 'supported: identical numbers are not a conflict');

  // metric overlap is what matters: a field naming the metric without the entity
  // ("career points total" from an NBA source) still answers the fact
  const metricOnly = assess(NBA_PLAN, [{ field: 'career points total', value: 38387, scope: 'regular season' }]);
  assert.equal(metricOnly.status, 'supported', 'supported: metric-only field matches both facts');
  assert.deepEqual(metricOnly.conflicts, [], 'supported: one source cannot conflict with itself');

  // a different metric is not the requested fact
  const ppg = assess(TOTAL_PLAN, [{ field: 'points per game average', value: 30.1, scope: 'regular season' }]);
  assert.equal(ppg.status, 'unavailable', 'supported: points-per-game does not answer a career-total fact');
  assert.deepEqual(ppg.missing, ['f1'], 'supported: unmatched fact is missing');

  console.log('ok  : supported — metric+entity match, numbers agree');
}

// ── 2. partial: one fact answered, one not ──────────────────────────────
{
  const plan = {
    ...TOTAL_PLAN,
    facts: [
      { id: 'f1', label: 'NBA career points leader' },
      { id: 'f2', label: 'NBA rebounds per game' },
    ],
  };
  const r = assess(plan, [LEADER_ITEM, TOTAL_ITEM]);
  assert.equal(r.status, 'partial', 'partial: one of two facts has evidence');
  assert.deepEqual(r.supported, ['f1'], 'partial: the answered fact is supported');
  assert.deepEqual(r.missing, ['f2'], 'partial: the unanswered fact is missing');
  assert.deepEqual(r.conflicts, [], 'partial: no disagreement among the evidence given');

  console.log('ok  : partial — one fact missing');
}

// ── 3. conflicting: same subject+metric, different numbers ──────────────
{
  // scope/period unknown on both sides -> same question, two answers
  const r = assess(TOTAL_PLAN, [
    { field: 'NBA career points total', value: 38387, sourceId: 's1' },
    { field: 'NBA career points total', value: '39,000', sourceId: 's2' },
  ]);
  assert.equal(r.status, 'conflicting', 'conflicting: two numbers for one fact');
  assert.deepEqual(r.supported, [], 'conflicting: a contested fact is not supported');
  assert.deepEqual(r.missing, [], 'conflicting: a contested fact is not missing either');
  assert.equal(r.conflicts.length, 1, 'conflicting: one conflict entry');
  assert.equal(r.conflicts[0].factId, 'f1', 'conflicting: conflict names the fact');
  assert.deepEqual(r.conflicts[0].values, [38387, 39000], 'conflicting: both numbers reported numerically');

  // same scope, same period, disagreeing numbers -> still a conflict
  const sameSlice = assess(TOTAL_PLAN, [
    { field: 'NBA career points total', value: 38387, scope: 'regular season', period: 'career total' },
    { field: 'NBA career points total', value: 40297, scope: 'regular season', period: 'career total' },
  ]);
  assert.equal(sameSlice.status, 'conflicting', 'conflicting: equal scope and period, unequal numbers');

  // one fact clean, one fact contested -> conflicting overall, clean fact kept
  const mixedPlan = {
    ...TOTAL_PLAN,
    facts: [
      { id: 'f1', label: 'NBA career points leader' },
      { id: 'f2', label: 'NBA championships won' },
    ],
  };
  const mixed = assess(mixedPlan, [
    LEADER_ITEM,
    { field: 'NBA championships won', value: 6, sourceId: 's2' },
    { field: 'NBA championships won', value: '4', sourceId: 's3' },
  ]);
  assert.equal(mixed.status, 'conflicting', 'conflicting: any contested fact makes the turn conflicting');
  assert.deepEqual(mixed.supported, ['f1'], 'conflicting: the clean fact stays supported');
  assert.deepEqual(mixed.conflicts.map((c) => c.factId), ['f2'], 'conflicting: only the contested fact');
  assert.deepEqual(mixed.conflicts[0].values, [6, 4], 'conflicting: values are the disagreeing pair');

  // a non-numeric disagreement is not a number conflict
  const names = assess(TOTAL_PLAN, [
    { field: 'NBA career points total leader', value: 'Kareem Abdul-Jabbar' },
    { field: 'NBA career points total', value: 'LeBron James' },
  ]);
  assert.equal(names.conflicts.length, 0, 'conflicting: textual answers are not number conflicts');

  console.log('ok  : conflicting — same subject+metric, different numbers');
}

// ── 4. unavailable: nothing to assess ───────────────────────────────────
{
  const none = assess(NBA_PLAN, []);
  assert.deepEqual(none, { status: 'unavailable', supported: [], missing: ['f1', 'f2'], conflicts: [] },
    'unavailable: no items at all');

  assert.equal(assess(NBA_PLAN, undefined).status, 'unavailable', 'unavailable: missing items argument');
  assert.equal(assess(NBA_PLAN, null).status, 'unavailable', 'unavailable: null items');
  assert.deepEqual(assess({ kind: 'factual', facts: [] }, [LEADER_ITEM]),
    { status: 'unavailable', supported: [], missing: [], conflicts: [] }, 'unavailable: plan asks for no facts');
  assert.equal(assess(null, [LEADER_ITEM]).status, 'unavailable', 'unavailable: no plan');

  const irrelevant = assess(NBA_PLAN, [{ field: 'population of France', value: 68000000, scope: 'national' }]);
  assert.equal(irrelevant.status, 'unavailable', 'unavailable: items exist but answer nothing');
  assert.deepEqual(irrelevant.missing, ['f1', 'f2'], 'unavailable: every fact stays missing');

  console.log('ok  : unavailable — no items, no facts, or nothing matched');
}

// ── 5. historical milestone never satisfies a current fact ──────────────
{
  // Kareem's record night: the milestone that a current career total replaced.
  const MILESTONE = { field: 'NBA career points total', value: 31419, unit: 'points', period: '1984-85 season', sourceId: 's1' };
  const TODAY = { field: 'NBA career points total', value: 38387, unit: 'points', period: 'career total', sourceId: 's2' };

  const milestoneOnly = assess(TOTAL_PLAN, [MILESTONE]);
  assert.equal(milestoneOnly.status, 'unavailable', 'milestone: 1984-85 record night does not answer a current total');
  assert.deepEqual(milestoneOnly.supported, [], 'milestone: not supported');
  assert.deepEqual(milestoneOnly.missing, ['f1'], 'milestone: the current fact is still missing');

  const both = assess(TOTAL_PLAN, [MILESTONE, TODAY]);
  assert.equal(both.status, 'supported', 'milestone: the current total answers the fact');
  assert.deepEqual(both.conflicts, [], 'milestone: the superseded number is not a conflict');
  assert.deepEqual(both.supported, ['f1'], 'milestone: supported by the current figure');

  // the same milestone is a fine answer when the plan asks about the past
  const historical = assess({ ...TOTAL_PLAN, temporal: 'historical' }, [MILESTONE]);
  assert.equal(historical.status, 'supported', 'milestone: historical plan accepts the historical period');

  // a dateless period is unknown, not historical
  const undated = assess(TOTAL_PLAN, [MILESTONE, { ...TODAY, period: undefined }]);
  assert.equal(undated.status, 'supported', 'milestone: unknown period counts as current-compatible');

  console.log('ok  : historical milestone vs current total');
}

// ── 6. scope difference is not a conflict ───────────────────────────────
{
  const PLAYOFFS = { field: 'NBA career points total', value: 8023, unit: 'points', scope: 'playoffs' };
  const SEASON = { field: 'NBA career points total', value: 38387, unit: 'points', scope: 'regular season' };

  // plan asks about the regular season: the playoff figure is a different question
  const scoped = assess({ ...TOTAL_PLAN, scope: 'regular season' }, [PLAYOFFS, SEASON]);
  assert.equal(scoped.status, 'supported', 'scope: plan scope filters the other slice');
  assert.deepEqual(scoped.conflicts, [], 'scope: a different known scope is not a conflict');
  assert.deepEqual(scoped.supported, ['f1'], 'scope: the matching slice supports the fact');

  // plan names no scope: both slices are candidates, and still no conflict
  const unscoped = assess(TOTAL_PLAN, [PLAYOFFS, SEASON]);
  assert.equal(unscoped.status, 'supported', 'scope: unknown plan scope accepts either slice');
  assert.deepEqual(unscoped.conflicts, [], 'scope: differing known scopes are different questions, not a conflict');
  assert.deepEqual(unscoped.missing, [], 'scope: the fact is answered');

  // one side unknown + differing numbers is a conflict (same-or-unknown slice)
  const oneUnknown = assess(TOTAL_PLAN, [PLAYOFFS, { ...SEASON, scope: undefined }]);
  assert.equal(oneUnknown.status, 'conflicting', 'scope: unknown scope on one side is treated as the same slice');

  console.log('ok  : scope differences are not conflicts');
}

// ── 7. assessIfFactual: non-factual turns are never assessed ────────────
{
  const items = [LEADER_ITEM, TOTAL_ITEM];
  for (const kind of ['greeting', 'translation', 'private-writing', 'continuation']) {
    assert.equal(assessIfFactual({ ...NBA_PLAN, kind }, items), null, `assessIfFactual: ${kind} is never assessed`);
  }
  assert.equal(assessIfFactual(null, items), null, 'assessIfFactual: no plan -> null');
  assert.equal(assessIfFactual({ facts: NBA_PLAN.facts }, items), null, 'assessIfFactual: no kind -> null');

  for (const kind of ['factual', 'scores', 'academic']) {
    const r = assessIfFactual({ ...NBA_PLAN, kind }, items);
    assert.equal(r.status, 'supported', `assessIfFactual: ${kind} is assessed like any factual plan`);
    assert.deepEqual(r.supported, ['f1', 'f2'], `assessIfFactual: ${kind} reports both facts`);
  }

  // other kinds keep today's behavior through assessIfFactual, but assess() is
  // still available to a caller that wants a verdict for them.
  assert.equal(assessIfFactual({ ...TOTAL_PLAN, kind: 'news' }, items), null, 'assessIfFactual: news is not assessed');
  assert.equal(assess({ ...TOTAL_PLAN, kind: 'news' }, items).status, 'supported', 'assess: raw verdict still available');

  console.log('ok  : assessIfFactual — null for non-factual kinds');
}

// ── 8. repairQuery: short, entity-anchored, minimized ───────────────────
{
  assert.equal(repairQuery(NBA_PLAN, []), '', 'repair: nothing missing -> no query');
  assert.equal(repairQuery(NBA_PLAN, ['   ']), '', 'repair: blank label -> no query');
  assert.equal(repairQuery(null, []), '', 'repair: no plan and nothing missing -> no query');

  const q = repairQuery(NBA_PLAN, ['NBA career points leader', "that leader's career points total"]);
  assert.ok(q.length > 0, 'repair: produces a query');
  assert.ok(q.length <= 120, `repair: query stays short and focused (${q.length} chars)`);
  assert.ok(q.split(' ').length <= 12, 'repair: never more than the shared 12-token cap');
  assert.ok(/NBA/i.test(q), 'repair: query is anchored on the plan entity');
  assert.ok(/points/i.test(q), 'repair: query names the metric from the missing label');
  assert.ok(!/\b(that|the|of)\b/i.test(q), 'repair: filler words are minimized out');
  assert.ok(!q.includes('\n'), 'repair: single line');

  // a single missing label, passed bare, is accepted
  const one = repairQuery(NBA_PLAN, 'NBA career points leader');
  assert.ok(/NBA/i.test(one) && /points/i.test(one), 'repair: bare string label works');

  // deterministic across calls
  assert.equal(repairQuery(NBA_PLAN, ['NBA career points leader']), one, 'repair: deterministic');

  // a plan without entities still yields a label-anchored query
  const bare = repairQuery({ facts: [{ id: 'f1', label: 'population of France' }], entities: [], metrics: [], scope: null }, ['population of France']);
  assert.ok(/population|France/i.test(bare), 'repair: falls back to the label when there is no entity');

  console.log('ok  : repairQuery — entity + missing label, short and minimized');
}

// ── 9. cross-module: a real planTask() plan flows through assess() ──────
// Guarded: the planner lands in its own task; when it is present this pins the
// two modules together, when it is absent the contract fixtures above still
// cover this module.
{
  const { planTask } = await import('../js/research.js');
  if (typeof planTask !== 'function') {
    console.log('skip: planTask not exported yet — cross-module check runs once it lands');
  } else {
    const plan = planTask('who has the most points in nba history? how many points od they have?');
    assert.equal(plan.kind, 'factual', 'cross: the NBA question plans as factual');
    assert.ok(plan.facts.length >= 2, 'cross: both components of the question are requested facts');

    assert.deepEqual(assess(plan, []).missing, plan.facts.map((f) => f.id),
      'cross: with no evidence every fact is missing');

    // agreeing evidence for every requested fact -> supported
    const agreeing = plan.facts.map((f, i) => ({
      field: f.label, value: 38387, unit: 'points', scope: plan.scope, period: 'career total', sourceId: `s${i + 1}`,
    }));
    const ok = assess(plan, agreeing);
    assert.equal(ok.status, 'supported', 'cross: agreeing evidence for both facts is supported');
    assert.deepEqual(ok.missing, [], 'cross: nothing missing');
    assert.deepEqual(ok.conflicts, [], 'cross: identical numbers do not conflict');

    // one source disagreeing with the rest -> conflicting, and repairable
    // two items on the same fact disagreeing -> conflicting, and repairable
    const disagreeing = [
      { ...agreeing[0], value: 40000, sourceId: 's9' },
      ...agreeing,
    ];
    const bad = assess(plan, disagreeing);
    assert.equal(bad.status, 'conflicting', 'cross: a disagreeing figure makes the turn conflicting');
    assert.ok(bad.conflicts.length >= 1, 'cross: conflict is reported');

    const q = repairQuery(plan, plan.facts.map((f) => f.label));
    assert.ok(/NBA/i.test(q), 'cross: repair query is anchored on the planner entity');
    assert.ok(q.split(' ').length <= 12, 'cross: repair query respects the token cap');
    console.log('ok  : real planner plan flows through assess/repairQuery');
  }
}

console.log('ALL EVIDENCE PASS');
