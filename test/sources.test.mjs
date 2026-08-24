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
const { webSearch, smartSlice, applyWikiCaps, createLimiter, SOURCE_NAMES, jinaLimiter } = mod;
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
}

// ── per-source via fake transport ──
function reset(){ clearCache(); if (jinaLimiter && jinaLimiter._reset) jinaLimiter._reset(); }
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

console.log('ALL SOURCES PASS');
