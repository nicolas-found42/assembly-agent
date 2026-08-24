// search.js — parallel fan-out meta-search (keyless-first, spread load).
// Every source is failure-tolerant: a failure simply omits that block.
// ADR 0004: 12 keyless Sources (4 existing + 8 P0: GDELT dropped — 17s timeout breaks 8s SLO), DDG + keyed dropped, grouped by Source weight, dedup norm(url), 12k slice, retry once on Timeout/429.
// ADR 0008: +13 general Sources (espn/mlb/coingecko/frankfurter/openmeteo/worldbank/endoflife/cep/wdqs/jinaweb/jinanews/dictionary/tvmaze), heuristic gating + smartSlice + caps + limiter + cache.

/*
Heuristics — one block (ADR 0008):
- espn:       /\b(nfl|nba|mlb|premier league|soccer league)\b/i  → ESPN scoreboard /apis/site/v2/sports/{league}/scoreboard
- mlb:        /\b(mlb|baseball)\b/i                              → statsapi.mlb.com schedule (today)
- coingecko:  /\b(bitcoin|btc|ethereum|eth|solana|sol|dogecoin|doge|cardano|ada|litecoin|ltc|ripple|xrp|polkadot|dot|chainlink|link)\b/i → coingecko simple/price
- frankfurter:/\b(usd|eur|gbp|jpy|cad|aud|chf|cny|inr|brl|rub|krw|mxn|sek|nok|dkk|pln|try|nzd|sgd|hkd|zar|aed|thb|dollar|euro|yen|pound)\b/i (needs ≥2 distinct codes) → frankfurter latest
- openmeteo:  /(weather|temperature|forecast)/i OR place-intent (extractPlace) → geocode (memoized per turn) → forecast; geocoder fires on ANY place-bearing query (for worldbank reuse)
- worldbank:  /(gdp|population|economy)/i + country (country_code via SAME memoized geocode) → api.worldbank.org indicator NY.GDP.MKTP.CD / SP.POP.TOTL
- endoflife:  always eligible; fetches endoflife.date/api/all.json then client-side product-token match (top 2)
- cep:        /(news|current events|headlines|breaking)/i → wikipedia Portal:Current_events parse
- wdqs:       /^who (is|leads)|current (president|prime minister|ceo|pope|king|monarch)/i → small hardcoded Q-id map (~20) → query.wikidata.org/sparql (tiny LIMIT 3) — document limits
- dictionary: /(what does .* mean|define\s+\w+)/i → dictionaryapi.dev entries
- tvmaze:     /(tv show|series|episode|tv series)/i → api.tvmaze.com/search/shows
- jinaweb:    ALWAYS eligible behind shared limiter (20/min) → r.jina.ai/https://lite.duckduckgo.com/lite/?q=… + attribution footer
- jinanews:   /(news|headlines)/i behind same limiter → r.jina.ai/https://news.google.com/rss/search?q=…
- StackExchange upgraded: withbody + sites [stackoverflow,cooking,diy,physics] parallel fan-out + quota_remaining>50 guard for answer-hop
- Caps: applyWikiCaps limits WIKIPEDIA ≤2 and WIKIDATA* ≤2 blocks (header regex ^### \[TAG\]), DBPEDIA uncapped
- Slice: smartSlice term-scored selection preserving original order, budget 12000
- Cache: sessionStorage URL-hash 10-min TTL wrapping jina + wdqs fetches
*/

const TIMEOUT = 8000;

function fmt(tag, title, url, snippet) {
  let out = `### [${tag}] ${title}\n`;
  if (url) out += `${url}\n`;
  if (snippet) out += `${snippet}\n`;
  return out + '\n';
}

/** Parse fmt blocks back into structured hits: [{ tag, title, url, snippet }] in dedup order. */
export function parseBlocks(markdown) {
  const out = [];
  for (const block of markdown.split(/(?=### \[)/)) {
    const m = block.match(/^### \[([^\]]+)\] (.+)\n(\S*)\n?([\s\S]*)$/);
    if (m) out.push({ tag: m[1], title: m[2], url: m[3], snippet: m[4] });
  }
  return out;
}

const stripTags = (s) => String(s || '').replace(/<[^>]*>/g, '').trim();
const norm = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();

// timed with one retry after ~1s for Timeout (AbortError) and 429 only.
// Other errors push to failures immediately. Failure-tolerant: never throws.
async function timed(name, fn, failures) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const r = await fn(ctl.signal);
      clearTimeout(t);
      return r;
    } catch (e) {
      clearTimeout(t);
      const msg = String(e && e.message || e || '');
      const isAbort = e && e.name === 'AbortError';
      const is429 = msg.includes('429') || msg.includes('Too Many Requests');
      const retryable = isAbort || is429;
      if (attempt === 0 && retryable) {
        await new Promise((res) => setTimeout(res, 1000));
        continue;
      }
      failures.push(name);
      return null;
    }
  }
  failures.push(name);
  return null;
}

