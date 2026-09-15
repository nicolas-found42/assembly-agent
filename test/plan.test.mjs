// plan.test.mjs — task planning: intent kind, entities, metrics, facts and
// the planned query (js/research.js planTask/classifyIntent/followUpQuery)
// plus the STOPWORDS fix that keeps meaning-bearing words in every query.
// The plan decides WHAT a research round searches, so the assertions are
// semantic: comparison, negation, units, scope and dates must survive as
// meaning, never as one pinned query string.
import assert from 'node:assert/strict';

const { planTask, planQuery, classifyIntent, followUpQuery, minimizeQuery } = await import('../js/research.js');

const kindOf = (text) => classifyIntent(text);

// ── 1. STOPWORDS: quantifiers and negation are meaning, not filler ───────
{
  assert.match(minimizeQuery('who has the most points in nba history'), /most/,
    'stopwords: "most" survives — it is the comparison the user asked for');
  assert.match(minimizeQuery('which countries have not joined'), /not/,
    'stopwords: "not" survives — negation changes the answer');
  assert.match(minimizeQuery('which teams have no championships'), /\bno\b/,
    'stopwords: "no" survives');
  assert.match(minimizeQuery('all of the medals ever won'), /\ball\b/, 'stopwords: "all" survives');
  assert.match(minimizeQuery('some larger cities in Europe'), /\bsome\b/, 'stopwords: "some" survives');
  assert.match(minimizeQuery('only the home wins'), /\bonly\b/, 'stopwords: "only" survives');
  assert.match(minimizeQuery('many points were scored'), /\bmany\b/, 'stopwords: "many" survives');
  assert.match(minimizeQuery('each player scored once'), /\beach\b/, 'stopwords: "each" survives');

  // Grammatical fillers and question words still go: the query stays visibly
  // derived from the message rather than pasted through.
  const q = minimizeQuery('What is the tallest building in the world?');
  assert.ok(!/\b(what|is|the|in)\b/i.test(q), 'stopwords: fillers and question words still dropped');
  assert.match(q, /^tallest building world/i, 'stopwords: the topic survives minimization');

  // The privacy boundary is untouched by the stopword change.
  assert.ok(!minimizeQuery('key sk-or-abc123def456 here').includes('sk-or'), 'stopwords: sk- key still stripped');
  assert.ok(!minimizeQuery('mail jane.doe@example.com now').includes('jane.doe@example.com'), 'stopwords: email still stripped');
  assert.ok(minimizeQuery('   ') === '', 'stopwords: blank stays blank');
  const many = minimizeQuery(Array.from({ length: 40 }, (_, i) => `word${i}`).join(' '));
  assert.ok(many.split(' ').length <= 12, 'stopwords: the 12-token cap still holds');
  console.log('ok  : meaning-bearing words survive minimization, fillers and secrets still go');
}

// ── 2. classifyIntent: one kind per task shape ─────────────────────────
{
  assert.equal(kindOf('hi there'), 'greeting', 'kind: greeting');
  assert.equal(kindOf('continue'), 'continuation', 'kind: continuation');
  assert.equal(kindOf('translate this into French: the meeting is on Monday'), 'translation', 'kind: translation');
  assert.equal(kindOf('Please write an email to my landlord about the broken sink in the kitchen and explain that the repair was never done, that I have asked twice, and that I would like a reduction in the rent until it is fixed.'), 'private-writing', 'kind: private writing');
  assert.equal(kindOf('nfl scores today'), 'scores', 'kind: scoreboard with a league');
  assert.equal(kindOf('lakers game tonight'), 'scores', 'kind: scoreboard with a team nickname');
  assert.equal(kindOf('latest research papers about diffusion models'), 'academic', 'kind: academic');
  assert.equal(kindOf('python code for quicksort'), 'code', 'kind: code');
  assert.equal(kindOf('pictures of the eiffel tower'), 'visual', 'kind: visual');
  assert.equal(kindOf('what does serendipity mean'), 'definition', 'kind: definition');
  assert.equal(kindOf('latest news about the election'), 'news', 'kind: news');
  assert.equal(kindOf('who has the most points in nba history?'), 'factual', 'kind: factual question');
  assert.equal(kindOf('who won the 2018 world cup'), 'factual', 'kind: dated factual question');
  assert.equal(kindOf('explain the water cycle'), 'general', 'kind: general knowledge ask');
  assert.equal(kindOf(''), 'general', 'kind: empty -> general');

  // A career-record question is not a scoreboard question: no score token in
  // the message, so the ESPN-family sources stay out of it.
  assert.notEqual(kindOf('nba career points leaders'), 'scores', 'kind: career records are not scores');
  assert.notEqual(kindOf('nba career points leaders'), 'factual', 'kind: a bare topic is general, not a question');
  console.log('ok  : classifyIntent separates every task shape');
}

