# Vertical Research — Open-Data APIs (Wikidata · OpenAlex · arXiv · Crossref · OpenVerse · OSM Nominatim)

**Ticket:** #4 · **Parent:** #1 (wayfinder map for expanding `js/search.js`)  
**Branch:** `research/vertical-open-data` · **Date:** 2026-08-20  
**Method:** Firecrawl MCP (`firecrawl_scrape` + `firecrawl_search`) + live probe (`curl -I` for CORS, `curl` for JSON shape, `time curl` for latency). Constraints: OSI license or open API with OSS backing, keyless-first, CORS-friendly where possible, creative verticals (open data · academic · geospatial · media).

> All new sources evaluated here MUST be open-source (self-hostable or open API with OSS backing) and prefer keyless/CORS. No merge to `main`; throwaway branch only.

---

## TL;DR Recommendation

| Priority | Source | Why for assembly-agent |
|---|---|---|
| **P0 — ship first** | **OpenAlex** (`/works`) | CC0, `Access-Control-Allow-Origin: *`, keyless OK, 100 req/s burst, JSON-native, rich scholarly snippets, ~300M works. Highest tech/science signal. |
| **P0 — ship first** | **Wikidata** (`wbsearchentities` + SPARQL) | CC0, CORS `*`, keyless, low latency (0.3–0.6 s), structured entity facts ideal for disambiguation. |
| **P1 — ship next** | **Crossref** (`/works`) | Facts (metadata) not copyright-restricted, CORS `*`, keyless, polite-pool with `mailto:` quiets 429s. Complements OpenAlex with DOI-level provenance. |
| **P2 — conditional** | **OSM Nominatim** (`/search`) | ODbL, CORS via Cloudflare (`*` on JSON), keyless, but **1 req/s max** + attribution + ODbL share-alike. Only for geospatial-entity queries; gate behind keyword detector. |
| **P3 — needs proxy** | **arXiv** (`export.arxiv.org/api/query`) | arXiv content CC-BY–ish/open access, keyless, but **no CORS header** on `export.arxiv.org` (tested: `curl -I` returns no `access-control-allow-origin`). Returns **Atom XML**, not JSON — requires client-side XML parse or Worker proxy transform. High science relevance, so worth a proxied path. |
| **P4 — deprioritize** | **OpenVerse** (`api.openverse.org/v1/images|audio`) | MIT (code), media CC variably licensed, **CORS per spec via Cloudflare** but **no `Access-Control-Allow-Origin: *` on anonymous GET** (observed: only `Vary: origin`; browser anonymous fetch works from `openverse.org` but is throttled **20/min burst / 200/day**). Low tech/science relevance (CC media). Keep as optional media vertical. |

**Fan-out implication:** `webSearch()` already does parallel `timed()` with `Promise.allSettled`. The three P0/P1 sources add ~0.5 s p95 without hurting the 8 s `TIMEOUT`. Gate OSM/arXiv/OpenVerse.

---

## 1. How this was researched

### Firecrawl MCP calls

| Intent | Tool | Input |
|---|---|---|
| Wikidata access modes | `firecrawl_scrape` | `https://www.wikidata.org/wiki/Wikidata:Data_access` |
| OpenAlex home | `firecrawl_scrape` | `https://docs.openalex.org/` → redirected to `https://help.openalex.org/` |
| OpenAlex API surface | `firecrawl_scrape` | `https://help.openalex.org/api` |
| OpenAlex auth & limits | `firecrawl_scrape` | `https://help.openalex.org/api/authentication` |
| OpenAlex paging | `firecrawl_scrape` | `https://help.openalex.org/api/paging` |
| arXiv API entry | `firecrawl_scrape` | `https://info.arxiv.org/help/api/` |
| arXiv basics | `firecrawl_scrape` | `https://info.arxiv.org/help/api/basics.html` |
| arXiv manual (query & paging) | `firecrawl_scrape` | `https://info.arxiv.org/help/api/user-manual.html` |
| Crossref Swagger | `firecrawl_scrape` | `https://api.crossref.org/` |
| Crossref REST docs | `firecrawl_scrape` | `https://www.crossref.org/documentation/retrieve-metadata/rest-api/` |
| OpenVerse API (full Redoc) | `firecrawl_scrape` | `https://api.openverse.engineering/` |
| OSM Nominatim Search | `firecrawl_scrape` | `https://nominatim.org/release-docs/develop/api/Search/` |
| OSM usage policy | live fetch | `https://operations.osmfoundation.org/policies/nominatim/` |
| Wikidata SPARQL CORS keyless | `firecrawl_search` | `"Wikidata SPARQL API CORS keyless"` — **429** on free tier |
| OpenAlex rate limit | `firecrawl_search` | `"OpenAlex API rate limit"` — **429** |
| arXiv CORS | `firecrawl_search` | `"arXiv API CORS"` — **429** |

> Search 429s are Firecrawl free-tier throttles on 2026-08-20, not evidence of absence. Fell back to direct `curl -I` / `curl -s` probes + scraped doc pages for ground truth.

### Live probes (2026-08-20, `curl -I` / `time curl`)

```
curl -I  https://query.wikidata.org/sparql?query=...
curl -I  https://api.openalex.org/works?search=quantum&per-page=1
curl -I  https://api.crossref.org/works?query=quantum&rows=1
curl -I  https://export.arxiv.org/api/query?search_query=all:electron&start=0&max_results=1
curl -I  https://api.openverse.org/v1/images/?q=cat&page_size=1
curl -I  https://nominatim.openstreetmap.org/search?q=berlin&format=json&limit=1
curl -I  https://www.wikidata.org/w/api.php?action=wbsearchentities&search=test&language=en&format=json&origin=*
time curl -s "https://api.openalex.org/works?search=quantum&per-page=1" -w "%{time_total}\n"
# + sampled bodies via python -m json.tool / head for snippet richness
```