async function jfetch(url, opts = {}, transport = fetch) {
  const r = await transport(url, opts);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
async function jfetchText(url, opts = {}, transport = fetch) {
  const r = await transport(url, opts);
  if (!r.ok) throw new Error(String(r.status));
  return r.text();
}

// ── sessionStorage cache (URL-hash, 10-min TTL) for jina + wdqs ──
function hashUrl(s) { let h=0; for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return h.toString(16); }
function cacheGet(key) {
  try {
    const store = (typeof sessionStorage !== 'undefined' && sessionStorage) ? sessionStorage : globalThis.sessionStorage;
    if (!store) return null;
    const raw = store.getItem(key);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (Date.now() - o.t > 600000) { try{ store.removeItem(key);}catch{} return null; }
    return o.v;
  } catch { return null; }
}
function cacheSet(key, v) {
  try {
    const store = (typeof sessionStorage !== 'undefined' && sessionStorage) ? sessionStorage : globalThis.sessionStorage;
    if (!store) return;
    store.setItem(key, JSON.stringify({ t: Date.now(), v }));
  } catch {}
}
async function cachedJson(url, sig, transport) {
  const k = 'asm:' + hashUrl(url);
  const hit = cacheGet(k);
  if (hit !== null) return hit;
  const j = await jfetch(url, { signal: sig }, transport);
  cacheSet(k, j);
  return j;
}
async function cachedText(url, sig, transport) {
  const k = 'asm:' + hashUrl(url);
  const hit = cacheGet(k);
  if (hit !== null) return hit;
  const t = await jfetchText(url, { signal: sig }, transport);
  cacheSet(k, t);
  return t;
}

// ── existing keyless sources (untouched except stackexchange upgrade) ──
async function wikipedia(q, sig, transport) {
  const u = `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&list=search&srsearch=${encodeURIComponent(q)}&srlimit=3`;
  const j = await jfetch(u, { signal: sig }, transport);
  return (j?.query?.search || []).map((s) =>
    fmt('WIKIPEDIA', s.title, `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`, stripTags(s.snippet))).join('');
}

async function hackernews(q, sig, transport) {
  const u = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&hitsPerPage=4`;
  const j = await jfetch(u, { signal: sig }, transport);
  return (j?.hits || []).map((h) =>
    fmt('HACKER NEWS', h.title || h.story_title || '', h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      `${h.points || 0} points · ${h.num_comments || 0} comments`)).join('');
}

// Sticky guard: ~4 req/turn burn (stackoverflow + 3 extras). When quota_remaining < 50, restrict to ['stackoverflow'] only for remainder of session.
let seRestricted = false;
async function stackexchange(q, sig, transport) {
  const sites = seRestricted ? ['stackoverflow'] : ['stackoverflow', 'cooking', 'diy', 'physics'];
  const results = await Promise.allSettled(sites.map((site) => {
    const u = `https://api.stackexchange.com/2.3/search/advanced?q=${encodeURIComponent(q)}&site=${site}&pagesize=3&filter=withbody&order=desc&sort=relevance`;
    return jfetch(u, { signal: sig }, transport);
  }));
  let out = '';
  for (let i = 0; i < sites.length; i++) {
    const r = results[i];
    if (r.status !== 'fulfilled' || !r.value) continue;
    const j = r.value;
    if (typeof j.quota_remaining === 'number' && j.quota_remaining < 50) seRestricted = true;
    const items = j.items || [];
    for (const it of items) {
      const body = stripTags(it.body || '').slice(0, 200);
      out += fmt('STACK OVERFLOW', it.title || q, it.link || '', `${body} · score ${it.score ?? 0} · ${it.is_answered ? 'answered' : 'unanswered'}`);
    }
  }
  return out;
}

async function github(q, sig, transport) {
  const u = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=4`;
  const j = await jfetch(u, { signal: sig, headers: { Accept: 'application/vnd.github+json' } }, transport);
  return (j?.items || []).map((r) =>
    fmt('GITHUB', r.full_name, r.html_url, `★ ${r.stargazers_count} — ${r.description || ''}`)).join('');
}

// ── 9 P0 keyless Sources (ADR 0004) ──

async function wikidata(q, sig, transport) {
  const u = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=en&format=json&limit=3&origin=*`;
  const j = await jfetch(u, { signal: sig }, transport);
  return (j?.search || []).map((e) =>
    fmt('WIKIDATA', `${e.label}${e.description ? ` — ${e.description}` : ''}`, e.concepturi || `https://www.wikidata.org/wiki/${e.id}`, `QID ${e.id} · match ${e.match?.type || ''} ${e.match?.text || ''}`.trim())).join('');
}