// ── 3. the motivating regression: a compound record question ────────────
{
  const ASKED = 'who has the most points in nba history? how many points od they have?';
  const plan = planTask(ASKED);

  assert.equal(plan.kind, 'factual', 'nba: a question with a verifiable answer');
  assert.ok(plan.entities.some((e) => e.toLowerCase() === 'nba'), 'nba: the league is an entity');
  assert.deepEqual(plan.metrics, ['points'], 'nba: the requested metric');
  assert.equal(plan.temporal, 'current', 'nba: an all-time total is time-sensitive, not dated');
  assert.equal(plan.scope, 'regular season', 'nba: career league records default to the regular season');

  assert.equal(plan.facts.length, 2, 'nba: two distinct components');
  assert.deepEqual(plan.facts.map((f) => f.id), ['f1', 'f2'], 'nba: facts keep their order');
  assert.match(plan.facts[0].label, /points/i, 'nba: f1 identifies the points leader');
  assert.match(plan.facts[0].label, /\b(most|top|leader)/i, 'nba: f1 keeps the comparison');
  assert.match(plan.facts[1].label, /points/i, 'nba: f2 asks for the leader total');
  assert.match(plan.facts[1].label, /\bhow many\b/i, 'nba: f2 keeps the quantity ask');

  // Meaning, not a pinned string: the query carries the entity, the metric,
  // the comparison and the scope — and it is not the message pasted through.
  const q = plan.query;
  assert.match(q, /nba/i, 'nba query: entity');
  assert.match(q, /points/i, 'nba query: metric');
  assert.match(q, /all-time/i, 'nba query: the all-time comparison');
  assert.match(q, /(leaders|most|top)/i, 'nba query: comparison intent survives');
  assert.match(q, /regular season/i, 'nba query: the assumed scope is searched');
  assert.ok(!/who|history\?/i.test(q), 'nba query: not the raw message');
  assert.ok(q.length <= 160, 'nba query: within the character budget');
  assert.ok(q.split(' ').length <= 12, 'nba query: within the token budget');
  console.log('ok  : the NBA career-points question plans both facts and a meaning-preserving query');
}