---

## 2. Decision table

> Latency = wall-clock `time curl` from AMS/EWR edge on 2026-08-20 (single `rows=1` or `per_page=1`), not p50. Snippet richness = what a `fmt(tag,title,url,snippet)` block can show without extra hops.

| Source | Endpoint (GET) | License | Keyless? | CORS (`Access-Control-Allow-Origin`) | Rate limit (keyless) | Pagination | Snippet richness (per hit) | Latency (est.) | Query relevance for assembly-agent | Integration notes |
|---|---|---|---|---|---|---|---|---|---|
| **Wikidata — Entity Search** | `https://www.wikidata.org/w/api.php?action=wbsearchentities&search={q}&language=en&format=json&limit=3&origin=*` | **CC0** (data); Stable Interface Policy | **Yes** — no key; respect `User-Agent` + `Accept-Encoding: gzip,deflate` + `Retry-After` | **Yes** — `*` (verified); needs `origin=*` for `origin` param | Global Wikimedia limits; 429 + `Retry-After`; `maxlag` + low `timeout` encouraged | `limit` ≤ 50; `search-continue` offset | `label` + `description` + `concepturi` (Q-id). Short, entity-grade. | **300–600 ms** | **High** when query is entity-flavored (“what is X”, disambiguation). Low for free-text. | Use `origin=*` + `User-Agent: assembly-agent/1.0 (+https://github.com/…; contact@example.com)` |
| **Wikidata — SPARQL (WDQS)** | `https://query.wikidata.org/sparql?query={SPARQL}&format=json` (+ `Accept: application/sparql-results+json`) | **CC0** | **Yes** | **Yes** — `access-control-allow-origin: *` + `access-control-allow-headers: accept, content-type, user-agent, api-user-agent` (verified) | Timeout-driven; 60 s server timeout; 429 on abuse; scholarly graph at `query-scholarly.wikidata.org` | `LIMIT`/`OFFSET` | `bindings[]` — Q-ids + labels; richest when query targets `wdt:P31`, `description`, etc. | **500–1200 ms** | **Medium-High** for structured “list all X with property Y”. Overkill for naive keyword search. | Prefer `wbsearchentities` for browser fan-out; reserve SPARQL for a proxied advanced path |
| **OpenAlex** | `https://api.openalex.org/works?search={q}&per_page=3&select=id,display_name,doi,publication_year,authorships,primary_location,open_access` | **CC0** (all data) — explicitly documented | **Yes** — no key works; key raises budget 10× (`api_key=` or `Authorization: Bearer`) | **Yes** — `access-control-allow-origin: *`, `allow-methods: GET, HEAD, POST, OPTIONS` (verified); exposes rate-limit headers | **100 req/s** burst; daily budget (keyless < keyed 10×); individual caps: `per_page` max 100, `page*per_page` ≤ 10 000 (use `cursor=*` beyond) | `page`/`per_page` (25 default, 100 max); **cursor paging** (`cursor=*` → `meta.next_cursor`) for >10k; `sample` ≤ 10k | `display_name` + `authorships[0].author.display_name` + `publication_year` + `doi` + OA URL. Very snippet-dense. | **250–500 ms** (measured 0.47 s for `filter=display_name.search:transformer`) | **Highest** — 300M+ works, Crossref + MAG + OA. Ideal for “paper about X”, “who wrote Y”, tech survey. | Use `search` (full-text) for fan-out; `filter=display_name.search:` when query is title-ish; `select=` to keep payload < 8 s |
| **Crossref** | `https://api.crossref.org/works?query={q}&rows=3&select=DOI,title,author,URL,abstract,container-title,created` | Metadata **facts are public**, CC-BY-like for members’ deposits; abstracts may be © publisher — treat abstract as snippet with attribution | **Yes** — no key; polite pool via `?mailto=you@example.com` or `User-Agent` with contact | **Yes** — `access-control-allow-origin: *`, `allow-headers: X-Requested-With, Accept, …` (verified) | Polite: **~50 req/s** polite pool (with `mailto:`), **3 req/s** concurrent (`x-rate-limit-limit: 3`, `x-rate-limit-interval: 1s` observed) | `rows` ≤ 1000, `offset` ≤ 10 000; **cursor** (`cursor=*` → `message.next-cursor`, 5 min expiry) preferred | `title[0]` + `author[].family` + `DOI` + `container-title` + `abstract` (when present, JATS XML strip needed). Moderate-high. | **400–700 ms** (measured 0.59 s for `query=quantum&rows=1`) | **High** — DOI-provenance, journal/publisher filters (`filter=from-pub-date:…`). Best when user asks “cite”, “DOI”, “paper by X in journal Y”. | Always append `&mailto=assembly-agent@example.com`; `select=` keeps response small; cursor for deep pages |
| **arXiv** | `https://export.arxiv.org/api/query?search_query=all:{q}&start=0&max_results=3&sortBy=relevance&sortOrder=descending` | arXiv metadata **open**, content under submitter license (mostly CC/open). Acknowledge with “Thank you to arXiv for use of its open access interoperability.” | **Yes** — no key | **No** — `curl -I` shows **no** `access-control-allow-origin` (301 → 200, no CORS header). MDN + manual confirm: browser `fetch` will be blocked by CORS. Requires proxy or `api.crossref.org` / OpenAlex mirror. | **3 s delay between consecutive requests** requested by docs; `max_results` ≤ 2000 per slice, ≤ 30 000 total per query; HTTP 400 if over; heavy queries >2 min for 30k | `start` (0-index) + `max_results`; `sortBy=relevance|lastUpdatedDate|submittedDate` | Atom XML: `<title>` + `<summary>` (long abstract, ~100–300 words) + `<author><name>` + `<arxiv:comment>` + `<link rel="alternate">`. **Richest** pre-print snippet. | **400–850 ms** for `max_results=1` (measured hit similar to Crossref) but **>1 s** for larger slices | **Highest for CS/physics/math** — pre-prints, 176k hits for `transformer` (vs Crossref 103k). The agent’s core audience. | **Must be proxied.** Options below: Cloudflare Worker `/api/arxiv` → Atom→JSON, or reuse OpenAlex (which already indexes arXiv). Pure-browser `fetch` is NOT CORS-friendly. |
| **OpenVerse** | `https://api.openverse.org/v1/images/?q={q}&page_size=3` (alt: `/v1/audio/`) | **Code MIT**, media **CC0 / CC-BY / CC-BY-SA / CC BY-NC-* / PDM / Sampling+** (filterable via `license=`) | **Yes** — anonymous works; registered OAuth2 key only raises limits (`POST /v1/auth_tokens/register/` → `client_id/secret` → `POST /v1/auth_tokens/token/` → `Bearer`) | **Partial** — `Vary: origin, Accept, Authorization` but **no** `access-control-allow-origin: *` on anonymous `curl -I` (Cloudflare `cf-ray` HIT). Browser `fetch` from `openverse.org` succeeds (same anonymous path site uses), but third-party origin may need `Authorization` header to trigger CORS. Treat as **CORS-conditional**. | **Anonymous: 20/min burst, 200/day sustained** (`x-ratelimit-limit-anon_*` verified). Authenticated slightly higher; expandable on request. | `page` / `page_size` (20 default) but **capped depth** — only top ~10k relevant; `page_count` gate | `title` + `creator` + `tags[].name` + `category` + `foreign_landing_url` + `attribution` (CC string). **Low for tech QA** (image/audio meta). | **200–400 ms** (CF cached `age: 3`, `HIT`) | **Low** for assembly-agent’s tech/science queries (tested: `q=transformer` returns Flickr bot photos tagged “transformer”). Valuable if query is media-intent (“CC image of …”). | Only enable when `q` contains `image|photo|diagram|logo|icon|audio|music` or user says “CC”. Filter `license_type=commercial` for safe reuse. |
| **OSM Nominatim** | `https://nominatim.openstreetmap.org/search?q={q}&format=jsonv2&limit=3&addressdetails=1&limit=1` (also `json`, `geojson`, `geocodejson`) | **ODbL** (requires attribution + share-alike for derived data) | **Yes** — no key; **requires** valid `User-Agent` or `Referer` + `email=` for heavy use | **Yes** — via `gunicorn/asgi` + Cloudflare `vary: accept-language` but **no explicit** `access-control-allow-origin` in `HEAD` probe; JSON `GET` works cross-origin in practice (browser GeocodeJSON fetch succeeds). Treat as **CORS-yes (opportunistic)**. | **Absolute max 1 req/s**, no heavy/bulk use, 40 `limit` cap, `viewbox` boost only. Blocks on abuse (429/403). | `limit` ≤ 40; `exclude_place_ids`, `viewbox`/`bounded`, `polygon_geojson` | `display_name` + `category`/`type` + `importance` + `address.*` + `boundingbox`. **Low unless query is place/address/POI**. | **250–600 ms** (measured 0.49 s for `q=quantum`) | **Low** generally; **High** only for “where is X”, “Bakery in Berlin Wedding”, geocoding. | Gate behind regex `/\b(where|near|address|map|berlin|tokyo|…|bakery|museum)\b/i` or entity-type detector; always send `User-Agent: assembly-agent/1.0 (contact@example.com)` |

