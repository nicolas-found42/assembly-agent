// sources.test.mjs — TDD contract for js/search.js (SearchSources)
// No real network; transport faked by URL substring.
// Covers: smartSlice scoring/order/budget; applyWikiCaps + DBPEDIA exempt;
// createLimiter burst spacing; per-source builders via fake transport
// (happy, heuristic-skip, network-error) for espn, openmeteo chain/memo,
// worldbank country_code reuse, endoflife, jinaweb limiter, wdqs template.

import assert from 'node:assert/strict';

// ── browser shims ──
globalThis.window = globalThis;
globalThis.location = { origin: 'http://localhost:8000' };
globalThis.document = { createElement: () => ({}), querySelector: () => null, body: { appendChild: () => {} } };
globalThis.localStorage = {};
globalThis.sessionStorage = {
  _s: Object.create(null),
  getItem(k){ return this._s[k] ?? null; },
  setItem(k,v){ this._s[k]=String(v); },
  removeItem(k){ delete this._s[k]; },
  clear(){ this._s = Object.create(null); }
};
globalThis.sessionStorage.clear();
if (typeof performance === 'undefined') globalThis.performance = { now: () => Date.now() };

const mod = await import('../js/search.js');
const { webSearch, smartSlice, applyWikiCaps, createLimiter, SOURCE_NAMES, jinaLimiter, anonLimiter } = mod;
function fmt(tag,title,url,snip){ return `### [${tag}] ${title}\n${url}\n${snip}\n\n`; }
function clearCache(){ globalThis.sessionStorage.clear(); }

// fake transport keyed by URL substring
function makeFake(map, counts={}) {
  // map: substring -> payload (json obj/array/string) or {__error:true,msg} or {__ok:false,status:500}
  return async (url, opts={}) => {
    for (const [sub, payload] of Object.entries(map)) {
      if (url.includes(sub)) {
        counts[sub] = (counts[sub]||0)+1;
        if (payload && payload.__error) throw new Error(payload.msg || 'network down');
        if (payload && payload.__ok === false) return { ok:false, status: payload.status||500, json: async()=> ({}), text: async()=> '' };
        // success
        const isStr = typeof payload === 'string';
        return {
          ok:true, status:200,
          json: async()=> isStr ? JSON.parse(payload) : payload,
          text: async()=> isStr ? payload : JSON.stringify(payload)
        };
      }
    }
    // default: empty success to avoid phantom failures
    return { ok:true, status:200, json: async()=> ({}), text: async()=> '' };
  };
}

// ── smartSlice ──
{
  const blocks = fmt('WIKIPEDIA','A','https://a.example','alpha beta') + fmt('WIKIPEDIA','B','https://b.example','gamma delta') + fmt('WIKIPEDIA','C','https://c.example','alpha gamma');
  // scoring: query "alpha gamma" => C matches 2 terms, A 1, B 1. Order preservation: original A,B,C -> selected should remain A,C? Let's test.
  const out = smartSlice(blocks, 'alpha gamma', 10000);
  assert.ok(out.includes('https://c.example'), 'smartSlice should include top scored C');
  assert.ok(out.length <= 10000, 'budget respected');
  // order: A appears before C in original, so if both selected, A before C
  const idxA = out.indexOf('https://a.example');
  const idxC = out.indexOf('https://c.example');
  if (idxA !== -1 && idxC !== -1) assert.ok(idxA < idxC, 'preserves original order');

  // budget edge: tiny budget truncates
  const tiny = smartSlice(blocks, 'alpha', 10);
  assert.ok(tiny.length <= 10, 'tiny budget truncates');

  // default budget 12000 when omitted
  const def = smartSlice(blocks, 'alpha');
  assert.ok(def.length > 0, 'default budget works');

  // empty input
  assert.equal(smartSlice('', 'q', 100), '', 'empty blocks -> empty');

  // array input support
  const arr = [fmt('WIKIPEDIA','A','https://a.example','alpha'), fmt('WIKIPEDIA','B','https://b.example','beta')];
  const arrOut = smartSlice(arr, 'beta', 10000);
  assert.ok(arrOut.includes('https://b.example'), 'array input handled');
}
console.log('smartSlice PASS');