async function openalex(q, sig, transport) {
  const u = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per_page=3&select=id,display_name,doi,publication_year,authorships,primary_location,cited_by_count,open_access`;
  const j = await jfetch(u, { signal: sig }, transport);
  return (j?.results || []).map((w) => {
    const title = w.display_name || '';
    const url = w.doi || w.id || '';
    const year = w.publication_year ? `(${w.publication_year})` : '';
    const auth = (w.authorships || []).slice(0, 2).map((a) => a.author?.display_name).filter(Boolean).join(', ');
    const venue = w.primary_location?.source?.display_name || '';
    const oa = w.open_access?.is_oa ? ' · OA' : '';
    return fmt('OPENALEX', `${title} ${year}`.trim(), url, `${auth ? auth + ' — ' : ''}${venue}${oa} · cited_by ${w.cited_by_count ?? '—'}`.trim());
  }).join('');
}

async function crossref(q, sig, transport) {
  const mail = 'asm-agent@example.com';
  const u = `https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=3&select=DOI,title,author,URL,container-title,abstract,created&mailto=${encodeURIComponent(mail)}`;
  const j = await jfetch(u, { signal: sig, headers: { Accept: 'application/json' } }, transport);
  return (j?.message?.items || []).map((w) => {
    const title = (w.title && w.title[0]) || w.DOI || '';
    const url = w.URL || (w.DOI ? `https://doi.org/${w.DOI}` : '');
    const auth = (w.author || []).slice(0, 2).map((a) => [a.given, a.family].filter(Boolean).join(' ')).join(', ');
    const venue = (w['container-title'] && w['container-title'][0]) || '';
    const abs = w.abstract ? stripTags(w.abstract).slice(0, 220) : '';
    return fmt('CROSSREF', title, url, `${auth ? auth + ' · ' : ''}${venue}${abs ? ' — ' + abs : ''}`.trim());
  }).join('');
}

async function semanticscholar(q, sig, transport) {
  const u = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=3&fields=title,abstract,url,citationCount,year,authors`;
  const j = await jfetch(u, { signal: sig }, transport);
  const data = j?.data || j?.papers || [];
  return (data).map((p) =>
    fmt('SEMANTIC SCHOLAR', p.title || '', p.url || '', `${(p.authors || []).slice(0, 2).map((a) => a.name).join(', ')}${p.year ? ` · ${p.year}` : ''}${p.citationCount ? ` · cited ${p.citationCount}` : ''} — ${stripTags(p.abstract || '').slice(0, 180)}`.trim())).join('');
}

async function doaj(q, sig, transport) {
  const u = `https://doaj.org/api/v4/search/articles/${encodeURIComponent(q)}?pageSize=3`;
  const j = await jfetch(u, { signal: sig }, transport);
  return (j?.results || []).map((r) => {
    const b = r.bibjson || {};
    const title = b.title || q;
    const doi = (b.identifier || []).find((x) => x.type === 'doi')?.id;
    const url = doi ? `https://doi.org/${doi}` : (b.link || [])[0]?.url || '';
    const journal = b.journal?.title || '';
    const year = b.year || '';
    const abs = stripTags(b.abstract || '').slice(0, 220);
    return fmt('DOAJ', `${title}${year ? ` (${year})` : ''}`, url, `${journal ? journal + ' — ' : ''}${abs}`.trim());
  }).join('');
}

async function openlibrary(q, sig, transport) {
  const u = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=3&fields=key,title,author_name,first_publish_year,cover_edition_key`;
  const j = await jfetch(u, { signal: sig }, transport);
  return (j?.docs || []).map((d) =>
    fmt('OPEN LIBRARY', d.title || q, `https://openlibrary.org${d.key}`, `${(d.author_name || []).slice(0, 2).join(', ')}${d.first_publish_year ? ` · ${d.first_publish_year}` : ''}`.trim())).join('');
}

async function dbpedia(q, sig, transport) {
  const u = `https://lookup.dbpedia.org/api/search?query=${encodeURIComponent(q)}&format=JSON&maxResults=3`;
  const j = await jfetch(u, { signal: sig, headers: { Accept: 'application/json' } }, transport);
  const docs = j?.docs || j?.results || [];
  const arr = Array.isArray(docs) ? docs : [];
  return arr.map((d) => {
    const res = Array.isArray(d.resource) ? d.resource[0] : d.resource || d.uri || '';
    const label = d.label || d.title || q;
    const comment = stripTags(d.comment || d.description || '').slice(0, 220);
    return fmt('DBPEDIA', label, res, comment);
  }).join('');
}