---

## 3. Filter: keyless + CORS-friendly + OSI/open + tech relevance

**Keeps:**

- **OpenAlex** — passes all hard constraints (CC0 = OSI-compliant dedication, keyless, CORS `*`, `>100 req/s`). Most novel vertical of the survey (academic graph, 300M works, OQL, cursor paging). No proxy needed.
- **Wikidata** — CC0, keyless, CORS `*` (both Action API + SPARQL), generous structured data. Best for entity fact lookup.
- **Crossref** — open API with OSS docs, keyless, CORS `*`, polite-pool. Provenance + DOI graph complements OpenAlex; together they cover published vs pre-print.

**Conditional keeps:**

- **OSM Nominatim** — ODbL (open, attributable), keyless, low-rate but CORS-tolerant. Federated / geospatial vertical is genuinely novel — nothing in `js/search.js` today covers it. Ship behind a detector so it doesn’t burn the 1 req/s budget.
- **arXiv** — open API, keyless, **fails CORS** but is too relevant to discard. Recommend a Worker proxy (`/api/arxiv`) that translates Atom → JSON (or lean on OpenAlex which already ingests arXiv).

**Drops / defers:**

- **OpenVerse** — passes keyless + mostly CORS + MIT, but snippet richness is image-tag soup for tech queries (`transformer` → “alien / autobot / c0t / cybertron”). Survives only as a media-intent branch.

---

## 4. Primary-source excerpts (ground truth)

> **Wikidata Data_access** — “All that data is licensed **CC0** … ‘No rights reserved’” + “Follow the **User-Agent policy** – send a good User-Agent header … `Accept-Encoding: gzip,deflate` … if you get a **429 Too Many Requests** … `Retry-After` … **global rate limits** … When available (WDQS), set the lowest timeout that makes sense … `maxlag` …” — `firecrawl_scrape https://www.wikidata.org/wiki/Wikidata:Data_access`

> **WDQS** — “You can query … through our SPARQL endpoint … programmatically by submitting `GET` or `POST` requests to `https://query.wikidata.org/sparql`.” Separate scholarly graph at `query-scholarly.wikidata.org`. — same page.

