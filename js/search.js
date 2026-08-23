// search.js — parallel fan-out meta-search (keyless-first, spread load).
// Every source is failure-tolerant: a failure simply omits that block.
// ADR 0004: 12 keyless Sources (4 existing + 8 P0: GDELT dropped — 17s timeout breaks 8s SLO), DDG + keyed dropped, grouped by Source weight, dedup norm(url), 12k slice, retry once on Timeout/429.

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

async function stackexchange(q, sig, transport) {
  const u = `https://api.stackexchange.com/2.3/search/advanced?q=${encodeURIComponent(q)}&site=stackoverflow&pagesize=4&order=desc&sort=relevance`;
  const j = await jfetch(u, { signal: sig }, transport);
  return (j?.items || []).map((i) =>
    fmt('STACK OVERFLOW', i.title, i.link, `score ${i.score} · ${i.is_answered ? 'answered' : 'unanswered'}`)).join('');
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
  // lookup returns docs array where each has resource, label, comment
  const arr = Array.isArray(docs) ? docs : [];
  return arr.map((d) => {
    const res = Array.isArray(d.resource) ? d.resource[0] : d.resource || d.uri || '';
    const label = d.label || d.title || q;
    const comment = stripTags(d.comment || d.description || '').slice(0, 220);
    return fmt('DBPEDIA', label, res, comment);
  }).join('');
}



async function lobsters(q, sig, transport) {
  // lobste.rs has no CORS-friendly search.json; use hottest.json filtered client-side
  const j = await jfetch('https://lobste.rs/hottest.json', { signal: sig }, transport);
  const all = Array.isArray(j) ? j : [];
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = all.filter((s) => {
    const hay = `${s.title || ''} ${s.tags ? s.tags.join(' ') : ''} ${s.url || ''}`.toLowerCase();
    return terms.some((t) => hay.includes(t));
  }).slice(0, 3);
  // fallback to unfiltered if no match (still show something)
  const out = filtered.length ? filtered : all.slice(0, 2);
  return out.map((s) =>
    fmt('LOBSTE.RS', s.title || q, s.short_id_url || s.url || `https://lobste.rs/s/${s.short_id}`, `${s.score ?? 0} points · ${s.comment_count ?? 0} comments · tags ${ (s.tags || []).join(', ')}`)).join('');
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
};

/** Shipping Source names — the Fan-out's job names. The Sweep validates its canned corpus keys against this list. */
export const SOURCE_NAMES = Object.keys(TAG);

/** query -> { markdown, sources, failures, perSource }. `transport` replaces
 *  the platform fetch per call (the Sweep's corpus-backed transport rides
 *  this seam); Sources never reach for globals themselves. */
export async function webSearch(query, { transport = fetch } = {}) {
  const failures = [];
  // helper to wrap timed with ms capture and tag
  const withMs = (name, fn) => (async () => {
    const start = performance.now();
    const block = await timed(name, fn, failures);
    const ms = Math.round(performance.now() - start);
    const tag = TAG[name] || name.toUpperCase();
    const hits = block ? (block.match(/^### \[/gm) || []).length : 0;
    return { name, tag, block: block || '', ms, hits };
  })();

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
  ];
  const settled = await Promise.allSettled(jobs);
  const metas = settled.map((r) => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean);
  // Keep only sources that produced a block
  const okMetas = metas.filter((m) => m.block);

  // dedupe blocks by normalized URL line (first-win, grouped by Source weight)
  // Per-block dedup preserves ADR 0004 grouped ranking; also track per-source hit adjustment for UI?
  const seen = new Set();
  const deduped = [];
  const perSource = [];
  for (const m of okMetas) {
    const url = (m.block.match(/^https?:\S+/m) || [''])[0];
    if (url) {
      const n = norm(url);
      if (seen.has(n)) continue;
      seen.add(n);
    }
    deduped.push(m.block);
    perSource.push({ tag: m.tag, hits: m.hits, ms: m.ms });
  }

  const markdown = deduped.join('').slice(0, 12000);
  // sources = number of source groups that contributed (deduped), failures = timed misses
  return { markdown, sources: deduped.length, failures, perSource };
}

// debug hook
window.__asm = window.__asm || {};
window.__asm.search = webSearch;