async function lobsters(q, sig, transport) {
  const j = await jfetch('https://lobste.rs/hottest.json', { signal: sig }, transport);
  const all = Array.isArray(j) ? j : [];
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = all.filter((s) => {
    const hay = `${s.title || ''} ${s.tags ? s.tags.join(' ') : ''} ${s.url || ''}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  }).slice(0, 3);
  const out = filtered.length ? filtered : all.slice(0, 2);
  return out.map((s) =>
    fmt('LOBSTE.RS', s.title || q, s.short_id_url || s.url || `https://lobste.rs/s/${s.short_id}`, `${s.score ?? 0} points · ${s.comment_count ?? 0} comments · tags ${ (s.tags || []).join(', ')}`)).join('');
}

// ── helpers for place extraction + geocode memo ──
function extractPlace(q) {
  let m;
  m = q.match(/\bin\s+([A-Za-z][A-Za-z\s\-']{1,30})/);
  if (m) return m[1].trim().split(/\s+/).slice(0,3).join(' ').replace(/[.,;!?]+$/,'');
  m = q.match(/\b(?:of|for)\s+([A-Za-z][A-Za-z\s\-']{1,30})/);
  if (m) return m[1].trim().split(/\s+/).slice(0,3).join(' ').replace(/[.,;!?]+$/,'');
  m = q.match(/\bat\s+([A-Za-z][A-Za-z\s\-']{1,30})/);
  if (m) return m[1].trim().split(/\s+/).slice(0,3).join(' ').replace(/[.,;!?]+$/,'');
  const known = ['france','germany','japan','paris','london','berlin','usa','united states','america','canada','italy','spain','india','china','brazil','uk','england','tokyo','sydney','mexico','australia','russia','ukraine','poland','netherlands'];
  const lower = q.toLowerCase();
  for (const k of known) if (lower.includes(k)) return k;
  return null;
}

// ── new sources ──
async function espn(q, sig, transport) {
  const lower = q.toLowerCase();
  let leaguePath = null;
  if (/\bnfl\b/.test(lower)) leaguePath = 'football/nfl';
  else if (/\bnba\b/.test(lower)) leaguePath = 'basketball/nba';
  else if (/\bmlb\b/.test(lower)) leaguePath = 'baseball/mlb';
  else if (/premier league/.test(lower)) leaguePath = 'soccer/eng.1';
  else if (/soccer league/.test(lower)) leaguePath = 'soccer/eng.1';
  else if (/\bsoccer\b/.test(lower)) leaguePath = 'soccer/eng.1';
  else return '';
  const u = `https://site.api.espn.com/apis/site/v2/sports/${leaguePath}/scoreboard`;
  const j = await jfetch(u, { signal: sig }, transport);
  const events = j?.events || j?.scoreboard?.events || [];
  if (!events.length) return fmt('ESPN', `${leaguePath} scoreboard`, u, 'no events');
  return events.slice(0,3).map((ev) => {
    const comp = ev.competitions?.[0] || ev;
    const competitors = comp?.competitors || ev.competitors || [];
    const title = ev.name || ev.shortName || `${competitors.map((c)=>c.team?.displayName || c.team?.abbreviation || '').join(' vs ')}`.trim() || `${leaguePath} game`;
    const url = `https://www.espn.com/${leaguePath}/game/_/gameId/${ev.id || ''}`;
    const snippet = competitors.map((c)=>`${c.team?.abbreviation || c.team?.displayName || ''} ${c.score ?? ''}`.trim()).join(' - ') || stripTags(ev.status || '').slice(0,120);
    return fmt('ESPN', title, url, snippet);
  }).join('');
}

async function mlbSource(q, sig, transport) {
  if (!/\b(mlb|baseball)\b/i.test(q)) return '';
  const date = new Date().toISOString().slice(0,10);
  const u = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`;
  const j = await jfetch(u, { signal: sig }, transport);
  const dates = j?.dates || [];
  const games = dates.flatMap((d)=>d.games || []).slice(0,3);
  if (!games.length) return fmt('MLB', 'MLB schedule ' + date, u, 'no games');
  return games.map((g) => fmt('MLB', `${g.teams?.away?.team?.name || 'Away'} @ ${g.teams?.home?.team?.name || 'Home'}`, `https://www.mlb.com/gameday/${g.gamePk || ''}`, `${g.status?.detailedState || ''} ${g.venue?.name || ''}`.trim())).join('');
}

async function coingeckoSource(q, sig, transport) {
  const map = { bitcoin:'bitcoin', btc:'bitcoin', ethereum:'ethereum', eth:'ethereum', solana:'solana', sol:'solana', dogecoin:'dogecoin', doge:'dogecoin', cardano:'cardano', ada:'cardano', litecoin:'litecoin', ltc:'litecoin', ripple:'ripple', xrp:'ripple', polkadot:'polkadot', dot:'polkadot', chainlink:'chainlink', link:'chainlink' };
  const lower = q.toLowerCase();
  const ids = new Set();
  for (const [tok,id] of Object.entries(map)) if (new RegExp(`\\b${tok}\\b`, 'i').test(lower)) ids.add(id);
  if (!ids.size) return '';
  const idsStr = [...ids].join(',');
  const u = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(idsStr)}&vs_currencies=usd`;
  const j = await jfetch(u, { signal: sig }, transport);
  return [...ids].map((id) => {
    const price = j?.[id]?.usd;
    if (price == null) return '';
    return fmt('COINGECKO', `${id} price`, `https://www.coingecko.com/en/coins/${id}`, `$${price} USD`);
  }).join('');
}

async function frankfurterSource(q, sig, transport) {
  const nameMap = { dollar:'usd', euro:'eur', yen:'jpy', pound:'gbp' };
  const curRe = /\b(usd|eur|gbp|jpy|cad|aud|chf|cny|inr|brl|rub|krw|mxn|sek|nok|dkk|pln|try|nzd|sgd|hkd|zar|aed|thb|dollar|euro|yen|pound)\b/gi;
  const found = [...q.toLowerCase().matchAll(curRe)].map((m)=>m[1].toLowerCase());
  const codes = found.map((c)=> nameMap[c] || c);
  const uniq = [...new Set(codes)];
  if (uniq.length < 2) return '';
  const from = uniq[0].toUpperCase();
  const to = uniq[1].toUpperCase();
  if (from === to) return '';
  const u = `https://api.frankfurter.dev/v1/latest?from=${from}&to=${to}`;
  const j = await jfetch(u, { signal: sig }, transport);
  const rate = j?.rates?.[to];
  return fmt('FRANKFURTER', `${from}→${to}`, `https://www.frankfurter.dev/`, rate != null ? `1 ${from} = ${rate} ${to}` : `${from}→${to} rate`);
}

async function openmeteoSource(q, sig, transport, getGeo) {
  const hasWeather = /(weather|temperature|forecast)/i.test(q);
  const place = extractPlace(q);
  if (!hasWeather && !place) return '';
  if (!place) return '';
  const geo = await getGeo(place, sig);
  if (!geo) return '';
  const { latitude, longitude, name, country } = geo;
  if (latitude == null || longitude == null) return '';
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code`;
  const j = await jfetch(u, { signal: sig }, transport);
  const cur = j?.current || {};
  return fmt('OPEN-METEO', `${name || place} weather`, `https://open-meteo.com/en/docs#latitude=${latitude}&longitude=${longitude}`, `temp ${cur.temperature_2m ?? '—'}°C code ${cur.weather_code ?? ''} ${country ? '('+country+')':''}`.trim());
}

async function worldbankSource(q, sig, transport, getGeo) {
  if (!/(gdp|population|economy)/i.test(q)) return '';
  const place = extractPlace(q);
  if (!place) return '';
  const geo = await getGeo(place, sig);
  if (!geo?.country_code) return '';
  const code = geo.country_code;
  let indicator = 'NY.GDP.MKTP.CD';
  if (/population/i.test(q)) indicator = 'SP.POP.TOTL';
  else if (/economy/i.test(q)) indicator = 'NY.GDP.MKTP.CD';
  const u = `https://api.worldbank.org/v2/country/${code}/indicator/${indicator}?format=json&per_page=3&date=2018:2024`;
  const j = await jfetch(u, { signal: sig }, transport);
  const data = Array.isArray(j) ? j[1] : (j?.data || null);
  if (!Array.isArray(data) || !data.length) return '';
  return data.slice(0,3).map((d)=> fmt('WORLD BANK', `${d.country?.value || code} ${indicator}`, `https://data.worldbank.org/indicator/${indicator}?locations=${code}`, `${d.value ?? '—'} (${d.date || ''})`.trim())).join('');
}

async function endoflifeSource(q, sig, transport) {
  const u = `https://endoflife.date/api/all.json`;
  const j = await jfetch(u, { signal: sig }, transport);
  if (!Array.isArray(j)) return '';
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = [];
  for (const p of j) {
    const prod = String(p.product || '').toLowerCase();
    const hit = terms.some((t)=> prod.includes(t) || t.includes(prod));
    if (hit) scored.push(p);
  }
  const top = scored.slice(0,2);
  if (!top.length) return '';
  return top.map((p)=> fmt('END OF LIFE', p.product, `https://endoflife.date/${p.product}`, `${p.is_maintained ? 'maintained' : 'eol'} · latest ${p.latest?.version || ''} (${p.latest?.date || ''})`.trim())).join('');
}

async function cepSource(q, sig, transport) {
  if (!/(news|current events|headlines|breaking)/i.test(q)) return '';
  const u = `https://en.wikipedia.org/w/api.php?action=parse&page=Portal:Current_events&format=json&origin=*`;
  const j = await cachedJson(u, sig, transport);
  const html = j?.parse?.text?.['*'] || j?.parse?.text || '';
  const raw = String(html);
  const items = [...raw.matchAll(/<li>(.*?)<\/li>/gs)].map((m)=> stripTags(m[1]).slice(0,200).trim()).filter(Boolean).slice(0,3);
  if (!items.length) {
    // fallback: any text
    const fallback = stripTags(raw).slice(0,300).trim();
    if (!fallback) return '';
    return fmt('CURRENT EVENTS', 'Current events', 'https://en.wikipedia.org/wiki/Portal:Current_events', fallback.slice(0,200));
  }
  return items.map((t)=> fmt('CURRENT EVENTS', t.slice(0,60), 'https://en.wikipedia.org/wiki/Portal:Current_events', t)).join('');
}

const WDQS_MAP = {
  'president:usa':'Q30','president:united states':'Q30','president:america':'Q30',
  'president:france':'Q142','president:germany':'Q183','president:russia':'Q159','president:china':'Q148','president:brazil':'Q155','president:india':'Q668','president:japan':'Q17',
  'prime minister:uk':'Q145','prime minister:united kingdom':'Q145','prime minister:canada':'Q16','prime minister:france':'Q142','prime minister:germany':'Q183','prime minister:japan':'Q17','prime minister:india':'Q668','prime minister:australia':'Q408','prime minister:italy':'Q38',
  'ceo:apple':'Q312','ceo:tesla':'Q478214','ceo:microsoft':'Q2283','ceo:google':'Q95','ceo:meta':'Q380','ceo:amazon':'Q3884',
  'pope':'Q19546','king:uk':'Q145','king:united kingdom':'Q145','monarch:uk':'Q145','king:sweden':'Q34','king:spain':'Q29'
};
function wdqsLookup(q) {
  const lower = q.toLowerCase();
  // direct pope / king check
  if (/\bpope\b/.test(lower)) return { qid: WDQS_MAP['pope'], prop:'wdt:P39' };
  if (/\b(king|monarch)\b/.test(lower)) {
    // try country suffix
    for (const k of Object.keys(WDQS_MAP)) if (k.startsWith('king:') || k.startsWith('monarch:')) if (lower.includes(k.split(':')[1])) return { qid: WDQS_MAP[k], prop:'wdt:P6' };
    return { qid: WDQS_MAP['king:uk'], prop:'wdt:P6' };
  }
  let office = null;
  if (/president/i.test(q)) office='president';
  else if (/prime minister/i.test(q)) office='prime minister';
  else if (/\bceo\b/i.test(q)) office='ceo';
  else return null;
  // extract country/company after of/for/in
  let place = null;
  const m = q.match(/(?:of|for|in)\s+([A-Za-z][A-Za-z\s]{1,30})/i);
  if (m) place = m[1].trim().toLowerCase().split(/\s+/).slice(0,3).join(' ');
  const key = office + (place ? ':'+place : '');
  let qid = WDQS_MAP[key];
  if (!qid) {
    // try office alone for ceo? fallback search
    for (const k of Object.keys(WDQS_MAP)) if (k.startsWith(office+':') && lower.includes(k.split(':')[1])) { qid = WDQS_MAP[k]; break; }
  }
  if (!qid && office==='president' && !place) qid = WDQS_MAP['president:usa'];
  if (!qid) return null;
  // presidents/PMs use P6 (head of state) for demo, CEOs use P169? use P6 for simplicity doc says P6/P39
  const prop = office==='ceo' ? 'wdt:P169' : 'wdt:P6';
  if (office==='pope') return { qid, prop:'wdt:P39' };
  return { qid, prop };
}
async function wdqsSource(q, sig, transport) {
  if (!/^who (is|leads)|current (president|prime minister|ceo|pope|king|monarch)/i.test(q)) return '';
  const hit = wdqsLookup(q);
  if (!hit) return '';
  const sparql = `SELECT ?person ?personLabel WHERE { wd:${hit.qid} ${hit.prop} ?person . SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 3`;
  const u = `https://query.wikidata.org/sparql?query=${encodeURIComponent(sparql)}&format=json`;
  const j = await cachedJson(u, sig, transport);
  const bindings = j?.results?.bindings || [];
  if (!bindings.length) return fmt('WIKIDATA SPARQL', `office ${hit.qid}`, `https://query.wikidata.org/#${encodeURIComponent(sparql)}`, 'no results');
  return bindings.slice(0,3).map((b)=>{
    const uri = b.person?.value || '';
    const label = b.personLabel?.value || b.person?.value || 'result';
    return fmt('WIKIDATA SPARQL', label, uri, `office ${hit.qid} holder`);
  }).join('');
}

export function createLimiter(perMinute) {
  const interval = 60000 / Math.max(1, perMinute);
  let last = 0;
  let queue = Promise.resolve();
  return {
    take() {
      const task = queue.then(async () => {
        const now = Date.now();
        const wait = Math.max(0, last + interval - now);
        if (wait > 0) await new Promise((r)=> setTimeout(r, wait));
        last = Date.now();
      });
      queue = task.catch(()=>{});
      return task;
    },
    // test helper: reset timing
    _reset(){ last=0; queue=Promise.resolve(); }
  };
}
// Module-scoped jina limiter — 20/min enforced across webSearch calls/turns
export const jinaLimiter = createLimiter(20);
async function jinaHelper(q, tag, target, sig, transport, limiter) {
  const url = `https://r.jina.ai/${target}`;
  const k = 'asm:' + hashUrl(url);
  let text;
  const hit = cacheGet(k);
  if (hit !== null) {
    text = hit;
  } else {
    if (limiter) await limiter.take();
    text = await cachedText(url, sig, transport);
  }
  const snippet = String(text).slice(0, 800);
  const title = tag === 'JINA NEWS' ? `news for ${q.slice(0,60)}` : `web results for ${q.slice(0,60)}`;
  return fmt(tag, title, target, snippet + '\n— via Jina Reader');
}
async function jinawebSource(q, sig, transport, limiter) {
  const target = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`;
  return jinaHelper(q, 'JINA WEB', target, sig, transport, limiter ?? jinaLimiter);
}
async function jinanewsSource(q, sig, transport, limiter) {
  if (!/(news|headlines)/i.test(q)) return '';
  const target = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  return jinaHelper(q, 'JINA NEWS', target, sig, transport, limiter ?? jinaLimiter);
}

async function dictionarySource(q, sig, transport) {
  let word = null;
  let m = q.match(/what does\s+["']?([a-zA-Z\-]+)["']?\s+mean/i);
  if (m) word = m[1];
  else { m = q.match(/\bdefine\s+["']?([a-zA-Z\-]+)["']?/i); if (m) word = m[1]; }
  if (!word) return '';
  const u = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`;
  const j = await jfetch(u, { signal: sig }, transport);
  const entry = Array.isArray(j) ? j[0] : j;
  const def = entry?.meanings?.[0]?.definitions?.[0]?.definition || entry?.meanings?.[0]?.definitions?.[0] || '';
  const txt = typeof def === 'string' ? def : (def.definition || '');
  if (!txt) return '';
  return fmt('DICTIONARY', `${word} definition`, `https://api.dictionaryapi.dev/api/v2/entries/en/${word}`, txt.slice(0,300));
}

async function tvmazeSource(q, sig, transport) {
  if (!/(tv show|series|episode|tv series)/i.test(q)) return '';
  const u = `https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`;
  const j = await jfetch(u, { signal: sig }, transport);
  const arr = Array.isArray(j) ? j : [];
  if (!arr.length) return '';
  return arr.slice(0,3).map((r)=>{
    const s = r.show || r;
    return fmt('TVMAZE', s.name || q.slice(0,40), s.url || `https://api.tvmaze.com/shows/${s.id || ''}`, stripTags(s.summary || '').slice(0,220));
  }).join('');
}

// ── smartSlice + caps — exported ──
export function smartSlice(blocks, query, budget = 12000) {
  const markdown = Array.isArray(blocks) ? blocks.join('') : String(blocks || '');
  if (!markdown) return '';
  if (markdown.length <= budget) return markdown;
  const rawBlocks = markdown.split(/(?=### \[)/).filter(Boolean);
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const scored = rawBlocks.map((b,i)=>{
    const lower = b.toLowerCase();
    let score = 0;
    for (const t of terms) if (lower.includes(t)) score++;
    // small length penalty to prefer concise hits when tied
    return { b, i, score, len: b.length };
  });
  scored.sort((a,b)=> b.score - a.score || a.i - b.i);
  let total = 0;
  const picked = [];
  for (const s of scored) {
    if (total + s.len <= budget) { picked.push(s); total += s.len; }
  }
  // if nothing fits (single huge block), truncate first block
  if (!picked.length && scored.length) {
    return scored[0].b.slice(0, budget);
  }
  picked.sort((a,b)=> a.i - b.i);
  const out = picked.map((p)=>p.b).join('');
  return out.length > budget ? out.slice(0, budget) : out;
}

export function applyWikiCaps(blocks) {
  const markdown = Array.isArray(blocks) ? blocks.join('') : String(blocks || '');
  if (!markdown) return '';
  const raw = markdown.split(/(?=### \[)/).filter(Boolean);
  const counts = { WIKIPEDIA:0, WIKIDATA:0, 'WIKIDATA SPARQL':0 };
  const out = [];
  for (const b of raw) {
    const m = b.match(/^### \[([^\]]+)\]/);
    const tag = m ? m[1] : '';
    if (tag === 'WIKIPEDIA') {
      if (counts.WIKIPEDIA >= 2) continue;
      counts.WIKIPEDIA++;
    } else if (tag === 'WIKIDATA') {
      if (counts.WIKIDATA >= 2) continue;
      counts.WIKIDATA++;
    } else if (tag === 'WIKIDATA SPARQL') {
      if (counts['WIKIDATA SPARQL'] >= 2) continue;
      counts['WIKIDATA SPARQL']++;
    }
    // DBPEDIA and others uncapped
    out.push(b);
  }
  return out.join('');
}

/** Keys read from settings each call so modal edits apply immediately. Kept for BYO but not used in 13-keyless default. */
function keys() {
  try { return JSON.parse(localStorage['asm.settings'] || '{}'); } catch { return {}; }
}

// Map timed job name -> display TAG for markdown grouping and UI header
const TAG = {
  wikipedia: 'WIKIPEDIA',
  hn: 'HACKER NEWS',
  stackexchange: 'STACK OVERFLOW',
  github: 'GITHUB',
  wikidata: 'WIKIDATA',
  openalex: 'OPENALEX',
  crossref: 'CROSSREF',
  semanticscholar: 'SEMANTIC SCHOLAR',
  doaj: 'DOAJ',
  openlibrary: 'OPEN LIBRARY',
  dbpedia: 'DBPEDIA',
  lobsters: 'LOBSTE.RS',
  espn: 'ESPN',
  mlb: 'MLB',
  coingecko: 'COINGECKO',
  frankfurter: 'FRANKFURTER',
  openmeteo: 'OPEN-METEO',
  worldbank: 'WORLD BANK',
  endoflife: 'END OF LIFE',
  cep: 'CURRENT EVENTS',
  wdqs: 'WIKIDATA SPARQL',
  jinaweb: 'JINA WEB',
  jinanews: 'JINA NEWS',
  dictionary: 'DICTIONARY',
  tvmaze: 'TVMAZE',
};

/** Shipping Source names — the Fan-out's job names. The Sweep validates its canned corpus keys against this list. */
export const SOURCE_NAMES = Object.keys(TAG);

/** query -> { markdown, sources, failures, perSource }. `transport` replaces
 *  the platform fetch per call (the Sweep's corpus-backed transport rides
 *  this seam); Sources never reach for globals themselves. */
export async function webSearch(query, { transport = fetch } = {}) {
  const failures = [];
  const withMs = (name, fn) => (async () => {
    const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const block = await timed(name, fn, failures);
    const end = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const ms = Math.round(end - start);
    const tag = TAG[name] || name.toUpperCase();
    const hits = block ? (block.match(/^### \[/gm) || []).length : 0;
    return { name, tag, block: block || '', ms, hits };
  })();

  // shared memoized geocode per Turn
  const geoMemo = new Map();
  async function getGeo(place, sig) {
    const key = place.toLowerCase();
    if (geoMemo.has(key)) return geoMemo.get(key);
    const p = (async () => {
      const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`;
      const j = await jfetch(u, { signal: sig }, transport);
      return j?.results?.[0] || null;
    })();
    geoMemo.set(key, p);
    p.catch(()=> geoMemo.delete(key));
    return p;
  }

  const jobs = [
    withMs('wikipedia', (sig) => wikipedia(query, sig, transport)),
    withMs('hn', (sig) => hackernews(query, sig, transport)),
    withMs('stackexchange', (sig) => stackexchange(query, sig, transport)),
    withMs('github', (sig) => github(query, sig, transport)),
    withMs('wikidata', (sig) => wikidata(query, sig, transport)),
    withMs('openalex', (sig) => openalex(query, sig, transport)),
    withMs('crossref', (sig) => crossref(query, sig, transport)),
    withMs('semanticscholar', (sig) => semanticscholar(query, sig, transport)),
    withMs('doaj', (sig) => doaj(query, sig, transport)),
    withMs('openlibrary', (sig) => openlibrary(query, sig, transport)),
    withMs('dbpedia', (sig) => dbpedia(query, sig, transport)),
    withMs('lobsters', (sig) => lobsters(query, sig, transport)),
    withMs('espn', (sig) => espn(query, sig, transport)),
    withMs('mlb', (sig) => mlbSource(query, sig, transport)),
    withMs('coingecko', (sig) => coingeckoSource(query, sig, transport)),
    withMs('frankfurter', (sig) => frankfurterSource(query, sig, transport)),
    withMs('openmeteo', (sig) => openmeteoSource(query, sig, transport, getGeo)),
    withMs('worldbank', (sig) => worldbankSource(query, sig, transport, getGeo)),
    withMs('endoflife', (sig) => endoflifeSource(query, sig, transport)),
    withMs('cep', (sig) => cepSource(query, sig, transport)),
    withMs('wdqs', (sig) => wdqsSource(query, sig, transport)),
    withMs('jinaweb', (sig) => jinawebSource(query, sig, transport, jinaLimiter)),
    withMs('jinanews', (sig) => jinanewsSource(query, sig, transport, jinaLimiter)),
    withMs('dictionary', (sig) => dictionarySource(query, sig, transport)),
    withMs('tvmaze', (sig) => tvmazeSource(query, sig, transport)),
  ];
  const settled = await Promise.allSettled(jobs);
  const metas = settled.map((r) => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean);
  // per-block dedup preserving Source weight order
  const seen = new Set();
  const dedupedBlocks = [];
  const perSource = [];
  for (const m of metas) {
    if (!m.block) continue;
    const blocks = m.block.split(/(?=### \[)/).filter(Boolean);
    const kept = [];
    for (const b of blocks) {
      const url = (b.match(/^https?:\S+/m) || [''])[0];
      const n = url ? norm(url) : '';
      if (n && seen.has(n)) continue;
      if (n) seen.add(n);
      // for url-less blocks, avoid exact dup
      if (!n && dedupedBlocks.includes(b)) continue;
      kept.push(b);
      dedupedBlocks.push(b);
    }
    if (kept.length) perSource.push({ tag: m.tag, hits: kept.length, ms: m.ms });
    // if all blocks duped, no perSource entry (already accounted)
  }

  let markdown = dedupedBlocks.join('');
  markdown = applyWikiCaps(markdown);
  markdown = smartSlice(markdown, query, 12000);

  const sources = perSource.length;
  return { markdown, sources, failures, perSource };
}

// debug hook
if (typeof window !== 'undefined') {
  window.__asm = window.__asm || {};
  window.__asm.search = webSearch;
}