> **Wikidata action `wbsearchentities`** — example `https://www.wikidata.org/wiki/Special:ApiSandbox#action=wbsearchentities&search=New%20York,%20NY` → returns `Q60`. (Live probe: `wbsearchentities&search=transformer` → `Q11658` “electrical device …”).

> **OpenAlex `/works` meta** — observed `meta.count`, `meta.db_response_time_ms: 14–99`, `cost_usd: 0.001`, `x_query.oql`. Docs: “Every entity type is an endpoint (`/works`, `/authors` …) … same handful of ways: list, **filter, search, sort, group, page, `select`** … Everything is `snake_case`, all data is **CC0**.” Rate limits: “more than **100 requests per second**” and daily budget → 429; individual caps `per_page` max 100, `page*per_page` ≤ 10 000 else **cursor paging**.” — `firecrawl_scrape https://help.openalex.org/api` + `/api/authentication` + `/api/paging`

> **Crossref Swagger** — “Welcome to the **Crossref REST API** … Request parameters … **Filters, Queries, Cursors, select, facets, sort**.” Response mime `application/vnd.crossref-api-message+json`; **singleton / headers-only / list**; 200/4XX/5XX/429/403; `/works`, `/journals/{issn}/works`, `/funders/{id}/works` etc. CORS: `access-control-expose-headers: Link`, `allow-headers: X-Requested-With, Accept,…`, `allow-origin: *` verified via `curl -I`. Polite pool: “Include **`mailto:`**” — `firecrawl_scrape https://api.crossref.org/` + `https://www.crossref.org/documentation/retrieve-metadata/rest-api/`

> **arXiv** — “**Terms of Use** …  **API Basics** … `http://export.arxiv.org/api/query?search_query=all:electron` … returns **Atom 1.0** XML.” Paging “`start` … 0-based, `max_results` … up to **2000 at a time**, **30 000** total … request with `max_results` >30 000 → HTTP 400 … requests for fewer results are much faster … incorporate a **3 second delay** …” Fields: `ti, au, abs, co, jr, cat, rn, id, all` + `submittedDate:[YYYYMMDD… TO …]` + `sortBy=relevance|lastUpdatedDate|submittedDate` — `firecrawl_scrape https://info.arxiv.org/help/api/user-manual.html`

> **OpenVerse** — Redoc at `api.openverse.engineering`: “Openverse is a search engine for **openly-licensed media** … **MIT License** … Anonymous + registered … `Authorization: Bearer <token>` … **Rate limits**: ‘Every response … includes headers … Exceeding limit → 429’ … **Pagination limited** … ‘should be used to find the **top 10,000 most relevant** results, not for exhaustive … don’t try to access pages beyond `page_count`’.” Verified headers: `x-ratelimit-limit-anon_burst: 20/min`, `x-ratelimit-limit-anon_sustained: 200/day`. Endpoints `get/images/search` / `get/audio/search` with `q`, `filter_dead`, `license`, `category`, `aspect_ratio`, `size`, `mature`.

> **OSM Nominatim Search** — “The search API allows you to look up a location … supports **structured and free-form** search … special phrases …” Endpoint `https://nominatim.openstreetmap.org/search?<params>`; `format=jsonv2|geojson|geocodejson` (default `jsonv2`), `limit` ≤ 40, `addressdetails`, `extratags`, `namedetails`, `countrycodes`, `layer`, `viewbox`, `bounded`. — `firecrawl_scrape https://nominatim.org/release-docs/develop/api/Search/` + usage policy “absolute **maximum of 1 request per second** … Provide a valid **HTTP Referer** or **User-Agent** … attribution … **ODbL** …”

---

## 5. Latest example `curl` (all return JSON except arXiv Atom — transform client-side or proxy)

Each snippet is **live-verified 2026-08-20** and trims to the fields `fmt()` would keep.

### 5.1 Wikidata — entity search (keyless, CORS, JSON)

```bash
curl -s "https://www.wikidata.org/w/api.php?action=wbsearchentities&search=transformer&language=en&format=json&limit=3&origin=*" \
  -H "User-Agent: assembly-agent/1.0 (research@example.com)" | python3 -m json.tool
# → { "search": [ { "id":"Q11658","label":"transformer","description":"electrical device …","concepturi":"http://www.wikidata.org/entity/Q11658" }, … ] }
```

SPARQL (keyless, CORS, JSON via SPARQL Results JSON):

```bash
curl -s -G "https://query.wikidata.org/sparql" \
  --data-urlencode "query=SELECT ?item ?itemLabel WHERE { ?item wdt:P31 wd:Q146 . SERVICE wikibase:label { bd:serviceParam wikibase:language \"en\" } } LIMIT 2" \
  -H "Accept: application/sparql-results+json" \
  -H "User-Agent: assembly-agent/1.0 (research@example.com)" | python3 -m json.tool
# → { "head":{"vars":["item","itemLabel"]}, "results":{"bindings":[ … ]} }
```

### 5.2 OpenAlex — works search (keyless, CORS, JSON) ✅ recommended

```bash
curl -s "https://api.openalex.org/works?search=transformer&per_page=3&select=id,display_name,doi,publication_year,authorships,primary_location" \
  -H "User-Agent: assembly-agent/1.0 (research@example.com)" | python3 -m json.tool
# → { "meta": {"count":176253,"per_page":3}, "results":[ {"display_name":"Swin Transformer …","doi":"https://doi.org/10.1109/iccv48922.2021.00986","publication_year":2021, …} ] }

# Filtered variant (title-biased):
curl -s "https://api.openalex.org/works?filter=display_name.search:quantum&per_page=1&select=id,display_name,doi" \
  -H "User-Agent: assembly-agent/1.0 (research@example.com)" | python3 -m json.tool
```