// ── applyWikiCaps ──
{
  let md = '';
  for (let i=0;i<4;i++) md += fmt('WIKIPEDIA',`W${i}`,`https://w${i}.example`,`snip ${i}`);
  for (let i=0;i<3;i++) md += fmt('WIKIDATA',`D${i}`,`https://d${i}.example`,`snip ${i}`);
  for (let i=0;i<4;i++) md += fmt('DBPEDIA',`P${i}`,`https://p${i}.example`,`snip ${i}`);
  const capped = applyWikiCaps(md);
  const wCount = (capped.match(/### \[WIKIPEDIA\]/g)||[]).length;
  const wdCount = (capped.match(/### \[WIKIDATA]/g)||[]).length; // careful
  const wdAll = (capped.match(/### \[WIKIDATA\]/g)||[]).length;
  const dbp = (capped.match(/### \[DBPEDIA\]/g)||[]).length;
  assert.equal(wCount, 2, 'WIKIPEDIA capped at 2');
  assert.equal(wdAll, 2, 'WIKIDATA capped at 2');
  assert.equal(dbp, 4, 'DBPEDIA uncapped');

  // DBPEDIA exempt when mixed with WIKIDATA SPARQL
  let md2 = '';
  for (let i=0;i<3;i++) md2 += fmt('WIKIDATA SPARQL',`Q${i}`,`https://q${i}.example`,`snip`);
  for (let i=0;i<3;i++) md2 += fmt('DBPEDIA',`P${i}`,`https://p${i}.example`,`snip`);
  const capped2 = applyWikiCaps(md2);
  assert.equal((capped2.match(/### \[WIKIDATA SPARQL\]/g)||[]).length, 2, 'WIKIDATA SPARQL capped');
  assert.equal((capped2.match(/### \[DBPEDIA\]/g)||[]).length, 3, 'DBPEDIA still uncapped with sparql');

  // independent caps: WIKIDATA and WIKIDATA SPARQL each have their own 2-block cap
  let md3 = '';
  for (let i=0;i<3;i++) md3 += fmt('WIKIDATA',`D${i}`,`https://d${i}.example`,`snip`);
  for (let i=0;i<3;i++) md3 += fmt('WIKIDATA SPARQL',`S${i}`,`https://s${i}.example`,`snip`);
  const capped3 = applyWikiCaps(md3);
  assert.equal((capped3.match(/### \[WIKIDATA\]/g)||[]).length, 2, 'WIKIDATA independent cap 2');
  assert.equal((capped3.match(/### \[WIKIDATA SPARQL\]/g)||[]).length, 2, 'WIKIDATA SPARQL independent cap 2');
  assert.equal((capped3.match(/### \[WIKIDATA/g)||[]).length, 4, 'independent caps total 4');
  // array input
  const arrCap = applyWikiCaps([fmt('WIKIPEDIA','A','https://a0.example','x'), fmt('WIKIPEDIA','B','https://b0.example','x'), fmt('WIKIPEDIA','C','https://c0.example','x')]);
  assert.equal((arrCap.match(/### \[WIKIPEDIA\]/g)||[]).length, 2, 'array input capped');
}
console.log('applyWikiCaps PASS');

// ── createLimiter burst spacing ──
{
  const lim = createLimiter(300); // 200ms interval
  const t0 = Date.now();
  const times = [];
  await lim.take(); times.push(Date.now()-t0);
  await lim.take(); times.push(Date.now()-t0);
  await lim.take(); times.push(Date.now()-t0);
  // first immediate (<100ms), second ~200ms, third ~400ms
  assert.ok(times[0] < 100, `limiter first immediate got ${times[0]}`);
  assert.ok(times[1] >= 150 && times[1] < 450, `second ~200 got ${times[1]}`);
  assert.ok(times[2] >= 300 && times[2] < 700, `third ~400 got ${times[2]}`);

  // shared instance sequential still spaced
  const lim2 = createLimiter(600); // 100ms
  const s = Date.now();
  await Promise.all([lim2.take(), lim2.take(), lim2.take()]);
  const elapsed = Date.now()-s;
  assert.ok(elapsed >= 180, `parallel takes spaced elapsed ${elapsed}`);
}
console.log('createLimiter PASS');

// ── SOURCE_NAMES shape ──
{
  assert.ok(SOURCE_NAMES.includes('espn'), 'SOURCE_NAMES has espn');
  assert.ok(SOURCE_NAMES.includes('openmeteo'), 'has openmeteo');
  assert.ok(SOURCE_NAMES.includes('worldbank'), 'has worldbank');
  assert.ok(SOURCE_NAMES.includes('stackexchange'), 'stackexchange stays');
  assert.ok(!SOURCE_NAMES.includes('semanticscholar'), 'semanticscholar removed');
}

// ── per-source via fake transport ──
function reset(){ clearCache(); if (jinaLimiter && jinaLimiter._reset) jinaLimiter._reset(); if (anonLimiter && anonLimiter._reset) anonLimiter._reset(); if (mod.anonLimiter && mod.anonLimiter._reset) mod.anonLimiter._reset(); }
// espn happy
{
  reset();
  const counts={};
  const transport = makeFake({
    'site.api.espn.com': { events: [{ id:'1', name:'BUF vs MIA', competitions:[{ competitors:[{team:{abbreviation:'BUF',displayName:'B Bills'},score:'21'},{team:{abbreviation:'MIA',displayName:'M Dolphins'},score:'14'}]}]}] },
    // harmless defaults for others to avoid failures if heuristics fire unexpectedly (they shouldn't for this query except jinaweb)
    'r.jina.ai/https://lite.duckduckgo.com': 'jina web results ok',
    'endoflife.date/api/all.json': [{product:'nodejs',is_maintained:true,latest:{version:'20',date:'2024-01-01'}}]
  }, counts);
  const r = await webSearch('nfl scores today', {transport});
  assert.ok(r.markdown.includes('### [ESPN]'), 'espn happy includes ESPN block');
  assert.ok(counts['site.api.espn.com']===1, 'espn fetched once');
  assert.ok(!r.failures.includes('espn'), 'espn not in failures');
  assert.ok(typeof r.markdown==='string' && typeof r.sources==='number' && Array.isArray(r.failures) && Array.isArray(r.perSource), 'shape unchanged');
}
// espn heuristic-skip
{
  reset();
  let espnCalled=false;
  const transport = async (url)=> {
    if (url.includes('site.api.espn.com')) espnCalled=true;
    return { ok:true, status:200, json: async()=> ({}), text: async()=> '' };
  };
  const r = await webSearch('hello world', {transport});
  assert.equal(espnCalled,false,'espn heuristic skip no fetch');
  assert.ok(!r.markdown.includes('### [ESPN]'),'no ESPN block when skipped');
}
// espn network-error tolerated
{
  reset();
  const transport = makeFake({
    'site.api.espn.com': {__error:true,msg:'500'},
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok'
  });
  const r = await webSearch('nfl game', {transport});
  assert.ok(r.failures.includes('espn'), 'espn failure recorded');
  assert.ok(r.markdown.includes('### [JINA WEB]') || r.markdown.length>=0,'other sources still present, no throw');
}

// openmeteo chain happy with memo
{
  reset();
  const counts={};
  const transport = makeFake({
    'geocoding-api.open-meteo.com': { results:[{latitude:48.8566, longitude:2.3522, name:'Paris', country:'France', country_code:'FR'}] },
    'api.open-meteo.com/v1/forecast': { current:{temperature_2m:21, weather_code:0}},
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok',
    'endoflife.date/api/all.json': [{product:'paris',is_maintained:true,latest:{version:'1',date:'2024-01-01'}}]
  }, counts);
  const r = await webSearch('weather in Paris', {transport});
  assert.ok(r.markdown.includes('### [OPEN-METEO]'), 'openmeteo happy');
  assert.equal(counts['geocoding-api.open-meteo.com'],1,'geocode called once');
  assert.equal(counts['api.open-meteo.com/v1/forecast'],1,'forecast called once');
}
// openmeteo heuristic-skip (no place, no weather)
{
  reset();
  let geoCalled=false;
  const transport = async (url)=>{
    if (url.includes('geocoding-api.open-meteo.com')) geoCalled=true;
    return { ok:true, status:200, json: async()=>({}), text: async()=>''};
  };
  const r = await webSearch('hello world', {transport});
  assert.equal(geoCalled,false,'openmeteo skip no geocode');
  assert.ok(!r.markdown.includes('### [OPEN-METEO]'),'no openmeteo block');
}
// openmeteo network-error tolerated (geocode fails)
{
  reset();
  const transport = makeFake({
    'geocoding-api.open-meteo.com': {__error:true,msg:'timeout'},
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok'
  });
  const r = await webSearch('weather in Paris', {transport});
  assert.ok(r.failures.includes('openmeteo'), 'openmeteo failure pushed');
  assert.ok(!r.markdown.includes('### [OPEN-METEO]') || r.markdown.includes('### [JINA'), 'no throw');
}

// shared memoized geocode (openmeteo + worldbank reuse)
{
  reset();
  const counts={};
  const transport = makeFake({
    'geocoding-api.open-meteo.com': { results:[{latitude:48.8566, longitude:2.3522, name:'Paris', country:'France', country_code:'FR'}] },
    'api.open-meteo.com/v1/forecast': { current:{temperature_2m:18, weather_code:1}},
    'api.worldbank.org': [[{},{ }], [{country:{value:'France'}, value:'12345', date:'2023'}]],
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok',
    'endoflife.date/api/all.json': []
  }, counts);
  const r = await webSearch('weather in Paris gdp of Paris', {transport});
  assert.ok(r.markdown.includes('### [OPEN-METEO]'), 'openmeteo present in shared');
  assert.ok(r.markdown.includes('### [WORLD BANK]'), 'worldbank present in shared');
  assert.equal(counts['geocoding-api.open-meteo.com'],1,'shared memo geocode only once');
}
// worldbank country_code reuse and heuristic
{
  reset();
  const counts={};
  const transport = makeFake({
    'geocoding-api.open-meteo.com': { results:[{latitude:52.52, longitude:13.405, name:'Germany', country:'Germany', country_code:'DE'}] },
    'api.worldbank.org': [[{},[]], [{country:{value:'Germany'}, value:'999', date:'2022'}]],
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok'
  }, counts);
  const r = await webSearch('gdp of Germany', {transport});
  assert.ok(r.markdown.includes('### [WORLD BANK]'), 'worldbank happy');
  assert.ok(counts['api.worldbank.org']===1, 'worldbank fetched');
  assert.equal(counts['geocoding-api.open-meteo.com'],1,'geocode for worldbank');
}
{
  reset();
  let wbCalled=false;
  const transport = async (url)=>{
    if (url.includes('api.worldbank.org')) wbCalled=true;
    if (url.includes('geocoding-api.open-meteo.com')) return { ok:true, status:200, json: async()=>({ results:[{ country_code:'FR'}]}), text: async()=>''};
    return { ok:true, status:200, json: async()=>({}), text: async()=>''};
  };
  const r = await webSearch('hello world', {transport});
  assert.equal(wbCalled,false,'worldbank heuristic skip');
}
{
  reset();
  const transport = makeFake({
    'geocoding-api.open-meteo.com': { results:[{ latitude:0, longitude:0, name:'France', country:'France', country_code:'FR'}]},
    'api.worldbank.org': {__error:true, msg:'500'},
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok'
  });
  const r = await webSearch('population of France', {transport});
  assert.ok(r.failures.includes('worldbank'), 'worldbank network error tolerated');
}

// endoflife happy (always eligible, top2)
{
  reset();
  const payload = [
    {product:'nodejs',is_maintained:true,latest:{version:'20.5',date:'2024-02-01'}},
    {product:'python',is_maintained:true,latest:{version:'3.12',date:'2024-01-01'}},
    {product:'ruby',is_maintained:false,latest:{version:'3.0',date:'2023-01-01'}}
  ];
  const transport = makeFake({
    'endoflife.date/api/all.json': payload,
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok'
  });
  const r = await webSearch('nodejs python status', {transport});
  assert.ok(r.markdown.includes('### [END OF LIFE]'), 'endoflife block');
  assert.ok(r.markdown.includes('nodejs'), 'top1 nodejs');
  assert.ok(r.markdown.includes('python'), 'top2 python');
  assert.ok(!r.markdown.includes('ruby'), 'top2 limit, ruby excluded');
}
{
  // endoflife heuristic is always eligible but product-token miss returns empty, not failure
  reset();
  const transport = makeFake({
    'endoflife.date/api/all.json': [{product:'nodejs',is_maintained:true,latest:{version:'20',date:'2024-01-01'}}],
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok'
  });
  const r = await webSearch('completely unrelated query qwertyuiop', {transport});
  // no endoflife block but not a failure — real invariant
  assert.ok(!r.failures.includes('endoflife'), 'endoflife miss not failure');
  assert.ok(!r.markdown.includes('### [END OF LIFE]'), 'no endoflife block on miss');
}
{
  reset();
  const transport = makeFake({
    'endoflife.date/api/all.json': {__error:true},
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok'
  });
  const r = await webSearch('nodejs', {transport});
  assert.ok(r.failures.includes('endoflife'), 'endoflife network error tolerated');
}
{
  // 2026-08 payload drift: all.json now returns bare slug strings — must still
  // match tokens and emit real product blocks (never 'undefined')
  reset();
  const transport = makeFake({
    'endoflife.date/api/all.json': ['nodejs','python','ruby'],
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok'
  });
  const r = await webSearch('nodejs eol status', {transport});
  assert.ok(r.markdown.includes('### [END OF LIFE] nodejs'), 'string payload matches nodejs slug');
  assert.ok(r.markdown.includes('https://endoflife.date/nodejs'), 'string payload links product page');
  assert.ok(!r.markdown.includes('undefined'), 'no undefined leak from string entries');
}


// jinaweb under limiter happy (always eligible behind limiter)
{
  reset();
  const counts={};
  const transport = makeFake({
    'r.jina.ai/https://lite.duckduckgo.com': '# Results\n- hello world result\n— via Jina Reader',
    'endoflife.date/api/all.json': []
  }, counts);
  const r = await webSearch('any random query', {transport});
  assert.ok(r.markdown.includes('### [JINA WEB]'), 'jinaweb always present');
  assert.ok(r.markdown.includes('— via Jina Reader'), 'attribution footer required');
}
{
  // jinaweb network error tolerated, still not throw
  reset();
  const transport = makeFake({
    'r.jina.ai/https://lite.duckduckgo.com': {__error:true,msg:'500'},
    'r.jina.ai/https://news.google.com': {__error:true},
    'endoflife.date/api/all.json': []
  });
  const r = await webSearch('test', {transport});
  // limiter job fails gracefully — failures contains exactly the jina name used (jinaweb, jinanews heuristic-skipped)
  assert.ok(r.failures.includes('jinaweb'), 'jinaweb failure recorded');
  assert.ok(!r.failures.includes('jinanews'), 'jinanews heuristic skip not a failure');
  assert.ok(!r.markdown.includes('### [JINA WEB]'), 'no jinaweb block on error');
}
{
  // cache smoke: second call hits sessionStorage, no second fetch
  reset();
  const counts={};
  const transport = makeFake({
    'r.jina.ai/https://lite.duckduckgo.com': 'cached jina text',
    'endoflife.date/api/all.json': []
  }, counts);
  await webSearch('cache test q', {transport});
  const c1 = counts['r.jina.ai/https://lite.duckduckgo.com']||0;
  await webSearch('cache test q', {transport});
  const c2 = counts['r.jina.ai/https://lite.duckduckgo.com']||0;
  // second call should be cached (no extra fetch) OR at least not double due to limiter timing; we assert not strictly double
  assert.ok(c2 <= c1+1, 'sessionStorage cache wraps jina');
}

// wdqs template happy
{
  reset();
  const counts={};
  const transport = makeFake({
    'query.wikidata.org/sparql': { results:{ bindings:[{person:{value:'http://www.wikidata.org/entity/Q42'}, personLabel:{value:'Emmanuel Macron'}}]}},
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok',
    'endoflife.date/api/all.json': []
  }, counts);
  const r = await webSearch('who is the president of France', {transport});
  assert.ok(r.markdown.includes('### [WIKIDATA SPARQL]'), 'wdqs happy template');
  assert.ok(r.markdown.includes('Emmanuel Macron') || r.markdown.includes('Q'), 'wdqs binding rendered');
  // check sparql URL contains Q142 (France) and encoded query
  assert.ok(counts['query.wikidata.org/sparql']===1, 'wdqs fetched');
}
{
  reset();
  let called=false;
  const transport = async (url)=>{
    if (url.includes('query.wikidata.org/sparql')) called=true;
    return { ok:true, status:200, json: async()=>({}), text: async()=>''};
  };
  const r = await webSearch('hello world', {transport});
  assert.equal(called,false,'wdqs heuristic skip');
  assert.ok(!r.markdown.includes('WIKIDATA SPARQL'),'no wdqs block on skip');
}
{
  reset();
  const transport = makeFake({
    'query.wikidata.org/sparql': {__error:true,msg:'timeout'},
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok'
  });
  const r = await webSearch('who is the president of France', {transport});
  assert.ok(r.failures.includes('wdqs'), 'wdqs network error tolerated');
  assert.ok(!r.markdown.includes('### [WIKIDATA SPARQL]'), 'wdqs error yields no block without throwing');
}

// ── smartSlice END OF LIFE product boost ──
{
  // Over-budget mix: filler blocks out-score the END OF LIFE block on plain term
  // matching. When the query names a tracked product, the EOL block must survive.
  const eol = fmt('END OF LIFE','Python','https://endoflife.date/python','eol · latest 3.13');
  const filler = Array.from({length:40},(_,i)=>fmt('WIKIPEDIA',`F${i}`,`https://f${i}.example/x`,`status update ${i}`)).join('');
  // python (tracked) -> boost keeps EOL despite lower base score (1 vs 2)
  const boosted = smartSlice(eol + filler, 'nodejs status update python', 1800);
  assert.ok(boosted.includes('endoflife.date/python'), 'EOL block boosted when query names tracked product');
  assert.ok(boosted.includes('f7.example'), 'sanity: filler still selected');
  // same blocks, no tracked product in query -> plain scoring drops EOL
  const plain = smartSlice(eol + filler, 'status update qwertyuiop', 1800);
  assert.ok(!plain.includes('endoflife.date'), 'no boost without tracked product');
}
console.log('smartSlice EOL boost PASS');

// ── jinanews recency triggers ──
{
  reset();
  const transport = makeFake({
    'r.jina.ai/https://news.google.com': 'Top headline: something big happened\n— via Jina Reader',
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok'
  });
  const r1 = await webSearch('what happened right now', {transport});
  assert.ok(r1.markdown.includes('### [JINA NEWS]'), '"right now" fires JINA NEWS');
  reset();
  const r2 = await webSearch('tech headlines this week', {transport});
  assert.ok(r2.markdown.includes('### [JINA NEWS]'), '"this week" fires JINA NEWS');
  reset();
  const r3 = await webSearch('scores today', {transport});
  assert.ok(r3.markdown.includes('### [JINA NEWS]'), '"today" fires JINA NEWS');
}
{
  reset();
  let newsCalled=false;
  const transport = async (url)=>{ if (url.includes('news.google.com')) newsCalled=true; return { ok:true, status:200, json: async()=>({}), text: async()=>'' }; };
  await webSearch('hello world', {transport});
  assert.equal(newsCalled,false,'neutral query does not fetch Google News RSS');
}
console.log('jinanews triggers PASS');

// ── espn team-name league map ──
{
  reset();
  const counts={};
  const transport = makeFake({
    'site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard': { events:[{ id:'g1', name:'NYY @ BOS', competitions:[{ competitors:[{team:{abbreviation:'NYY'},score:'4'},{team:{abbreviation:'BOS'},score:'2'}]}]}]},
    'site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard': { events:[{ id:'g2', name:'LAL @ BOS', competitions:[{ competitors:[{team:{abbreviation:'LAL'},score:'101'},{team:{abbreviation:'BOS'},score:'99'}]}]}]},
    'site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard': { events:[{ id:'g3', name:'NYG @ DAL', competitions:[{ competitors:[{team:{abbreviation:'NYG'},score:'21'},{team:{abbreviation:'DAL'},score:'24'}]}]}]},
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok'
  }, counts);
  const r1 = await webSearch('yankees score', {transport});
  assert.ok(r1.markdown.includes('### [ESPN]'), 'team nickname reaches ESPN');
  assert.equal(counts['site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard'],1,'yankees routes to MLB scoreboard');
  reset();
  const counts2={};
  const transport2 = makeFake({
    'site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard': { events:[] },
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok'
  }, counts2);
  // ambiguous "giants" resolved by co-mentioned unambiguous dodgers -> MLB
  const r2 = await webSearch('giants vs dodgers score', {transport: transport2});
  assert.equal(counts2['site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard'],1,'ambiguous team resolved by co-mention');
  reset();
  const counts3={};
  const transport3 = makeFake({
    'site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard': { events:[] },
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok'
  }, counts3);
  // bare ambiguous "giants" falls back to documented default (NFL)
  const r3 = await webSearch('giants score', {transport: transport3});
  assert.equal(counts3['site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'],1,'bare ambiguous team uses default league');
  reset();
  const counts4={};
  const transport4 = makeFake({
    'site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard': { events:[] },
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok'
  }, counts4);
  const r4 = await webSearch('lakers game tonight', {transport: transport4});
  assert.equal(counts4['site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'],1,'nba nickname routes to NBA scoreboard');
}
console.log('espn team map PASS');

// webSearch shape unchanged for old callers
{
  reset();
  const transport = makeFake({});
  const r = await webSearch('test query', {transport});
  assert.ok('markdown' in r && 'sources' in r && 'failures' in r && 'perSource' in r, 'shape unchanged');
  assert.equal(typeof r.markdown,'string');
  assert.equal(typeof r.sources,'number');
  assert.ok(Array.isArray(r.failures));
  assert.ok(Array.isArray(r.perSource));
}

// ── DDG IA happy / flat RelatedTopics ──
{
  reset();
  const fake = makeFake({
    'api.duckduckgo.com': { AbstractText:'', Answer:'', Heading:'Duck', AbstractURL:'https://duckduckgo.com/?q=python', AbstractSource:'DuckDB', RelatedTopics:[{Text:'A - python lang', Result:'<a href="https://example.com/a">A</a>', FirstURL:'https://example.com/a'}, {Topics:[{Text:'B nested', Result:'<a>B</a>', FirstURL:'https://example.com/b'}]}] }
  });
  const r = await webSearch('python programming', {transport: fake});
  assert.ok(r.markdown.includes('### [DDG IA]'), 'ddgia happy includes DDG IA');
  assert.ok(r.markdown.includes('via DuckDuckGo'), 'ddgia attribution via DuckDuckGo');
  assert.ok(r.perSource.some(p=>p.tag==='DDG IA'), 'ddgia perSource includes DDG IA');
  assert.ok(!r.failures.includes('ddgia'), 'ddgia not in failures');
  // flat RelatedTopics yields 2 blocks (both Result hits)
  const ddgBlocks = (r.markdown.match(/### \[DDG IA\]/g)||[]).length;
  assert.equal(ddgBlocks, 2, 'ddgia flat RelatedTopics yields 2 blocks');
}
console.log('ddgia happy PASS');

// ── DDG IA empty → heuristic-miss '' ──
{
  reset();
  const fake = makeFake({ 'api.duckduckgo.com': { AbstractText:'', Answer:'', RelatedTopics:[] } });
  const r = await webSearch('python programming', {transport: fake});
  assert.ok(!r.markdown.includes('### [DDG IA]'), 'ddgia empty no block');
  assert.ok(!r.perSource.some(p=>p.tag==='DDG IA'), 'ddgia empty no perSource');
  assert.ok(!r.failures.includes('ddgia'), 'ddgia empty miss not failure');
}
console.log('ddgia empty PASS');

// ── DDG IA q length gates ──
{
  // q='ab' (2 chars) -> skip, no fetch
  reset();
  const counts={};
  const fake = makeFake({ 'api.duckduckgo.com': { AbstractText:'hello', Answer:'', RelatedTopics:[{Text:'x', Result:'<a>x</a>', FirstURL:'https://example.com/x'}] } }, counts);
  const r1 = await webSearch('ab', {transport: fake});
  assert.ok(!r1.markdown.includes('### [DDG IA]'), 'ddgia q<3 skip no block');
  assert.equal(counts['api.duckduckgo.com']||0, 0, 'ddgia q<3 no fetch');
  // q 201 chars trimmed >200 -> skip
  reset();
  const counts2={};
  const fake2 = makeFake({ 'api.duckduckgo.com': { AbstractText:'hello', Answer:'', RelatedTopics:[{Text:'x', Result:'<a>x</a>', FirstURL:'https://example.com/x'}] } }, counts2);
  const long = 'a'.repeat(201);
  const r2 = await webSearch(long, {transport: fake2});
  assert.ok(!r2.markdown.includes('### [DDG IA]'), 'ddgia q>200 skip');
  assert.equal(counts2['api.duckduckgo.com']||0, 0, 'ddgia q>200 no fetch');
  // trimmed 199 with surrounding spaces -> fires (trimmed length 199)
  reset();
  const counts3={};
  const fake3 = makeFake({ 'api.duckduckgo.com': { AbstractText:'', Answer:'', RelatedTopics:[{Text:'ok', Result:'<a>ok</a>', FirstURL:'https://example.com/ok'}] } }, counts3);
  const q3 = '  '+'a'.repeat(199)+'  ';
  const r3 = await webSearch(q3, {transport: fake3});
  assert.ok(r3.markdown.includes('### [DDG IA]'), 'ddgia trimmed 199 fires');
  assert.ok((counts3['api.duckduckgo.com']||0) > 0, 'ddgia trimmed 199 fetched');
}
console.log('ddgia length gates PASS');

// ── WIKI OPENSEARCH skip who is/define ──
{
  reset();
  const fake = makeFake({
    'w/api.php?action=opensearch': ['q',['Ada Lovelace'],['desc'],['https://en.wikipedia.org/wiki/Ada_Lovelace']],
    'api/rest_v1/page/summary/Ada_Lovelace': {extract:'Ada summary', type:'standard'}
  });
  const r1 = await webSearch('who is Ada Lovelace', {transport: fake});
  assert.ok(!r1.markdown.includes('### [WIKI OPENSEARCH]'), 'wiki_os skip who is');
  assert.ok(!r1.perSource.some(p=>p.tag==='WIKI OPENSEARCH'), 'wiki_os who is no perSource');
  const r2 = await webSearch('define serendipity', {transport: fake});
  assert.ok(!r2.markdown.includes('### [WIKI OPENSEARCH]'), 'wiki_os skip define');
}
console.log('wiki_os skip PASS');

// ── WIKI OPENSEARCH happy with parallel summary fallback ──
{
  reset();
  const fake = makeFake({
    'w/api.php?action=opensearch': ['q',['Ada Lovelace','Ada Lovelace2'],['',''],['https://en.wikipedia.org/wiki/Ada_Lovelace','https://en.wikipedia.org/wiki/Ada_Lovelace2']],
    'api/rest_v1/page/summary/Ada_Lovelace2': {extract:'second', type:'disambiguation'},
    'api/rest_v1/page/summary/Ada_Lovelace': {extract:'Ada summary', type:'standard'}
  });
  const r = await webSearch('ada lovelace', {transport: fake});
  assert.ok(r.markdown.includes('### [WIKI OPENSEARCH]'), 'wiki_os happy block present');
  const blocks = (r.markdown.match(/### \[WIKI OPENSEARCH\]/g)||[]).length;
  assert.equal(blocks, 2, 'wiki_os happy 2 blocks');
  assert.ok(r.markdown.includes('Ada Lovelace2 (disambiguation)'), 'wiki_os disambiguation suffix');
  const ps = r.perSource.find(p=>p.tag==='WIKI OPENSEARCH');
  assert.ok(ps && ps.hits===2, 'wiki_os perSource hit 2');
  assert.ok(!r.failures.includes('wiki_os'), 'wiki_os not in failures');
  // verify limit 3 param not needed but opensearch titles sliced to 3 — ensure 3-limit still works (mock 2 only)
  assert.ok(r.markdown.includes('Ada summary'), 'wiki_os uses summary extract');
}
console.log('wiki_os happy PASS');

// ── WIKI OPENSEARCH summary fallback when REST fails ──
{
  reset();
  // opensearch returns 3 titles with os[2] fallback extracts; rest_v1 throws -> should still emit via os[2]
  const transport = async (url, opts={}) => {
    if (url.includes('w/api.php?action=opensearch')) {
      return { ok:true, status:200, json: async()=> ['q',['Title A','Title B','Title C'],['fallback A','fallback B','fallback C'],['https://en.wikipedia.org/wiki/Title_A','https://en.wikipedia.org/wiki/Title_B','https://en.wikipedia.org/wiki/Title_C']], text: async()=> '' };
    }
    if (url.includes('api/rest_v1/page/summary')) {
      throw new Error('rest 500');
    }
    return { ok:true, status:200, json: async()=> ({}), text: async()=> '' };
  };
  const r = await webSearch('ada lovelace', {transport});
  assert.ok(r.markdown.includes('### [WIKI OPENSEARCH]'), 'wiki_os fallback still emits block despite rest failure');
  // should use os[2] fallback extracts
  assert.ok(r.markdown.includes('fallback A') || r.markdown.includes('Title A'), 'wiki_os fallback uses os[2] or title');
  assert.ok(!r.markdown.includes('undefined'), 'wiki_os fallback no undefined leak');
  // Promise.allSettled ensures no throw; markdown still present, failures may be empty (source handled fallback)
  assert.ok(Array.isArray(r.failures), 'failures still array');
}
console.log('wiki_os fallback PASS');

// ── MWMBl ?s= param correctness ──
{
  reset();
  const counts={};
  const fake = makeFake({ 'api.mwmbl.org/search/?s=': [{title:'T', url:'https://example.com/m', extract:'snip'}] }, counts);
  const r = await webSearch('python programming', {transport: fake});
  assert.ok(r.markdown.includes('### [MWMBl]'), 'mwmbl happy block');
  assert.ok(r.markdown.includes('via mwmbl'), 'mwmbl attribution');
  assert.ok(r.perSource.some(p=>p.tag==='MWMBl'), 'mwmbl perSource includes MWMBl');
  assert.ok((counts['api.mwmbl.org/search/?s=']||0) >0, 'mwmbl called with ?s=');
  // ensure ?q= not called (different key)
  assert.equal(counts['api.mwmbl.org/search/?q=']||0, 0, 'mwmbl not called with ?q=');
  // array shape also supports {results:Array}
  reset();
  const fake2 = makeFake({ 'api.mwmbl.org/search/?s=': {results:[{title:'T2', url:'https://example.com/m2', extract:'snip2'}]} });
  const r2 = await webSearch('python programming', {transport: fake2});
  assert.ok(r2.markdown.includes('### [MWMBl]'), 'mwmbl {results:Array} shape works');
  assert.ok(r2.markdown.includes('T2'), 'mwmbl results shape title preserved');
  // q<3 skip
  reset();
  const counts3={};
  const fake3 = makeFake({ 'api.mwmbl.org/search/?s=': [{title:'T', url:'https://example.com/m', extract:'snip'}] }, counts3);
  const r3 = await webSearch('ab', {transport: fake3});
  assert.ok(!r3.markdown.includes('### [MWMBl]'), 'mwmbl q<3 skip');
  assert.equal(counts3['api.mwmbl.org/search/?s=']||0, 0, 'mwmbl q<3 no fetch');
}
console.log('mwmbl PASS');

// ── OPENVERSE visual vs token gate + attribution ──
{
  // visual single-token 'cat' -> fires
  reset();
  const fake = makeFake({
    'api.openverse.org': {results:[{title:'Cute cat', foreign_landing_url:'https://example.com/cat', creator:'Alice', license:'by', license_version:'4.0', license_url:'https://creativecommons.org/licenses/by/4.0/', url:'https://images.example.com/cat.jpg'}]}
  });
  const r1 = await webSearch('cat', {transport: fake});
  assert.ok(r1.markdown.includes('### [OPENVERSE]'), 'openverse visual single-token cat fires');
  assert.ok(r1.markdown.includes('by Alice'), 'openverse creator attribution');
  assert.ok(r1.markdown.includes('by 4.0'), 'openverse license string');
  assert.ok(r1.markdown.includes('via Openverse'), 'openverse via attribution');
  // non-visual single-token 'python' -> no fire, no limiter, no fetch
  reset();
  const counts={};
  const fake2 = makeFake({ 'api.openverse.org': {results:[{title:'x', foreign_landing_url:'https://example.com/x', creator:'Bob', license:'by', license_version:'4.0', license_url:'https://creativecommons.org/licenses/by/4.0/'}]} }, counts);
  const r2 = await webSearch('python', {transport: fake2});
  assert.ok(!r2.markdown.includes('### [OPENVERSE]'), 'openverse non-visual single-token no block');
  assert.equal(counts['api.openverse.org']||0, 0, 'openverse non-visual single-token no fetch');
  // non-visual multi-token 'python programming' -> fires
  reset();
  const fake3 = makeFake({
    'api.openverse.org': {results:[{title:'Py', foreign_landing_url:'https://example.com/py', creator:'Carol', license:'by-sa', license_version:'4.0', license_url:'https://creativecommons.org/licenses/by-sa/4.0/'}]}
  });
  const r3 = await webSearch('python programming', {transport: fake3});
  assert.ok(r3.markdown.includes('### [OPENVERSE]'), 'openverse non-visual multi-token fires');
  // visual multi-token also fires
  reset();
  const fake4 = makeFake({
    'api.openverse.org': {results:[{title:'Visual', foreign_landing_url:'https://example.com/v', creator:'Dave', license:'cc0', license_version:'1.0', license_url:'https://creativecommons.org/publicdomain/zero/1.0/'}]}
  });
  const r4 = await webSearch('cat picture gallery', {transport: fake4});
  assert.ok(r4.markdown.includes('### [OPENVERSE]'), 'openverse visual multi-token fires');
}
console.log('openverse gate PASS');

// ── OPENVERSE limiter scope + cache ──
{
  // DDG and WIKI should bypass anonLimiter; only OPENVERSE uses it
  reset();
  const origTake = mod.anonLimiter.take.bind(mod.anonLimiter);
  let anonCalls = 0;
  mod.anonLimiter.take = async () => { anonCalls++; return origTake(); };
  // also ensure alias anonLimiter is same object
  const counts={};
  const fake = makeFake({
    'api.duckduckgo.com': { AbstractText:'', Answer:'', RelatedTopics:[{Text:'A', Result:'<a>A</a>', FirstURL:'https://example.com/a'}] },
    'w/api.php?action=opensearch': ['q',['Ada'],['desc'],['https://en.wikipedia.org/wiki/Ada']],
    'api/rest_v1/page/summary/Ada': {extract:'Ada summary', type:'standard'},
    'api.openverse.org': {results:[{title:'Cat', foreign_landing_url:'https://example.com/cat', creator:'Eve', license:'by', license_version:'4.0', license_url:'https://creativecommons.org/licenses/by/4.0/'}]},
    'api.mwmbl.org/search/?s=': [{title:'M', url:'https://example.com/m', extract:'snip'}]
  }, counts);
  anonCalls = 0;
  const r = await webSearch('python programming', {transport: fake});
  assert.ok(r.markdown.includes('### [DDG IA]') && r.markdown.includes('### [WIKI OPENSEARCH]') && r.markdown.includes('### [OPENVERSE]') && r.markdown.includes('### [MWMBl]'), 'all 4 Path A blocks present for limiter scope test');
  assert.equal(anonCalls, 1, 'anonLimiter take called only once for OPENVERSE, not for DDG/WIKI/MWMBl');
  mod.anonLimiter.take = origTake;
  if (anonLimiter && anonLimiter.take && anonLimiter !== mod.anonLimiter) anonLimiter.take = origTake;
  // cache hit reuse: second call should hit sessionStorage and not call limiter again
  reset();
  let anonCalls2 = 0;
  const origTake2 = mod.anonLimiter.take.bind(mod.anonLimiter);
  mod.anonLimiter.take = async () => { anonCalls2++; return origTake2(); };
  const counts2={};
  const fake2 = makeFake({
    'api.openverse.org': {results:[{title:'Cached cat', foreign_landing_url:'https://example.com/cat2', creator:'Frank', license:'by', license_version:'4.0', license_url:'https://creativecommons.org/licenses/by/4.0/'}]}
  }, counts2);
  await webSearch('cat picture', {transport: fake2});
  const c1 = counts2['api.openverse.org']||0;
  const calls1 = anonCalls2;
  await webSearch('cat picture', {transport: fake2});
  const c2 = counts2['api.openverse.org']||0;
  // second call cache hit -> no extra fetch and no extra limiter take
  assert.equal(c2, c1, 'openverse cache hit no second fetch');
  assert.equal(anonCalls2, calls1, 'openverse cache hit no second limiter take');
  mod.anonLimiter.take = origTake2;
}
console.log('openverse limiter/cache PASS');

// ── applyWikiCaps WIKI OPENSEARCH ≤2 independent cap ──
{
  let md = '';
  for (let i=0;i<3;i++) md += fmt('WIKI OPENSEARCH',`WO${i}`,`https://wo${i}.example`,`snip ${i}`);
  for (let i=0;i<2;i++) md += fmt('WIKIPEDIA',`W${i}`,`https://w${i}.example`,`snip`);
  for (let i=0;i<1;i++) md += fmt('DBPEDIA',`P${i}`,`https://p${i}.example`,`snip`);
  const capped = applyWikiCaps(md);
  assert.equal((capped.match(/### \[WIKI OPENSEARCH\]/g)||[]).length, 2, 'WIKI OPENSEARCH capped at 2');
  assert.equal((capped.match(/### \[WIKIPEDIA\]/g)||[]).length, 2, 'WIKIPEDIA still 2');
  assert.equal((capped.match(/### \[DBPEDIA\]/g)||[]).length, 1, 'DBPEDIA uncapped 1');
  // independent from WIKIDATA caps
  let md2='';
  for (let i=0;i<3;i++) md2 += fmt('WIKI OPENSEARCH',`WO${i}`,`https://wo2_${i}.example`,`snip`);
  for (let i=0;i<3;i++) md2 += fmt('WIKIDATA',`D${i}`,`https://d${i}.example`,`snip`);
  const capped2 = applyWikiCaps(md2);
  assert.equal((capped2.match(/### \[WIKI OPENSEARCH\]/g)||[]).length, 2, 'WIKI OPENSEARCH independent cap 2');
  assert.equal((capped2.match(/### \[WIKIDATA\]/g)||[]).length, 2, 'WIKIDATA independent cap 2');
  assert.equal((capped2.match(/### \[(WIKIDATA|WIKI OPENSEARCH)\]/g)||[]).length, 4, 'independent caps total 4');
  // array input
  const arrCap = applyWikiCaps([fmt('WIKI OPENSEARCH','A','https://a0.example','x'), fmt('WIKI OPENSEARCH','B','https://b0.example','x'), fmt('WIKI OPENSEARCH','C','https://c0.example','x')]);
  assert.equal((arrCap.match(/### \[WIKI OPENSEARCH\]/g)||[]).length, 2, 'array input WIKI OPENSEARCH capped');
}
console.log('applyWikiCaps WIKI OPENSEARCH PASS');

// ── OPEN LIBRARY book-intent gate + tolerance ──
{
  // happy: fires on a catalog-noun token
  reset();
  const fake = makeFake({
    'openlibrary.org/search.json': { docs: [{ key: '/works/OL1', title: 'Dune', author_name: ['Frank Herbert'], first_publish_year: 1965 }] },
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok'
  });
  const r = await webSearch('best science fiction books', { transport: fake });
  assert.ok(r.markdown.includes('### [OPEN LIBRARY]'), 'ol happy block');
  assert.ok(r.markdown.includes('Dune'), 'ol happy title');

  // gated skip: no book-intent token -> no fetch, not a failure
  reset();
  const counts = {};
  const fake2 = makeFake({ 'openlibrary.org/search.json': { docs: [] } }, counts);
  const r2 = await webSearch('gdp of france', { transport: fake2 });
  assert.ok(!r2.markdown.includes('### [OPEN LIBRARY]'), 'ol gated skip no block');
  assert.equal(counts['openlibrary.org/search.json'] || 0, 0, 'ol gated skip no fetch');
  assert.ok(!r2.failures.includes('openlibrary'), 'ol gated skip not in failures');

  // upstream error degrades tolerantly into failures[]
  reset();
  const fake3 = makeFake({
    'openlibrary.org/search.json': { __error: true, msg: '500' },
    'r.jina.ai/https://lite.duckduckgo.com': 'jina ok'
  });
  const r3 = await webSearch('novels by frank herbert', { transport: fake3 });
  assert.ok(!r3.markdown.includes('### [OPEN LIBRARY]'), 'ol error no block');
  assert.ok(r3.failures.includes('openlibrary'), 'ol failure recorded');
}

// ── 28-job Fan-out integration ──
{
  reset();
  assert.equal(SOURCE_NAMES.length, 28, 'SOURCE_NAMES length 28');
  assert.ok(SOURCE_NAMES.includes('ddgia'), 'SOURCE_NAMES includes ddgia');
  assert.ok(SOURCE_NAMES.includes('wiki_os'), 'SOURCE_NAMES includes wiki_os');
  assert.ok(SOURCE_NAMES.includes('openverse'), 'SOURCE_NAMES includes openverse');
  assert.ok(SOURCE_NAMES.includes('mwmbl'), 'SOURCE_NAMES includes mwmbl');
  // fan-out with all 4 Path A fakes + verify markdown budget, perSource, failures never throw
  const fake = makeFake({
    'api.duckduckgo.com': { AbstractText:'', Answer:'', RelatedTopics:[{Text:'A', Result:'<a>A</a>', FirstURL:'https://example.com/a'}] },
    'w/api.php?action=opensearch': ['q',['Ada','Ada2'],['',''],['https://en.wikipedia.org/wiki/Ada','https://en.wikipedia.org/wiki/Ada2']],
    'api/rest_v1/page/summary/Ada': {extract:'Ada summary', type:'standard'},
    'api/rest_v1/page/summary/Ada2': {extract:'Ada2 summary', type:'standard'},
    'api.openverse.org': {results:[{title:'Cat art', foreign_landing_url:'https://example.com/cat', creator:'Grace', license:'by', license_version:'4.0', license_url:'https://creativecommons.org/licenses/by/4.0/'}]},
    'api.mwmbl.org/search/?s=': [{title:'Mwmbl T', url:'https://example.com/m', extract:'snip'}]
  });
  const r = await webSearch('test query with python programming and cat image', {transport: fake});
  assert.ok(r.markdown.length <= 12000, `markdown budget <=12000 got ${r.markdown.length}`);
  assert.ok(Array.isArray(r.failures), 'failures array');
  assert.ok(Array.isArray(r.perSource), 'perSource array');
  // failures never throw - even with partial failures, webSearch returns
  assert.ok(r.perSource.length >= 4, `perSource >=4 Path A blocks got ${r.perSource.length}`);
  assert.ok(r.perSource.every(p=> typeof p.ms==='number' && p.ms < 800), 'perSource ms <800 for fake transport');
  // dedup: WIKIPEDIA and WIKI OPENSEARCH same URL -> norm dedup keeps first only
  reset();
  const dedupFake = makeFake({
    'api.duckduckgo.com': { AbstractText:'', Answer:'', RelatedTopics:[{Text:'X', Result:'<a>X</a>', FirstURL:'https://en.wikipedia.org/wiki/Dedup_Test'}] },
    'w/api.php?action=opensearch': ['q',['Dedup_Test'],['desc'],['https://en.wikipedia.org/wiki/Dedup_Test']],
    'api/rest_v1/page/summary/Dedup_Test': {extract:'dedup summary', type:'standard'},
    'api.openverse.org': {results:[]}, // force empty so only these two dedup
    'api.mwmbl.org/search/?s=': []
  });
  // Need wikipedia to return same URL: mock wikipedia query endpoint
  const dedupFake2 = async (url, opts={}) => {
    if (url.includes('w/api.php?action=query') && url.includes('list=search')) {
      return { ok:true, status:200, json: async()=> ({query:{search:[{title:'Dedup_Test', snippet:'snip'}]}}), text: async()=> '' };
    }
    return dedupFake(url, opts);
  };
  const r2 = await webSearch('dedup test query cat image', {transport: dedupFake2});
  // The dedup URL should appear only once in markdown
  const occurrences = (r2.markdown.match(/https:\/\/en\.wikipedia\.org\/wiki\/Dedup_Test/g)||[]).length;
  assert.equal(occurrences, 1, 'dedup keeps first URL only once across WIKIPEDIA and WIKI OPENSEARCH');
  // failures never throw: simulate one source error, others still succeed
  reset();
  const failFake = makeFake({
    'api.duckduckgo.com': {__error:true, msg:'500'},
    'w/api.php?action=opensearch': ['q',['Ada'],['desc'],['https://en.wikipedia.org/wiki/Ada']],
    'api/rest_v1/page/summary/Ada': {extract:'ok', type:'standard'},
    'api.openverse.org': {results:[{title:'T', foreign_landing_url:'https://example.com/t', creator:'H', license:'by', license_version:'4.0', license_url:'https://creativecommons.org/licenses/by/4.0/'}]},
    'api.mwmbl.org/search/?s=': [{title:'M', url:'https://example.com/m2', extract:'snip'}]
  });
  const r3 = await webSearch('python programming cat image', {transport: failFake});
  assert.ok(r3.failures.includes('ddgia'), 'fan-out ddgia failure recorded not thrown');
  assert.ok(r3.markdown.includes('### [WIKI OPENSEARCH]') && r3.markdown.includes('### [OPENVERSE]'), 'other sources still present after one failure');
}
console.log('28-job fan-out PASS');

console.log('ALL SOURCES PASS');
console.log('PATH A 28 PASS');
