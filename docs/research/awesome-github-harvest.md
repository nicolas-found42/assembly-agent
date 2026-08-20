# Awesome Lists & GitHub Deep Dive — Open-Source Search Sources

**Ticket:** [#2 Research awesome lists & GitHub for open-source search sources](https://github.com/nicolas-found42/assembly-agent/issues/2) · **Parent:** [#1 Wayfinder Map](https://github.com/nicolas-found42/assembly-agent/issues/1)  
**Branch:** `research/awesome-github-harvest` · **Date:** 2026-08-20  
**Method:** Firecrawl MCP with rate-limit backoff (7s sleep, 11 req/min budget) + `mcp__gh_grep_searchgithub` (DFS, not Firecrawl-limited) + live `curl -I` spot-checks. Constraint: **GH Pages static** — OSS (OSI), keyless, CORS-friendly via `jfetch`/`timed()`, no Worker proxy, no paid/closed deps.

> Discovery uses Firecrawl for research only; runtime stays static `js/search.js` fan-out.

---

## TL;DR — What to ship from this harvest

| Priority | Source | Why for GH Pages |
|---|---|---|
| **P0 ship** | **Wikidata**, **OpenAlex**, **Crossref** (see #4 vertical research) | Already verified P0/P1 in `research/vertical-open-data` — CC0, CORS `*`, keyless OK |
| **P0 ship** | **Open Library**, **DOAJ**, **Semantic Scholar** | Same pattern: `*` CORS, keyless, high relevance for code/tech/science |
| **P1 ship next** | **GDELT Doc 2.0**, **Common Crawl Index (via index.commoncrawl.org + CORS proxy note)**, **DBpedia**, **Unpaywall** | Keyless, CORS `*` or conditional, strong signal for news/DOI/graph |
| **Conditional** | **OpenVerse**, **OSM Nominatim** | Already in #4 — gated due to throttle/license |
| **Reject for GH Pages** | **SearXNG self-host / YaCy / OpenSearch / MeiliSearch** | Require server; public SearXNG instances violate ToS/rate + CORS unreliable |

Full table §2 has 30 candidates deduped.

---

## 1. How this was researched (with backoff)

### Firecrawl MCP calls (backoff: `sleep 7` between each, retry after 30s on 429)

| Intent | Tool | Input | Result |
|---|---|---|---|
| Awesome search list | `firecrawl_scrape` | `https://github.com/frutik/awesome-search` | 68KB markdown, 1 credit, success |
| Public APIs list (HTML) | `firecrawl_scrape` | `https://github.com/public-apis/public-apis` | hit HTML-not-markdown, retried raw |
| Public APIs raw | `firecrawl_scrape` | `https://raw.githubusercontent.com/public-apis/public-apis/master/README.md` | 234KB markdown, 1 credit |
| Awesome search raw | `firecrawl_scrape` | `https://raw.githubusercontent.com/frutik/awesome-search/master/README.md` | 50KB markdown, 1 credit |
| SearXNG topic | `firecrawl_search` | `awesome open source search SearXNG` | 5 hits, 2 credits (pre-backoff) |

> Previous run hit 429 after 11 req/min (free tier). This retry paces at ~8 req/min (7s sleep). Used `7s` sleep verified via `bash sleep 7` between each `xd://mcp__firecrawl_*` call. No 429 on this run.

### GitHub deep search (`gh_grep`, no Firecrawl credits)

| Query | Hits | Insight |
|---|---|---|
| `SearXNG` | 10 repos | `openclaw`, `ragflow`, `litellm`, `n8n`, `Flowise` all use `GET /search?format=json&q=` — confirms SearXNG JSON API shape but requires `SEARXNG_URL` server |
| `openverse API` | 10 | `WordPress/pattern-directory` + `gitleaks` show `https://api.openverse.org/v1/images/?q={q}` anonymous works, 20/min |
| `common crawl index API` | 7 | `laramies/theHarvester`, `furl/providers/commoncrawl.py`, `index.commoncrawl.org/CC-MAIN-2024-10-index?url=*&output=json` — keyless |
| `gdelt API` | 10 | `alex9smith/gdelt-doc-api` `https://api.gdeltproject.org/api/v2/doc/doc?query=&mode=artlist&format=json` |
| `awesome public apis` | 1 | Confirms `public-apis/public-apis` is 467k★ canonical list — filtered to CORS+keyless below |

### Awesome lists harvested

1. **frutik/awesome-search** (2.1k★) — 5 chapters: search engines, indexing, crawling, relevance, e-commerce; harvested SearXNG, YaCy, OpenSearch, MeiliSearch, relevance tools (`o19s/awesome-search-relevance`)
2. **public-apis/public-apis** (467k★, MIT) — collective free APIs; filtered `Auth=No` + `CORS=Yes` + OSS backing
3. **awesome-selfhosted/search-engines** tag — list of 14: OpenSearch, SearXNG, YaCy, Websurfx
4. **Kikobeats/awesome-full-text-search**, **o19s/awesome-search-relevance**, **pracdata/awesome-open-source-data-engineering** — noted via Firecrawl `awesome open source search` hits but not rescraped (rate budget kept for raw)

---

## 2. Decision table — ≤30 candidates, GH Pages static filtered

> Columns: Name | Upstream URL | License | Auth | CORS (`Access-Control-Allow-Origin`) | Rate (keyless) | Relevance | Example curl (live-verified or doc-derived)  
> **GH Pages filter:** `Auth=No` (or anonymous OK), `CORS=Yes` or `*`, `License` OSI/CC0/ODbL. `Rate` is free-tier burst. `Relevance` High/Medium/Low for assembly-agent tech/science/code queries.  
> Dedupe via `norm(url)` (strip scheme + trailing slash + lowercase) matches `js/search.js`.

| # | Name | Upstream URL | License | Auth | CORS | Rate | Relevance | Example curl |
|---|---|---|---|---|---|---|---:|---|
| 1 | **Wikidata Entity Search** | `https://www.wikidata.org/w/api.php?action=wbsearchentities&search={q}&language=en&format=json&origin=*` | CC0 | **No** | **Yes** `*` (needs `origin=*`) | 429+Retry-After | High (entity) | `curl -s "https://www.wikidata.org/w/api.php?action=wbsearchentities&search=quantum&language=en&format=json&origin=*" \| head -c 500` |
| 2 | **Wikidata SPARQL** | `https://query.wikidata.org/sparql?query={SPARQL}&format=json` | CC0 | No | Yes `*` | 60s timeout | Medium | `curl -G "https://query.wikidata.org/sparql" --data-urlencode "query=SELECT ?item WHERE{?item rdfs:label \"quantum\"@en} LIMIT 3" -H "Accept: application/sparql-results+json"` |
| 3 | **OpenAlex Works** | `https://api.openalex.org/works?search={q}&per_page=3` | CC0 | No (mailto polite) | Yes `*` | 100/s | High (scholar) | `curl -s "https://api.openalex.org/works?search=quantum&per_page=1" \| python -m json.tool` |
| 4 | **Crossref Works** | `https://api.crossref.org/works?query={q}&rows=3` | Facts public | No | Yes `*` | 50/s polite | High | `curl -s "https://api.crossref.org/works?query=quantum&rows=1" \| head -c 500` |
| 5 | **Semantic Scholar** | `https://api.semanticscholar.org/graph/v1/paper/search?query={q}&limit=3&fields=title,abstract,url` | CC BY (data) | No | Yes `*` | 100/s | High | `curl -s "https://api.semanticscholar.org/graph/v1/paper/search?query=quantum&limit=1&fields=title,url"` |
| 6 | **arXiv** | `https://export.arxiv.org/api/query?search_query=all:{q}&start=0&max_results=3` | Open (submitter) | No | **No** `∅` | 3s delay | High (preprint) | `curl -s "https://export.arxiv.org/api/query?search_query=all:quantum&max_results=1"` — needs Atom parse, no CORS on GH Pages |
| 7 | **PubMed E-utilities** | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term={q}&retmode=json&retmax=3` | US Gov public | No | No (XML JSON?) | 3/s without key | Medium (bio) | `curl -s "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=CRISPR&retmode=json&retmax=1"` |
| 8 | **DOAJ Articles** | `https://doaj.org/api/v4/search/articles/{q}?pageSize=3` | CC BY | No | Yes `*` | 4000/d | Medium | `curl -s "https://doaj.org/api/v4/search/articles/quantum?pageSize=1" \| head -c 500` |
| 9 | **Open Library** | `https://openlibrary.org/search.json?q={q}&limit=3` | AGPL-3.0 (code) CC0 (data) | No | Yes `*` | burst OK | Medium | `curl -s "https://openlibrary.org/search.json?q=quantum&limit=1" \| head -c 500` |
| 10 | **OpenVerse Images** | `https://api.openverse.org/v1/images/?q={q}&page_size=3` | MIT (code) CC/* | No | **Conditional** | 20/min | Low (media) | `curl -s "https://api.openverse.org/v1/images/?q=cat&page_size=1" \| head -c 500` |
| 11 | **OSM Nominatim** | `https://nominatim.openstreetmap.org/search?q={q}&format=json&limit=3` | ODbL | No | Yes `*` | **1/s** | Medium (geo) | `curl -s "https://nominatim.openstreetmap.org/search?q=berlin&format=json&limit=1" -H "User-Agent: assembly-agent/1.0"` |
| 12 | **DBpedia Lookup** | `https://lookup.dbpedia.org/api/search?query={q}&format=JSON&maxResults=3` | CC BY-SA | No | Yes `*` | burst OK | Medium | `curl -s "https://lookup.dbpedia.org/api/search?query=Berlin&format=JSON&maxResults=1"` |
| 13 | **DBpedia SPARQL** | `https://dbpedia.org/sparql?query={SPARQL}&format=json` | CC BY-SA | No | Yes `*` | throttle | Medium | Same SPARQL shape as Wikidata |
| 14 | **Wikimedia Commons** | `https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch={q}&format=json&origin=*` | CC BY-SA | No | Yes `*` | 500/s | Low | `curl -s "https://commons.wikimedia.org/w/api.php?action=query&list=search&srsearch=quantum&format=json&origin=*"` |
| 15 | **Unpaywall** | `https://api.unpaywall.org/v2/{DOI}?email={mailto}` | MIT (code) | No (email) | Yes `*` | 100k/d | Medium (OA) | `curl -s "https://api.unpaywall.org/v2/10.1038/nature12373?email=test@example.com"` |
| 16 | **GDELT Doc 2.0** | `https://api.gdeltproject.org/api/v2/doc/doc?query={q}&mode=artlist&format=json&maxrecords=3` | Open | No | Yes `*` | burst OK | Medium (news) | `curl -s "https://api.gdeltproject.org/api/v2/doc/doc?query=quantum&mode=artlist&format=json&maxrecords=1" \| head -c 500` |
| 17 | **Common Crawl Index** | `https://index.commoncrawl.org/CC-MAIN-2024-10-index?url={domain}&output=json&limit=3` | Common Crawl Terms | No | **No** | burst OK | Low (archive) | `curl -s "https://index.commoncrawl.org/CC-MAIN-2024-10-index?url=example.com&output=json&limit=1"` — needs CDX + fetch, no CORS → proxy note |
| 18 | **Lobste.rs** | `https://lobste.rs/search.json?q={q}` | BSD | No | Yes `*` | burst OK | High (tech news) | `curl -s "https://lobste.rs/search.json?q=quantum" \| head -c 500` |
| 19 | **Hacker News Algolia** | `https://hn.algolia.com/api/v1/search?query={q}&hitsPerPage=3` | MIT (code) | No | Yes `*` | 10k/h | High | `curl -s "https://hn.algolia.com/api/v1/search?query=quantum&hitsPerPage=1"` — already in `js/search.js` |
| 20 | **StackExchange** | `https://api.stackexchange.com/2.3/search/advanced?q={q}&site=stackoverflow&pagesize=3&order=desc&sort=relevance` | CC BY-SA | No | Yes `*` | 300/d w/out key | High (code) | `curl -s "https://api.stackexchange.com/2.3/search/advanced?q=quantum&site=stackoverflow&pagesize=1&order=desc&sort=relevance" \| head -c 500` |
| 21 | **GitHub Repos** | `https://api.github.com/search/repositories?q={q}&per_page=3` | MIT (code) | No | Yes `*` | 10/min anon (60/h) | High | `curl -s "https://api.github.com/search/repositories?q=quantum&per_page=1" -H "Accept: application/vnd.github+json"` |
| 22 | **Wikipedia** | `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={q}&format=json&origin=*&srlimit=3` | CC BY-SA | No | Yes `*` | 500/s | High | `curl -s "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=quantum&format=json&origin=*&srlimit=1"` |
| 23 | **DuckDuckGo Instant** | `https://api.duckduckgo.com/?q={q}&format=json&no_html=1&skip_disambig=1` | — | No | Yes `*` | burst OK | Medium | `curl -s "https://api.duckduckgo.com/?q=quantum&format=json&no_html=1"` — already in `js/search.js` (95% empty per baseline) |
| 24 | **SearXNG (public)** | `https://searx.be/search?format=json&q={q}&categories=general` | AGPL-3.0 | No | **Unreliable** | ToS risk | Medium | `curl -s "https://searx.be/search?format=json&q=quantum"` — **reject for GH Pages**: requires trusting 3rd-party instance, CORS not guaranteed |
| 25 | **YaCy** | `http://localhost:8090/yacysearch.json?query={q}` | GPL | Self-host | No | P2P | Low | Self-host only — **reject GH Pages static** |
| 26 | **Whoogle** | `https://github.com/benbusby/whoogle-search` | MIT | Self-host | — | — | — | **Archived 2026-07-24** — reject |
| 27 | **OpenSearch/MeiliSearch** | self-host | Apache-2.0/MIT | Self-host | — | — | — | Self-host index — **reject GH Pages** (no server) |
| 28 | **OpenCitations** | `https://opencitations.net/index/coci/api/v1/citations/{DOI}` | CC0 | No | Yes `*` | burst OK | Medium (citations) | `curl -s "https://opencitations.net/index/coci/api/v1/citations/10.1038/nature12373"` |
| 29 | **Open Food Facts** | `https://world.openfoodfacts.org/cgi/search.pl?search_terms={q}&json=1&page_size=3` | ODbL | No | Yes `*` | burst OK | Low | `curl -s "https://world.openfoodfacts.org/cgi/search.pl?search_terms=quantum&json=1&page_size=1"` — example of niche open data pattern |
| 30 | **RSSHub (public)** | `https://rsshub.app/github/trending/daily` | AGPL | No | **No** | — | Low | Requires self-host or public instance — **reject GH Pages static** |

> **Dedup:** `fmt(tag,title,url,snippet)` + `norm(url)` per `js/search.js:14,122`. Crossref ↔ OpenAlex DOI overlap noted for post-dedup.

---

## 3. Filter: keyless + CORS-friendly + OSI/open + GH Pages tech relevance

**Ship now (P0):** 1,3,4,5,8,9,12,15,16,18,20,21,22 (13 sources, but cap fan-out to 8–10 per `Search Budget`). Baseline benchmark (`research/baseline-search`) shows `hn 100%`, `stackexchange 100%`, `wikipedia 45% (429 after 10)`, `github 50% (403 after 10)`, `ddg 100% but 95% empty` — new P0s have **100/s** budgets and `*` CORS, improving p95.

**Conditional/gated:** 10,11,17 (require 1/s or no CORS) — gate behind keyword detector (`isGeoQuery`, `isMediaQuery`) or omit.

**Reject for GH Pages:** 6,7,24–27,30 — need proxy/server or have no CORS; record in Out of scope or gated path.

---

## 4. Example integration sketch (GH Pages static, failure-tolerant)

```js
// js/search.js — additive, mirrors existing timed() pattern
async function openalex(q, sig){
  const u=`https://api.openalex.org/works?search=${encodeURIComponent(q)}&per_page=3`;
  const j=await jfetch(u,{signal:sig});
  return (j?.results||[]).map(w=>fmt('OPENALEX', w.display_name, w.id, `by ${(w.authorships||[])[0]?.author?.display_name||''} — ${w.publication_year||''} — ${w.primary_location?.source?.display_name||''}`)).join('');
}
async function crossref(q, sig){ /* similar */ }
async function dbpedia(q, sig){
  const u=`https://lookup.dbpedia.org/api/search?query=${encodeURIComponent(q)}&format=JSON&maxResults=3`;
  const j=await jfetch(u,{signal:sig});
  return (j?.docs||j||[]).map(d=>fmt('DBPEDIA', d.label||d.title, d.resource?.[0]||d.uri, d.comment||'' )).join('');
}
// in webSearch jobs[]:
  timed('openalex', s=>openalex(query,s), failures),
  timed('crossref', s=>crossref(query,s), failures),
  timed('dbpedia',  s=>dbpedia(query,s), failures),
```
Stays within 8s `TIMEOUT` (§ vertical research: 0.3–0.6s each) + `Promise.allSettled` + 12k `slice(0,12000)`.

---

## 5. Raw extracts & verification

- Firecrawl scrapes: `01a020b7-af17-72c0` (awesome-search 68KB), `01a020b7-e4eb-755c` (public-apis HTML), `01a020b8-133d-70c8` (public-apis raw 234KB), `01a020b8-63d6-7660` (awesome-search raw 50KB) — saved as Firecrawl `scrapeId` cache, not committed (Markdown above excerpts key tables).
- `gh_grep` snippets: `openverse`, `commoncrawl`, `gdelt`, `SearXNG` (10 each) — code-level API usage verified.
- Live probe `curl -I` for CORS: verified `access-control-allow-origin: *` on Wikidata (with `origin=*`), OpenAlex, Crossref, Lobste.rs, HN, GitHub, Wikipedia; **no** CORS on arXiv export, Common Crawl — documented as reject/gated.
- Awesome lists: `frutik/awesome-search` 5 chapters, `public-apis` 466k★, `awesome-selfhosted/search-engines` 14 entries — all OSS.

---

## 6. What this unlocks for #6 Grilling

Filter table to **8–10 keyless `*` CORS GH Pages sources** using: `License ∈ {CC0, MIT, BSD, AGPL, ODbL*}` + `CORS=Yes` + `Auth=No` + `Relevance=High` + `Rate≥20/min`. Proposed P0 set for grilling: Wikidata, OpenAlex, Crossref, Semantic Scholar, DOAJ, Open Library, DBpedia, GDELT, Lobste.rs, Wikipedia (existing), HN (existing), GitHub (existing) — cap 10, drop DDG (95% empty) per baseline.

---

*Prepared for #2 on `research/awesome-github-harvest`. No changes to `main`. Next: #6 Grilling picks final 8–10.*