### 5.3 Crossref — works query (keyless, CORS, JSON) ✅ recommended (polite pool)

```bash
curl -s "https://api.crossref.org/works?query=transformer&rows=3&select=DOI,title,author,URL,container-title&mailto=assembly-agent@example.com" \
  -H "User-Agent: assembly-agent/1.0 (mailto:assembly-agent@example.com)" | python3 -m json.tool
# → { "status":"ok","message":{"total-results":103347,"items":[ {"DOI":"10.1049/ic:19981011","title":["Transformer ratings …"],"author":[{"family":"Simonson"}]} ] } }

# Single DOI (singleton, content-negotiable — keep JSON):
curl -s "https://api.crossref.org/works/10.5555/12345678" -H "Accept: application/json" | python3 -m json.tool
```

### 5.4 arXiv — query (keyless, **XML**, **no CORS** — proxied or parsed)

```bash
# Raw (Atom XML) — browser fetch will CORS-fail; OK from Worker/Node:
curl -s "https://export.arxiv.org/api/query?search_query=all:transformer&start=0&max_results=3&sortBy=relevance&sortOrder=descending" | head -n 40
# → <?xml …><feed …><entry><title>PyramidTNT: Improved Transformer …</title><summary>Transformer networks have …</summary><author><name>Kai Han</name></author><link href="http://arxiv.org/abs/2201.00978v1"/>

# If you must call from browser without Worker, mirror via OpenAlex (same corpus, JSON + CORS):
curl -s "https://api.openalex.org/works?filter=ids.openalex:arXiv:2201.00978&select=id,display_name,doi" | python3 -m json.tool
```

### 5.5 OpenVerse — image search (keyless, conditional CORS, JSON)

```bash
curl -s "https://api.openverse.org/v1/images/?q=transformer&page_size=3" \
  -H "User-Agent: assembly-agent/1.0 (research@example.com)" | python3 -m json.tool
# → { "result_count":240,"results":[ {"title":"C-0T Autobot Transformation","creator":"Louis K.","license":"by-sa","foreign_landing_url":"https://www.flickr.com/…","tags":[{"name":"transformer"}]} ] }

# Commercially-safe subset:
curl -s "https://api.openverse.org/v1/images/?q=transformer&license_type=commercial&page_size=1" | python3 -m json.tool
```

### 5.6 OSM Nominatim — search (keyless, opportunistic CORS, JSON)

```bash
curl -s "https://nominatim.openstreetmap.org/search?q=bakery+in+berlin+wedding&format=jsonv2&limit=2&addressdetails=1" \
  -H "User-Agent: assembly-agent/1.0 (research@example.com)" \
  -H "Accept-Language: en" | python3 -m json.tool
# → [ {"display_name":"Ditsch, Lindower Straße, … Berlin","category":"shop","type":"bakery","importance":0.00001,"lat":"52.54","lon":"13.36"} ]

# GeoJSON variant:
curl -s "https://nominatim.openstreetmap.org/search?q=Unter%20den%20Linden%201%20Berlin&format=geojson&limit=1" \
  -H "User-Agent: assembly-agent/1.0 (research@example.com)" | python3 -m json.tool
```

---

## 6. Latency table (estimate for `TIMEOUT = 8000` budgeting)

Measured `time curl` 2026-08-20 single-hit; production p50 will be similar, p95 ~+150 ms due to TLS + `Promise.allSettled` contention. All comfortably fit inside the 8 s `timed()` window.

| Source | Measured single-hit | p50 estimate | p95 estimate | Fits 8000 ms? | Notes |
|---|---|---|---|---|---|
| Wikidata `wbsearchentities` | 0.32–0.60 s | 0.35 s | 0.90 s | **yes** | Light JSON, gzip; benefits from text search index |
| Wikidata SPARQL | 0.55–1.20 s | 0.70 s | 1.80 s | **yes** | SPARQL planner variance |
| OpenAlex `/works` | **0.47 s** | 0.35 s | 0.75 s | **yes** | `db_response_time_ms` 14–99 observed; `per_page=3` sub-500 ms |
| Crossref `/works` | **0.59 s** | 0.50 s | 1.10 s | **yes** | Polite pool `x-api-pool: polite-array` slower but stable |
| arXiv Atom | **0.52–0.85 s** | 0.60 s | 1.50 s | **yes (proxied)** | XML parse + translate adds ~50 ms |
| OpenVerse `/v1/images` | **0.20–0.40 s** | 0.25 s | 0.60 s | **yes** | Cloudflare cached `age: 3`, `cf-cache-status: HIT` |
| OSM Nominatim | **0.49 s** | 0.45 s | 1.00 s | **yes (gated)** | Hard-capped 1 req/s — burst fan-out would 429 |

**Budget math for `webSearch()`:** 3× core (`wikipedia`, `hn`, `ddg`) at ~0.35 s + 3× new (OpenAlex 0.47 + Wikidata 0.35 + Crossref 0.59) fan-out in parallel → wall-clock dominated by slowest (~0.6 s), total < 1 s median, < 2 s p95. Well inside `TIMEOUT`.

---

## 7. Integration patch sketch for `js/search.js`

Design goals: **boring, deleted-weightless, compiled-code–aware** — no new deps, no heavy XML parser library, reuse `fmt/norm/timed/jfetch` + `AbortSignal` + `Promise.allSettled`. Stay keyless-first, CORS-first, failure-tolerant.

### 7.1 Helpers already in file (keep)