// ── 4. comparison, negation, units, dates, scope, names ────────────────
{
  // maximum / minimum / ranking stay in the plan and in the query
  const max = planTask('Who has the most points in NBA history?');
  assert.match(max.query, /all-time/i, 'comparison: "most" becomes an all-time record query');
  assert.match(max.query, /(leaders|most)/i, 'comparison: the maximum survives');
  const min = planTask('Which team has the least wins in MLB history?');
  assert.deepEqual(min.metrics, ['wins'], 'comparison: metric of the minimum');
  assert.match(min.query, /fewest/i, 'comparison: the minimum survives as the opposite extreme');
  assert.match(min.query, /mlb/i, 'comparison: the minimum keeps its league');
  const top = planTask('top 10 NBA scorers of all time');
  assert.match(top.query, /top 10/i, 'comparison: a top-N list keeps its breadth');
  assert.match(top.query, /nba/i, 'comparison: a top-N list keeps its league');

  // negation and exclusion words ride along
  const not = planTask('Which countries are not members of NATO?');
  assert.match(not.query, /not/i, 'negation: "not" reaches the query');
  assert.match(not.query, /nato/i, 'negation: the entity reaches the query');
  const none = planTask('which teams have no championships');
  assert.deepEqual(none.metrics, ['championships'], 'negation: metric of the "no" ask');
  assert.match(none.query, /\bno\b/i, 'negation: "no" reaches the query');
  assert.match(none.query, /championships/i, 'negation: the metric reaches the query');

  // units and metrics are named explicitly
  assert.deepEqual(planTask('how many points did they score').metrics, ['points'], 'units: points');
  assert.deepEqual(planTask('how many kills does the average player get').metrics, ['kills'], 'units: kills');
  assert.deepEqual(planTask('how many dollars did the movie make').metrics, ['dollars'], 'units: dollars');
  assert.ok(planTask('how tall is the eiffel tower in meters').metrics.includes('meters'), 'units: an explicit unit is a metric');
  assert.deepEqual(planTask('who won the 2018 world cup').metrics, [], 'units: no invented metric');

  // explicit dates are historical; "in history" totals are not
  const dated = planTask('who won the 2018 world cup');
  assert.equal(dated.temporal, 'historical', 'dates: an explicit year is dated');
  assert.match(dated.query, /2018/, 'dates: the year reaches the query');
  assert.equal(planTask('who won the world cup last night').temporal, 'historical', 'dates: "last night" is dated');
  assert.equal(planTask('who is the president today').temporal, 'current', 'dates: "today" is current');
  assert.equal(planTask('who has the most points in nba history').temporal, 'current',
    'dates: an all-time total stays current');
  assert.equal(planTask('what does serendipity mean').temporal, 'timeless', 'dates: a definition is timeless');
  assert.equal(planTask('explain the water cycle').temporal, 'unknown', 'dates: no time signal at all');

  // competition scope: explicit wins over the documented default
  assert.equal(planTask('who has the most points in nba playoff history?').scope, 'playoffs', 'scope: playoffs');
  assert.equal(planTask('who has the most regular season points in nba history').scope, 'regular season',
    'scope: an explicit regular season');
  assert.equal(planTask('who has the most points in nba history').scope, 'regular season',
    'scope: the documented default for league career records');
  assert.equal(planTask('who won the 2018 world cup').scope, null, 'scope: no scope invented for a cup final');

  // unfamiliar names and identifiers are carried verbatim, never "fixed"
  const named = planTask('What did Dario Amodei say about AI safety?');
  assert.ok(named.entities.includes('Dario Amodei'), 'names: the full name is one entity');
  assert.match(named.query, /Dario Amodei/, 'names: the name survives verbatim');
  const keyed = planTask('what is sk-or-abc123def456 used for');
  assert.ok(!keyed.query.includes('sk-or-abc123def456'), 'names: a key-looking identifier never reaches the query');
  assert.ok(keyed.entities.every((e) => !/sk-or/.test(e)), 'names: a key-looking identifier is not an entity');
  const mailed = planTask('who emailed Jane.Doe@example.com about the most points in nba history');
  assert.ok(!JSON.stringify(mailed).includes('Jane.Doe'), 'names: an email address is never an entity or a fact label');

  // every distinct component becomes its own fact, in order
  const compound = planTask('who won the 2018 world cup and how many goals did they score and who was the runner up?');
  assert.deepEqual(compound.facts.map((f) => f.id), ['f1', 'f2', 'f3'], 'facts: one fact per requested component');
  assert.match(compound.facts[1].label, /goals/i, 'facts: the middle component keeps its metric');
  assert.equal(compound.temporal, 'historical', 'facts: the dated question governs the plan');
  console.log('ok  : comparison, negation, units, dates, scope and names all survive planning');
}

