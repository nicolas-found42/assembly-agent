# Meta-Search Feasibility — Public, Keyless, CORS-Friendly Endpoints for GH Pages Static

**Ticket:** [#3 Research public, keyless, CORS-friendly meta-search endpoints usable from GH Pages](https://github.com/nicolas-found42/assembly-agent/issues/3) · **Parent:** [#1 Wayfinder Map](https://github.com/nicolas-found42/assembly-agent/issues/1)  
**Branch:** `research/meta-search-feasibility` · **Date:** 2026-08-20  
**Method:** Direct `curl` + `curl -I` probes from Node/edge (no Firecrawl credit burn; prior session hit 429 on Firecrawl free tier at 11 req/min) + live doc fetches (`docs.searxng.org`, `raw.githubusercontent.com`, `searx.space/data/instances.json`) + baseline `js/search.js:103-136` fan-out review. Constraint: **GH Pages static** — no server, no `worker/api-chat.js` search proxy, no keys, no paid/closed deps; all sources must be fetchable via `jfetch` + `timed()` + `Promise.allSettled` with 8s `TIMEOUT` and `norm(url)` dedup.

> Discovery via Firecrawl MCP was attempted but free-tier 429 made direct `curl` ground truth faster; runtime remains static `js/search.js` fan-out only.

---

## TL;DR — Recommendation: `direct fan-out only` (reject public aggregator on GH Pages)

**Do not add a public SearXNG (or any public meta-search) endpoint to `js/search.js`.** Ship the direct GH Pages static fan-out identified in #2 + #4 (Wikidata/OpenAlex/Crossref/Semantic Scholar/DOAJ/Open Library/DBpedia/GDELT/Lobste.rs + existing Wikipedia/HN/GitHub, cap 8–10) and treat SearXNG as **self-host only**, which is already Out of scope for GH Pages.

Three independent blockers each suffice to reject:

1. **JSON format disabled on most public instances.** Default `searx/settings.yml` is `formats: [html]` only — `json`/`csv`/`rss` must be explicitly opted in. `docs.searxng.org/dev/search_api.html` states: *"If you want to consume the results as JSON, CSV, or RSS, you need to set the `format` parameter ... Supported formats are defined in `settings.yml`, under the `search:` section. Requesting an unset format will return a 403 Forbidden error. **Be aware that many public instances have these formats disabled.**"* Live probes confirm: `searxng.site` → `403 Forbidden` for `?format=json`, `searx.oloke.xyz` → `202` antibot page not JSON, `searx.be` → antibot `Verifying your browser…` HTML, not `application/json`.
2. **No CORS header — browser `fetch` blocked.** Every probed public instance omits `Access-Control-Allow-Origin`. `curl -I` for `searx.be`, `baresearch.org`, `searx.tiekoetter.com`, `searxng.site`, `search.hbubli.cc`, `etsi.me`, `opnxng.com`, `priv.au`, `paulgo.io`, `searx.oloke.xyz` shows `content-type: text/html` / `content-security-policy: default-src 'none'` but **no `access-control-allow-origin: *`**. GH Pages `fetch` from `https://nicolas-found42.github.io` would be blocked without a Worker proxy, which the GH Pages constraint forbids. Seaworthy direct sources (`wikipedia` with `origin=*`, `openalex`/`crossref`/`hn`/`github`/`lobste.rs` all `*`) pass; SearXNG public instances do not.
3. **ToS / ops fragility — borrowing volunteer compute.** `https://searx.space` lists ~89 public instances, ~46 with `200` + `search.success_percentage ≥90`, but operators donate capacity with no SLA. Fan-out from GH Pages would concentrate anonymous traffic from all visitors onto a single third-party host (vs today's diverse per-origin client fan-out), triggering rapid `429 Too Many Requests` (observed on 6/9 probed hosts within seconds of our single-IP probes: `etsi.me`, `searx.tiekoetter.com`, `search.hbubli.cc`, `opnxng.com`, `priv.au`, `paulgo.io` all `429`). `searx.space` itself and SearXNG docs advise self-hosting for programmatic use; hammering a public instance violates the implicit ToS and burns goodwill.

If a future GH Pages deployment adds a Worker (`wabt` + `upload-pages-artifact` currently forbids it), a proxied `GET /search?format=json` behind a self-hosted SearXNG could complement direct fan-out — but on GH Pages static it is **rejected**.

---

## 1. How this was researched

| Intent | Tool | Input | Result |
|---|---|---|---|
| SearXNG Search API shape | `curl -s https://docs.searxng.org/dev/search_api.html` | HTML→text | Two endpoints `GET /` and `GET /search`, params as URL query, `q` + `format=json|csv|rss` (must be enabled in `settings.yml` `search.formats`), `pageno`, `time_range`, `safesearch`. Example `curl 'https://searx.example.org/search?q=searxng&format=json'`. Also `POST /search` as `application/x-www-form-urlencoded`. |
| Stock config | `curl -s https://raw.githubusercontent.com/searxng/searxng/master/searx/settings.yml` |  | `search.formats: [html]` only — json not default. Confirms docs warning. |
| Instance inventory | `curl -s https://searx.space/data/instances.json` | ~89 instances, metadata + `timing.search.median` + `http.status_code` | Top low-latency healthy: `searx.oloke.xyz` 0.25s, `searx.tiekoetter.com` 0.27s, `searxng.deggo.fyi` 0.28s, `search.hbubli.cc` 0.30s, etc. 46 meet `200 + ≥90% search success`. |
| CORS / JSON probes | `curl -I` + `curl -s` | 9+ public hosts `?format=json&q=test` | All omit `access-control-allow-origin`; 6 returned `429`, 2 antibot HTML, 1 `403 Forbidden`, 0 returned JSON. See §2 table. |
| SearXNG ToS hint | `curl -s https://raw.githubusercontent.com/searxng/searxng/master/README.rst` | AGPL-3.0, self-host guide `Installation guide https://docs.searxng.org/admin/installation.html` | Confirms self-host as intended path; public list is donor-run, no SLA. |
| Baseline for comparison | `js/search.js:103-136` + `docs/research/baseline-search.md` | `timed()` 8s, `jfetch`, `fmt()`, `norm(url)` dedup, 12k slice, 5 keyless + 3 keyed | Direct sources show CORS `*`, 71–815ms p95, 429 after burst on GH/Wikipedia but recover; DDG 95% empty already argues for richer direct sources, not an aggregator. |

Prior session attempted Firecrawl MCP harvest with 7s backoff but hit 429 after ~11 req/min; this retry used direct `curl` ground truth (same evidence, no credit burn) and respects the 7s-pace principle.

---

## 2. Evidence table — public SearXNG on GH Pages static

| Host | `?format=json` HTTP | `Access-Control-Allow-Origin` | Body | Verdict |
|---|---|---|---|---|
| `https://searx.be/search?format=json&q=test` | `200` then antibot `202` | **none** | `Verifying your browser…` + `antibot/captcha` HTML | JSON disabled / antibot |
| `https://baresearch.org/search?format=json&q=test` | `200` | **none** | `Making sure you're not a bot!` + `anubis` HTML | Antibot gate |
| `https://searx.oloke.xyz/search?format=json&q=test` | `202` | **none** | `Making sure you're not a bot!` (xess antibot) | Gate |
| `https://searx.tiekoetter.com/search?format=json&q=test` | `429 Too Many Requests` | **none** | `Too Many Requests` | Rate-limited |
| `https://searxng.site/search?format=json&q=test` | `403 Forbidden` | **none** (`Apache 2.4.58`) | `You don't have permission` — format not enabled | 403 per docs |
| `https://etsi.me/search?format=json&q=test` | `429` | **none** | `Too Many Requests` | Rate-limited |
| `https://search.hbubli.cc/search?format=json&q=test` | `429` | **none** | `Too Many Requests` | Rate-limited |
| `https://opnxng.com/search?format=json&q=test` | `429` | **none** | `Too Many Requests` | Rate-limited |
| `https://priv.au/search?format=json&q=test` | `429` | **none** | `Too Many Requests` | Rate-limited |
| `https://paulgo.io/search?format=json&q=test` | `429` | **none** | `Too Many Requests` | Rate-limited |

**Pattern:** 0/10 returned `application/json` with `access-control-allow-origin: *`. Even if one instance temporarily enabled JSON + CORS, GH Pages would be one operator config flip away from total failure — unacceptable for a static site with no fallback proxy.

---

## 3. Why `direct fan-out only` wins for GH Pages

| Dimension | Public SearXNG aggregator | Direct GH Pages fan-out (`js/search.js` `Promise.allSettled` + `timed`) |
|---|---|---|
| **CORS** | **Fail** — no header; needs Worker proxy (GH Pages forbids) | **Pass** — all P0 picks verified `*`: `openalex`, `crossref`, `wikidata` (`origin=*`), `semantic scholar`, `doaj`, `open library`, `dbpedia`, `gdelt`, `lobste.rs`, `hn`, `github`, `wikipedia` |
| **Auth/keys** | Keyless but **ToS-fragile** (donor instance abuse) | Keyless by design; anonymous per-user IP quota (not shared Worker egress) |
| **Ops** | Single point of failure; instance can vanish or 429 the whole GH Pages population | Failure-tolerant: `timed()` → `failures[]`; `Promise.allSettled` keeps other 7–9 sources; per-origin isolation |
| **Latency** | `searx.space` median 0.25–0.65s + proxy overhead, but blocked by antibot | P50 ~0.35s per P0 (vertical research: openalex 0.47s, wikidata 0.35s, crossref 0.59s); parallel wall-clock <1s median, <2s p95 — fits 8s `TIMEOUT` |
| **Snippet richness** | Opaque — aggregator normalizes but loses source attribution | `fmt(tag,title,url,snippet)` preserves provenance per 12k slice; `norm(url)` dedup |
| **OSS purity** | AGPL-3.0 self-host OK, but public instance is borrowed closed-ops | OSI/CC0/ODbL direct APIs (all `Auth=No`, `CORS=Yes`) |
| **GH Pages workflow** | Needs server (`searxng` binary + `settings.yml`) — `wabt` + `upload-pages-artifact` only | Pure static — `js/search.js` + `wabt` |

---

## 4. Example integration (rejected — do not ship; shown for completeness)

If a CORS-enabled, JSON-enabled instance existed (it does not reliably), the `js/search.js` shape would be:

```js
// GH Pages static — failure-tolerant, matches existing timed() pattern
async function searxng(q, sig) {
  // NOTE: no public instance reliably serves this with CORS + JSON today
  const u = `https://searx.example.org/search?q=${encodeURIComponent(q)}&format=json&categories=general`;
  const j = await jfetch(u, { signal: sig });
  // SearXNG JSON: { query, number_of_results, results: [{title, url, content, engine, score, category}] }
  return (j?.results || []).slice(0, 3).map(r =>
    fmt('SEARXNG', r.title, r.url, `${r.engine || ''} · ${r.content || ''}`.trim())
  ).join('');
}

// in webSearch jobs[]:
// timed('searxng', s => searxng(query, s), failures),
```

**Do not add** — any GH Pages deployment using this would CORS-fail for visitors and hammer a donor instance; keep commented until a self-hosted `searxng` behind a Worker/CF proxy is available (Out of scope per map).

---

## 5. Alternatives considered and rejected

- **YaCy / Whoogle / OpenSearch / MeiliSearch / RSSHub public** — self-host or archived (`whoogle` archived 2026-07-24), no public CORS endpoint; same GH Pages rejection as SearXNG self-host.
- **SearXNG self-host on Fly/Render** — viable technically but violates GH Pages static constraint (`worker/api-chat.js` proxy already rejected for search; map forbids new Worker/server).
- **Common Crawl Index via `index.commoncrawl.org`** — keyless but **no CORS**, CDX + WARC fetch chain; gated behind proxy in awesome-harvest §2.

All are indexed in `docs/research/awesome-github-harvest.md` §2 as Reject for GH Pages.

---

## 6. What this unlocks for #6 Grilling

- Inclusion filter can **assume direct fan-out only** — no aggregator weight or instance-selection policy needed.
- Cap fan-out at **8–10 keyless `*` CORS sources** (from #2 + #4 P0 set) without needing a meta-search fallback.
- Keep `timed()` + `Promise.allSettled` + `norm(url)` dedup + 12k slice unchanged; no new API shape to grill.
- If a future map revisits search outside GH Pages static, re-evaluate proxy + self-hosted SearXNG vs direct fan-out as a separate ADR.

---

*Prepared for #3 on `research/meta-search-feasibility`. No changes to `main`. Next: close #3, append gist to map #1 `## Decisions so far`, unblocking #6 Grilling (`blockedBy [3:OPEN] → closed`).*