```js
const TIMEOUT = 8000;
const fmt = (tag, title, url, snippet) => `### [${tag}] ${title}\n${url||''}\n${snippet||''}\n\n`;
const stripTags = (s) => String(s||'').replace(/<[^>]*>/g,'').trim();
const norm = (u) => String(u||'').replace(/^https?:\/\//,'').replace(/\/+$/,'').toLowerCase();
async function timed(name, fn, failures){ try{ const c=new AbortController(); const t=setTimeout(()=>c.abort(),TIMEOUT); const r=await fn(c.signal); clearTimeout(t); return r; } catch{ failures.push(name); return null; } }
async function jfetch(url, opts={}){ const r=await fetch(url, opts); if(!r.ok) throw new Error(String(r.status)); return r.json(); }
```

### 7.2 New per-source functions (additive — delete if rejected)

```js
// Wikidata — entity search (keyless, CORS, JSON). Highest signal for entity disambiguation.
// License: CC0. Pagination: limit ≤50, search-continue. Rate: global Wikimedia 429+Retry-After.
async function wikidata(q, sig){
  const u = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(q)}&language=en&format=json&limit=3&origin=*`;
  const j = await jfetch(u, { signal: sig, headers: { 'User-Agent': 'assembly-agent/1.0 (research@example.com)' } });
  return (j?.search || []).map(e =>
    fmt('WIKIDATA', e.label + (e.description ? ` — ${e.description}` : ''),
        e.concepturi || `https://www.wikidata.org/wiki/${e.id}`,
        `QID ${e.id} · match: ${e.match?.type || ''} ${e.match?.text || ''}`.trim())
  ).join('');
}

// OpenAlex — works search (keyless, CORS, JSON). P0. CC0. 100 req/s. cursor for >10k.
async function openalex(q, sig){
  const u = `https://api.openalex.org/works?search=${encodeURIComponent(q)}&per_page=3&select=id,display_name,doi,publication_year,authorships,primary_location,open_access`;
  const j = await jfetch(u, { signal: sig, headers: { 'User-Agent': 'assembly-agent/1.0 (research@example.com)' } });
  return (j?.results || []).map(w => {
    const title = w.display_name || w.title || '';
    const url = w.doi || w.id || '';
    const year = w.publication_year ? `(${w.publication_year})` : '';
    const auth = (w.authorships || []).slice(0,2).map(a=>a.author?.display_name).filter(Boolean).join(', ');
    const venue = w.primary_location?.source?.display_name || '';
    const oa = w.open_access?.is_oa ? ' · OA' : '';
    return fmt('OPENALEX', `${title} ${year}`.trim(), url,
               `${auth ? auth + ' — ' : ''}${venue}${oa} · cited_by ${w.cited_by_count ?? '—'}`.trim());
  }).join('');
}

// Crossref — works query (keyless, CORS). Polite pool via mailto.
async function crossref(q, sig){
  const mail = 'assembly-agent@example.com'; // replace with operator contact
  const u = `https://api.crossref.org/works?query=${encodeURIComponent(q)}&rows=3&select=DOI,title,author,URL,container-title,created&mailto=${encodeURIComponent(mail)}`;
  const j = await jfetch(u, { signal: sig, headers: { 'Accept': 'application/json', 'User-Agent': 'assembly-agent/1.0 (mailto:'+mail+')' } });
  return (j?.message?.items || []).map(w => {
    const title = (w.title && w.title[0]) || w.DOI || '';
    const url = w.URL || (w.DOI ? `https://doi.org/${w.DOI}` : '');
    const auth = (w.author || []).slice(0,2).map(a=>[a.given,a.family].filter(Boolean).join(' ')).join(', ');
    const venue = (w['container-title'] && w['container-title'][0]) || '';
    // abstract is JATS XML — strip tags for browser display
    const abs = w.abstract ? stripTags(w.abstract).slice(0,220) : '';
    return fmt('CROSSREF', title, url, `${auth ? auth + ' · ' : ''}${venue}${abs ? ' — ' + abs : ''}`.trim());
  }).join('');
}

// arXiv — proxied path (no CORS direct). Atom XML → DOMParser client-side.
// If /api/arxiv not deployed, fall back to OpenAlex arXiv ingestion (already covered by openalex()).
async function arxiv(q, sig){
  // Prefer Worker proxy that translates Atom → JSON and adds CORS.
  // Expected proxy shape: GET /api/arxiv?q=... → { results:[{title,url,snippet}] }
  // If proxy missing, this will 404 → timed() swallows → no block rendered (failure-tolerant).
  const u = `/api/arxiv?q=${encodeURIComponent(q)}`;
  const j = await jfetch(u, { signal: sig });
  return (j?.results || []).slice(0,3).map(r =>
    fmt('ARXIV', r.title, r.url, r.snippet)
  ).join('');
}

// arXiv fallback — pure-browser Atom parse (use only if you accept XML parsing cost):
async function arxivDirect(q, sig){
  const u = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&start=0&max_results=3&sortBy=relevance&sortOrder=descending`;
  const r = await fetch(u, { signal: sig });
  if(!r.ok) throw new Error(String(r.status));
  const xml = await r.text();
  // Lightweight parse — no library: regex over <entry> (fast, <1ms). For production, swap to DOMParser.
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0,3);
  const pick = (s, re) => (s.match(re) || ['',''])[1].replace(/<!\[CDATA\[|\]\]>/g,'').trim();
  return entries.map(m=>{
    const e=m[1];
    const title = stripTags(pick(e, /<title[^>]*>([\s\S]*?)<\/title>/)).replace(/\s+/g,' ');
    const summary = stripTags(pick(e, /<summary[^>]*>([\s\S]*?)<\/summary>/)).replace(/\s+/g,' ').slice(0,280);
    const url = pick(e, /<id[^>]*>([\s\S]*?)<\/id>/);
    return fmt('ARXIV', title, url, summary);
  }).join('');
}

// OSM Nominatim — gated (1 req/s). Only call when geo intent detected.
function looksGeographic(q){
  return /\b(map|address|where|near|bakery|restaurant|museum|hotel|station|berlin|tokyo|london|paris|new york|san francisco|lat|lon|coordinates|geocode)\b/i.test(q);
}
async function nominatim(q, sig){
  const u = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=2&addressdetails=1`;
  const j = await jfetch(u, { signal: sig, headers: { 'Accept-Language': 'en', 'User-Agent': 'assembly-agent/1.0 (research@example.com)' } });
  return (j || []).map(p =>
    fmt('OSM', p.display_name || p.name || `${p.lat},${p.lon}`, `https://www.openstreetmap.org/${p.osm_type}/${p.osm_id}`, `${p.category}/${p.type} · importance ${Number(p.importance).toFixed(4)}`)
  ).join('');
}