// ── 5. follow-ups borrow the immediate topic, not the longest message ───
{
  const history = [
    'what is the history of the Los Angeles Lakers franchise over the years',
    'who is the Boston Celtics head coach',
  ];
  const follow = planTask('who is their coach', { history });
  assert.ok(follow.entities.includes('Boston Celtics'), 'follow-up: entities come from the nearest message that names one');
  assert.ok(!follow.entities.some((e) => /Lakers/.test(e)), 'follow-up: not from the longer, older message');
  assert.match(follow.query, /Boston Celtics/, 'follow-up: the query is entity-anchored');
  assert.match(follow.query, /coach/, 'follow-up: the query keeps the asked metric');

  const direct = planTask('who is the Boston Celtics head coach', { history: [] });
  assert.match(direct.query, /Boston Celtics/, 'direct: the entity comes from the message itself');

  const bare = planTask('who is the coach', { history: ['who is the Boston Celtics head coach'] });
  assert.ok(bare.entities.every((e) => !/Celtics/.test(e)),
    'follow-up: a self-contained question does not borrow context entities');
  console.log('ok  : follow-ups anchor on the immediate topic');
}

// ── 6. greeting / private writing / translation / continuation unchanged ─
{
  const PRIVATE = 'Please write an email to my landlord about the broken sink in the kitchen and explain that the repair was never done, that I have asked twice, and that I would like a reduction in the rent until it is fixed.';
  const HISTORY = ['what is a binary search tree', 'ok thanks'];
  for (const [text, history] of [
    ['hi', []],
    ['Hello!', []],
    ['hey there', []],
    [PRIVATE, []],
    ['translate this into French: the meeting is on Monday', []],
    ['translate this text into Spanish please', []],
    ['continue', HISTORY],
    ['shorter', HISTORY],
    ['continue', []],
  ]) {
    const plan = planTask(text, { history });
    assert.equal(plan.query, planQuery(text, { history }), `unchanged: "${text.slice(0, 24)}" plans planQuery's query`);
    assert.ok(!/landlord|kitchen|sink|rent/i.test(plan.query), `unchanged: "${text.slice(0, 24)}" carries no private words`);
  }
  assert.equal(planTask('hi').kind, 'greeting', 'unchanged: greeting kind');
  assert.equal(planTask(PRIVATE).kind, 'private-writing', 'unchanged: private-writing kind');
  assert.equal(planTask('continue', { history: HISTORY }).kind, 'continuation', 'unchanged: continuation kind');
  console.log('ok  : the pre-existing planQuery branches are byte-identical');
}

// ── 7. plan shape, determinism and the repair query ────────────────────
{
  const plan = planTask('who has the most points in nba history');
  assert.deepEqual(Object.keys(plan).sort(),
    ['entities', 'facts', 'kind', 'metrics', 'query', 'scope', 'temporal'],
    'shape: the documented plan fields, nothing else');
  assert.deepEqual(plan, planTask('who has the most points in nba history'), 'shape: planning is deterministic');
  assert.ok(Array.isArray(plan.entities) && Array.isArray(plan.metrics) && Array.isArray(plan.facts), 'shape: collections');
  assert.ok(plan.facts.every((f) => typeof f.id === 'string' && typeof f.label === 'string'), 'shape: fact records');
  assert.equal(planTask('').facts.length, 0, 'shape: an empty message asks for nothing');

  const repair = followUpQuery(plan, 'how many points does they have');
  assert.match(repair, /nba/i, 'repair: entity-anchored');
  assert.match(repair, /points/i, 'repair: targeted at the missing metric');
  assert.match(repair, /regular season/i, 'repair: keeps the plan scope');
  assert.match(repair, /total/i, 'repair: a quantity fact asks for the total');
  assert.ok(repair.includes('points') && !/\bnba\b.*\bnba\b/i.test(repair), 'repair: no duplicated anchor');
  assert.ok(!/sk-or-abc123/.test(followUpQuery(plan, 'the sk-or-abc123def456 total')), 'repair: the privacy boundary holds');
  assert.equal(typeof followUpQuery(plan, ''), 'string', 'repair: always returns a string');
  assert.equal(followUpQuery(null, ''), 'general knowledge', 'repair: a missing plan falls back to the generic query');
  console.log('ok  : the plan shape is stable and repairs are targeted');
}

console.log('ALL PLAN PASS');