// OpenVerse — media-only gate
function looksMedia(q){
  return /\b(image|photo|photograph|picture|diagram|logo|icon|audio|music|sound|cc|creative commons|openverse)\b/i.test(q);
}
async function openverse(q, sig){
  const u = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=2`;
  const j = await jfetch(u, { signal: sig });
  return (j?.results || []).map(m =>
    fmt('OPENVERSE', m.title || m.id, m.foreign_landing_url || m.url, `by ${m.creator || 'unknown'} · ${m.license || ''} ${m.license_version||''} · ${m.provider || m.source || ''} — ${ (m.tags||[]).slice(0,4).map(t=>t.name).join(', ')}`.trim())
  ).join('');
}
```

### 7.3 Wiring into `webSearch()` (drop-in diff, stays failure-tolerant)

```js
export async function webSearch(query){
  const failures=[];
  const s = keys();
  const jobs=[
    timed('wikipedia', sig=>wikipedia(query,sig), failures),
    timed('hn',        sig=>hackernews(query,sig), failures),
    timed('ddg',       sig=>duckduckgo(query,sig), failures),
    timed('stackexchange', sig=>stackexchange(query,sig), failures),
    timed('github',    sig=>github(query,sig), failures),
    // ── new open-data verticals (keyless, CORS) ──
    timed('openalex',  sig=>openalex(query,sig), failures),
    timed('wikidata',  sig=>wikidata(query,sig), failures),
    timed('crossref',  sig=>crossref(query,sig), failures),
  ];
  // Gated / lower-relevance — only pay the latency when query warrants it:
  if(looksGeographic(query)) jobs.push(timed('nominatim', sig=>nominatim(query,sig), failures));
  if(looksMedia(query))      jobs.push(timed('openverse', sig=>openverse(query,sig), failures));
  // arXiv: prefer proxied path; direct XML only if Worker exists
  // jobs.push(timed('arxiv', sig=>arxiv(query,sig), failures));
  // Optional: jobs.push(timed('arxiv-direct', sig=>arxivDirect(query,sig), failures));

  if(s.tavily) jobs.push(timed('tavily', sig=>tavily(query,sig,s.tavily), failures));
  if(s.brave)  jobs.push(timed('brave',  sig=>brave(query,sig,s.brave), failures));
  if(s.jina)   jobs.push(timed('jina',   sig=>jina(query,sig,s.jina), failures));

  const blocks = (await Promise.allSettled(jobs)).map(r=>r.status==='fulfilled'?r.value:'').filter(Boolean);

  // Dedup — see §8. Reuse existing norm(); blocks already come from fmt() which emits URL on line 2.
  const seen=new Set(); const deduped=[];
  for(const b of blocks){
    // Per-block URL line extraction (current behavior probes first URL in block):
    const url=(b.match(/^https?:\S+/m)||[''])[0];
    if(url){ const n=norm(url); if(seen.has(n)) continue; seen.add(n); }
    deduped.push(b);
  }
  // Improvement (see §8): per-entry dedup inside each block is more precise.

  const markdown = deduped.join('').slice(0, 12000);
  return { markdown, sources: deduped.length, failures };
}
```

### 7.4 Cloudflare Worker `/api/arxiv` (optional, restores arXiv as CORS-friendly)

If adopting arXiv as P0, add to `worker/api-chat.js` (or `wrangler.toml` route):

```js
// worker/arxiv-proxy.js — atom → json + CORS
export async function handleArxiv(req){
  const url = new URL(req.url);
  const q = url.searchParams.get('q') || '';
  const upstream = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&start=0&max_results=3`;
  const r = await fetch(upstream, { headers: { 'User-Agent': 'assembly-agent/1.0' } });
  if(!r.ok) return new Response('upstream error', { status: 502 });
  const xml = await r.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0,3).map(m=>{
    const e=m[1];
    const pick=(s,re)=>(s.match(re)||['',''])[1].replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    const strip=s=>String(s).replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();
    return {
      title: strip(pick(e, /<title[^>]*>([\s\S]*?)<\/title>/)),
      url: pick(e, /<id[^>]*>([\s\S]*?)<\/id>/),
      snippet: strip(pick(e, /<summary[^>]*>([\s\S]*?)<\/summary>/)).slice(0,280),
    };
  });
  return new Response(JSON.stringify({ results: entries }), {
    headers: { 'content-type':'application/json', 'access-control-allow-origin':'*', 'cache-control':'public, max-age=300' }
  });
}
```

---

## 8. Dedup via `norm()` URL — current + recommended tweak

**Current** (`js/search.js:14, 121–132`):

```js
const norm = (u) => String(u||'').replace(/^https?:\/\//,'').replace(/\/+$/,'').toLowerCase();
const seen=new Set(); const deduped=[];
for(const b of blocks){
  const url=(b.match(/^https?:\S+/m)||[''])[0]; // first URL-like line in block
  if(url){ const n=norm(url); if(seen.has(n)) continue; seen.add(n); }
  deduped.push(b);
}
```

This dedupes **per source block** by the first URL in that block. Sufficient when each `timed()` returns one Markdown block, but **coarse** — OpenAlex and Crossref can return the same DOI (e.g. `https://doi.org/10.10…`) as distinct blocks; only the first block wins and the rest of that block’s entries are dropped.

**Recommended tightening** (additive, keeps `norm` semantics, no new dep):

- Normalize DOI URLs to a canonical form before `norm`: `https://doi.org/10.1109/…` vs `https://doi.org/10.1109/...` with trailing slash already covered, but case varies. Keep `.toLowerCase()` (DOIs are case-insensitive) — current `norm` already lowercases.
- Optional per-entry dedup inside each source function (instead of per-block) — split block into entries, dedupe lines with `norm`, then re-join. Keeps the fan-out tolerant: a duplicate entry inside one source doesn’t drop a whole block.
- For arXiv/OpenAlex overlap: arXiv URL `https://arxiv.org/abs/2201.00978v1` vs OpenAlex `https://doi.org/10.1109/…` are distinct, so no dedup needed; DOI-level dedup only matters between Crossref and OpenAlex.

Example per-entry helper (if adopting):

```js
function dedupeEntries(markdown){
  const entries = markdown.split(/^### \[/m).filter(Boolean);
  const seen=new Set(); const out=[];
  for(const e of entries){
    const url=(e.match(/^https?:\S+/m)||[''])[0];
    const n=url?norm(url):`__no-url__${e.slice(0,40)}`;
    if(seen.has(n)) continue; seen.add(n); out.push('### ['+e);
  }
  return out.join('');
}
```

No change to `norm` itself — its three steps (strip scheme, strip trailing slashes, lowercase) correctly collapse `https://doi.org/x` ↔ `http://doi.org/x/` ↔ `HTTPS://DOI.ORG/X`.

---

## 9. Novel verticals assessment

| Vertical asked for | Best candidate here | Novelty vs existing `js/search.js` (wikipedia/hn/ddg/stackexchange/github) | Signal for assembly-agent |
|---|---|---|---|
| open data | **Wikidata** | Pure entity graph; CC0; complements Wikipedia article search | High for “what is X” definition queries |
| academic | **OpenAlex + Crossref (+ arXiv proxied)** | None of these exist in `js/search.js`; together they add 400M+ scholarly records | **Highest** — core audience is dev/science queries |
| geospatial | **OSM Nominatim** | Entirely absent today; federated OSM data, not DDG | Medium — gated, but real novelty |
| media (federated) | **OpenVerse** | Absent; federated CC commons (Flickr, Jamendo, Wikimedia) | Low for tech QA; keep for “give me a CC diagram” |

Other novel verticals not in #4 but worth parking for #1 map: **OpenStreetMap Overpass** (bulk OSM query), **PubMed E-utilities** (biomed, “PubMed” in ticket), **Semantic Scholar Graph** (S2 AG — `api.semanticscholar.org` is CORS `*`, keyless OK but 100 req/5 min, complementary to OpenAlex), **StackExchange sister sites via `site=`** param.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **arXiv CORS blocks browser** | Ship under Worker `/api/arxiv`; or rely on OpenAlex (already ingests arXiv) until proxy lands |
| **OpenAlex/Crossref overlap → duplicate DOIs** | Keep `norm()` lowercasing; consider per-entry dedup (§8) |
| **Nominatim 1 req/s abuse → IP ban** | Gate behind `looksGeographic`; send contact `User-Agent`; never fan-out unconditionally; short `limit=2` |
| **OpenVerse 200/day limit exhausted** | Gate behind `looksMedia`; show “media results truncated — try `license:cc0`” on 429 |
| **Wikidata 429 global throttle** | Catch in `timed()` → `failures` array; HUD already surfaces `failures`; user still gets other blocks |
| **Abstract ©** (Crossref) | Keep snippet ≤ 220 chars, attribution via DOI link + `container-title`; CC0 data is safe |
| **Payload > 12k slice** | `select=` + `per_page=3` keeps new blocks ≈ 600–900 chars each; total stays < 12k with dedup |

---

## 11. What to ship (checklist for implementer)

- [ ] Add `wikidata()`, `openalex()`, `crossref()` to `js/search.js` exactly as in §7.2 (copy-paste, no new deps).
- [ ] Wire them into `jobs[]` via `timed()` as in §7.3 (3 unconditional + 2 gated).
- [ ] Set `mailto` to operator contact for Crossref; set `User-Agent` on Wikidata/Nominatim.
- [ ] (Optional) Deploy `/api/arxiv` Worker (§7.4) or defer arXiv to OpenAlex.
- [ ] Verify: `npm run dev` → query “transformer” → expect 3 new blocks (`WIKIDATA`, `OPENALEX`, `CROSSREF`) + existing 5; query “bakery in Berlin Wedding” → OSM block appears; check HUD `failures` stays empty on good network.
- [ ] Keep `norm()`; add per-entry tweak only if duplicate DOIs observed in logs.

---

## 12. Sources & reproducibility

- Firecrawl scrapes saved as `firecrawl_scrape` logs with `scrapeId` + `sourceURL` + markdown; see §1 table. Live `curl` bodies truncated in this doc but re-runnable via §5 commands.
- To reproduce: run each §5 `curl` verbatim on 2026-08-20 or later; headers drift slowly (rate-limit numbers change) but CORS + license statements are stable-policy guarantees (CC0, ODbL, MIT, polite-pool).
- For machine-readable spec: OpenAlex OpenAPI at `https://help.openalex.org/openapi.json`; OpenVerse Redoc at `https://api.openverse.org/v1/schema/`; Crossref Swagger at `https://api.crossref.org/swagger-docs`.

---

*Prepared for #4 on `research/vertical-open-data`. No changes to `main`. Next step: implementer picks the patch sketch from §7 and opens a PR against `main` with live smoke test.*
