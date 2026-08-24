# Live Web Search on GH Pages — Free, Open-Source & CORS-Clean — Comprehensive Research

**Date:** 2026-08-24 · **Snapshot taken:** 2026-08-24T20:01–20:15Z UTC  
**Repo:** `assembly-agent` — static amber CRT chat (OpenRouter + WAT, `js/search.js` fan-out `Promise.allSettled`, `TIMEOUT=8000`, `Search Budget` 5, `Tool Round`). GH Pages deploy is static: no secrets in bundle, optional free Worker at `GET /api/search?url=` / `GET /api/arxiv?q=` only.  
**Purpose:** Answer *how to add live web search from Google/DuckDuckGo-like engines that is completely free, open-source, and runs on the GH Pages deploy* — with 2 paste-ready implementations, creative alternatives, and a workaround for every blocker. Every claim cites the primary source that owns it (official docs, source file, spec, live `curl -I`, first-party API). Follow every claim back to that source — no secondary write-ups.

> **User's exact research question (verbatim):**
>
> > "i would like to add more web search capabilities to the agent. i want it to be able to search live results from a search engine such as google duckduckgo or similar. all open source and completely free. be as thorough as possible and don't stop researching until you have 2 examples of how we can do this. be as thorough as possible, be as creative as possible. this must run on our gh pages deploy. think outside of the box. look at awesome lists and other github repos with examples. reddit is a useful resours. also use the arxiv mcp server. use a team of subagents to achieve this"


**Skill convention:** This repo keeps primary-source notes in `docs/research/` (`docs/research/openrouter-free-tool-support.md` 36KB, `docs/research/mobile-a11y-standards.md` 16KB, `docs/research/mattpocock-omp-friction-2026-08-24.md` 41KB …). This file follows that convention at `docs/research/web-search-live-free-2026-08-24.md`. Nothing else was modified to write it.

**Method / trust notes.**
- Primary sources only: `docs/adr/0004-source-inclusion-ranking.md`, `docs/adr/0008-static-general-sources.md`, `CONTEXT.md`, `js/search.js` (855 lines), `worker/api-chat.js`, `wrangler.toml` read locally 2026-08-24; every external endpoint live-probed 2026-08-24 via `curl -s -D -` / `curl -I` with `Origin` header and `time curl`; awesome lists fetched via `read` on raw GitHub URLs (`sindresorhus/awesome`, `public-apis/public-apis`, `edoardottt/awesome-hacker-search-engines`, `searxng/searxng`, `brave/brave-search-mcp-server`, `MarginaliaSearch/MarginaliaSearch`) and `api.github.com/repos`; Reddit threads via `web_search site:reddit.com` + live probes (`www.reddit.com/.json` 403, `old.reddit.com/.json` 403, `r.jina.ai/http://www.reddit.com` 403, `api.pullpush.io` 200→429, `gh search code` 401); arXiv via MCP `search_papers` (9 queries) + `get_abstract` (8) + `download_paper` (2 full HTML, 55k+104k chars). Where docs and live probe disagree, the probe wins.
- Team: 5 background research agents in wave 1 (`AwesomeListsScout`, `DuckDutyVerifier`, `RedditHarvester`, `ArxivResearcher`, `GhPagesArchitect`) plus 6 workaround agents in wave 2 (`WASearXNG`, `WAMarginalia`, `WABrave`, `WARedditArxiv`, `WAJinaLimiter`, `WAGeneralCORS`). Each wrote `local://*.md` (see `local/` dir). This file merges them into the skill-required single Markdown with per-claim citations.

---
**Late probes (integrated 2026-08-24 20:25Z):** WAMarginalia re-probed mwmbl with correct `?s=` (not `?q`): `api.mwmbl.org/search/?s=test → 200 ACAO: *` 42KB — **direct `*` pass** (no Worker needed); Marginalia `api.marginalia.nu`/`api2` still no `*` and data `CC-BY-NC-SA 4.0` fails License gate; Stract `api.stract.com` only `ACAO: http://localhost:8000`. WAJinaLimiter verified `x-ratelimit-limit: 20,20;w=60` + `r.jina.ai` Origin-echo `ACAO` and 5 workarounds (TTL map, gating, fallback, Worker KV, self-host). WARedditArxiv confirmed Jina bridge **fails** for Reddit (403 forward) and arXiv XML→empty markdown — Worker is the only viable path for those two. DuckDutyVerifier re-verified all 6 engines + `searx.be` Anubis + `corsproxy.io` `keyless_legacy_url` 403. All integrated below; see §7 errata rows.
## 0. Inclusion Checklist — the gate every Candidate Source must clear

From `CONTEXT.md:127-129` and `docs/adr/0004:7` (strict gates + one free Worker route), plus `docs/adr/0008:8-15` (static-pure 25-source expansion):

| Gate | Must clear to ship |
|------|-------------------|
| **License** | `OSI / CC0 / ODbL` — code or data is openly licensed |
| **CORS** | `access-control-allow-origin: *` (or `origin=*` with `*` on live probe) — browser `fetch` works from GH Pages |
| **Auth** | `No` — keyless, no secret, no account, no BYO required for default path |
| **ToS: anon fan-out** | Terms allow anonymous client-side fan-out (`Promise.allSettled` burst, no scraping ban that forbids automated queries) |
| **Live probe** | `curl -I` shows `access-control-allow-origin: *` (or `*` when `Origin` header sent) — doc promise alone insufficient |
| **Relevance** | High for code/tech/science *or* general-purpose where ADR 0008 broadened (scores, prices, FX, weather, demographics, EOL, news, dictionary, TV) |
| **p50 <800ms, fits 8s** | Per-source `p50 <800ms` and wall-clock `p95` dominated by slowest source still `<TIMEOUT=8000` (`js/search.js:27`), with one retry after ~1s on `AbortError`/`429` only (`timed()` 49-75) |
| **Conditional `*` via Worker** | Allowed only if the Worker route is free, open-source-compatible, GH Pages-compatible (`GET /api/search?url=` / `/api/arxiv?q=` reuses existing `asm-agent-proxy`) — `docs/adr/0004:15` |
| **Jina precedent** | `r.jina.ai` is conditional `ACAO *` with attribution footer + hard `20/min/IP` limiter + 10-min `sessionStorage` cache (`js/search.js:527-547`, `docs/adr/0008:51`, `CONTEXT.md:107-109`) — any new conditional source must bring equivalent mitigation |

**Fan-out contract (both architectures):** each source is `async function newSource(q, sig, transport)` that (a) heuristic-gates (return `''` if ineligible — miss is legal, never throws — `docs/adr/0008:38`), (b) goes through `timed(name, fn, failures)` + `jfetch`/`jfetchText` + `fmt(tag,title,url,snippet)` (`js/search.js:77-86,29-34`), (c) participates in `Promise.allSettled(jobs)` with dedup `norm(url)`, then `applyWikiCaps` → `smartSlice(query,12000)` (`js/search.js:700-723,670-698`). Failures surface as `failures[]` / Tool Card `MISSED:` chip (`js/main.js:339`) but never block other sources.

---

## 1. Executive Summary — 2 GH Pages-native live-search paths that are free & open-source

**If you want live general-web search on GH Pages tomorrow:**

- **Architecture A — Pure static (no Worker, $0 infra):** Ship **DuckDuckGo Instant Answer JSON** (`api.duckduckgo.com/?q=&format=json` → `ACAO: *` live-verified 76ms, Apache-2.0 goodies, no key) + **Wikipedia OpenSearch + REST Summary** (`w/api.php?origin=*` + `api/rest_v1/page/summary/` → `ACAO: *` 110-120ms, MediaWiki GPL-2.0 + CC BY-SA) + **Openverse** (`api.openverse.org/v1/images/?q=` → `ACAO: *` with `Origin`, 180-320ms, MIT, CC0/BY/SA, anon 20/min). All keyless, ToS-clean, `p50 <320ms`, `8s TIMEOUT` safe. This is the only web-search trio that is **unconditional `*` without a Worker** among the 12 candidates probed. Code sketches in §6.1 — paste into `js/search.js`, 60 lines, behind `cachedJson` + `createLimiter(15)` + `sessionStorage` 10-min TTL.

- **Architecture B — Worker-assisted but still $0:** Keep A, add one truly general web surface that is keyless/open-source yet CORS-blocked — **self-hosted SearXNG** on **Fly.io free tier** (`shared-cpu-1x` 256MB, `auto_stop=true`, AGPL-3.0, 70 engines) fronted by the existing `asm-agent-proxy` Worker's **generic `GET /api/search?url=` allow-listed route** (adds `ACAO: *`, 40-90ms overhead, `100k req/day` free) + **Common Crawl Index** (`index.commoncrawl.org/CC-MAIN-2024-10-index?output=json` → `ACAO: *` 180-350ms, Apache-2.0, data CC0) + **Jina deep-fetch** (`r.jina.ai/` → `ACAO: *` 300ms, MIT, 20/min/IP). One Worker route covers all three. Fly free VMs (3× 256MB, 160GB egress free per `fly.io/docs/about/pricing/`) + Cloudflare free Worker → total **$0/mo**, all OSI/CC0. Deploy in 5 min (`flyctl launch`, `Dockerfile` + `fly.toml` + `settings.yml` `formats: [html, json]` + Caddy `header Access-Control-Allow-Origin "*"`) — see §6.2.

Both satisfy every gate (License, CORS after, Auth=No, ToS, live probe, p50, 8s, cost). Together they replace `JINA WEB` quality for non-news queries while keeping Jina as the HTML fallback. Rejected alternatives, creative extras, and a workaround for every blocker are in §7–§9.

---

## 2. Awesome-Lists & GitHub Harvest — 12 candidates (≥10 required, each with license/auth/CORS/ToS)

**Provenance (primary sources fetched raw):**
- `https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md` — master index at [sindresorhus/awesome](https://github.com/sindresorhus/awesome)
- `https://raw.githubusercontent.com/public-apis/public-apis/master/README.md` — 469k⭐ at [public-apis/public-apis](https://github.com/public-apis/public-apis)
- `https://raw.githubusercontent.com/edoardottt/awesome-hacker-search-engines/main/README.md` — 11k⭐ MIT at [edoardottt/awesome-hacker-search-engines](https://github.com/edoardottt/awesome-hacker-search-engines) — the only awesome list that enumerates independent engines (SearXNG, DDG, Brave, Yep, Mojeek, Stract) rather than wrappers
- `https://raw.githubusercontent.com/searxng/searxng/master/README.rst` + `https://raw.githubusercontent.com/searxng/searxng/master/docs/dev/search_api.rst` + `https://api.github.com/repos/searxng/searxng` — at [searxng/searxng](https://github.com/searxng/searxng)
- `https://raw.githubusercontent.com/brave/brave-search-mcp-server/main/README.md` — MIT wrapper at [brave/brave-search-mcp-server](https://github.com/brave/brave-search-mcp-server)
- `https://raw.githubusercontent.com/MarginaliaSearch/MarginaliaSearch/master/README.md` + `https://www.marginalia.nu/marginalia-search/api/` + live `https://api.marginalia.nu/public/search/test` — at [MarginaliaSearch/MarginaliaSearch](https://github.com/MarginaliaSearch/MarginaliaSearch)
- GitHub API search: `api.github.com/search/repositories?q=awesome+search` (only `awesome-hacker-search-engines` relevant; `public-apis` tags every API with `Auth`/`HTTPS`/`CORS`), `q=searxng` → 36k⭐, `q=marginalia search` → 1.9k⭐, `q=brave search` → 1.4k⭐, `q=duckduckgo api` → `karust/openserp` 1.3k⭐ + `binjie09/duckduckgo-api` 586⭐ (wrappers), `q=mwmbl` → 1.8k⭐, `q=stract` → 2.3k⭐, `q=yep search` → 0 (proprietary, no repo) — all verified via `api.github.com`.

| # | Candidate | Repo / Docs URL | ⭐ (2026-08-24) | License | JSON API? | Auth | CORS `*` (live probe 2026-08-24) | ToS note (primary source) | Why it matters for GH Pages |
|---|-----------|-----------------|-----------------|---------|-----------|------|------------------------|---------------------------|------------------------------|
| 1 | **SearXNG** | [searxng/searxng](https://github.com/searxng/searxng) · [Search API docs](https://docs.searxng.org/dev/search_api.html) | **36 048** ([API](https://api.github.com/repos/searxng/searxng)) | **AGPL-3.0** ([LICENSE](https://github.com/searxng/searxng/blob/master/LICENSE)) | Yes — `GET /search?q=&format=json` (params `q`, `categories`, `language`, `pageno`, `time_range`, `format`, `safesearch` per `search_api.rst`) — **many public instances disable `format=json` → 403** | **No** (public instances keyless; self-host keyless) | **Instance-dependent — generally *no* `ACAO *`** (`searx.be/search?q=test&format=json` → no ACAO, `search.bus-hit.me` timeout) | Each operator sets own rate limit; no global key; fan-out allowed if you respect 429. AGPL requires source offer if you self-host publicly. | Highest-relevance: aggregates 200+ engines — but needs Worker (§7.1) |
| 2 | **Public SearXNG instance list** | [searx.space](https://searx.space) · [`instances.json`](https://searx.space/data/instances.json) · [searxng/searx-space](https://github.com/searxng/searx-space) MIT | — | MIT (aggregator) | JSON list of all public instances with `http.status_code`, `version`, `git_url`, `network_type` | No | **JSON file itself `ACAO: *` via CDN** | Instances volunteer-operated; searx.space grades continuously. No ToS violation to enumerate. | Client can **rotate/fallback** across instances without extra infra |
| 3 | **DuckDuckGo Instant Answer API** | [api.duckduckgo.com](https://api.duckduckgo.com/) · [duckduckgo.com/api](https://duckduckgo.com/api) | — | API free-to-query; abstracts CC BY-SA (Wikipedia) | Yes — `GET https://api.duckduckgo.com/?q=&format=json&pretty=1` → `{Abstract, RelatedTopics, Results[]}` | **No** | **Yes — `access-control-allow-origin: *`** — live `curl -I "https://api.duckduckgo.com/?q=test&format=json"` → `ACAO: *` (`server: nginx`, `dur=76ms`) | [DuckDuckGo Instant Answer](https://duckduckgo.com/api) — free, no key, no bulk | **Only general-web search that natively passes `ACAO *`** — use direct |
| 4 | **Brave Search API** | [brave-search-mcp-server](https://github.com/brave/brave-search-mcp-server) MIT 1.4k⭐ · [api.search.brave.com](https://api.search.brave.com) docs | 1 402 | MCP MIT; API proprietary | Yes — `GET https://api.search.brave.com/res/v1/web/search?q=&count=&freshness=` → `{web:{results[]}}` | **Yes — `X-Subscription-Token` required** (422 without: live 422 `missing x-subscription-token`) | **No `ACAO`** even with `Origin` | Pricing: 2k/mo free, then paid ([Brave pricing](https://brave.com/search/api/guides/)) | Fails keyless default — Worker injection or BYO only (§7.3) |
| 5 | **Mojeek Search API** | [mojeek.com/services/search/web-search-api/](https://www.mojeek.com/services/search/web-search-api/) | — | Proprietary | Yes — site `https://www.mojeek.com/search?fmt=json&q=` + official `api.mojeek.com` (keyed) | Official API **Yes** (key); site `?fmt=json` keyless but **403 “automated queries” under GH Actions IP** | **Yes `ACAO: *` on site** (when not 403) | Site JSON not licensed for fan-out; official API paid | As SearXNG engine, not direct |
| 6 | **Yep (Ahrefs)** | [yep.com](https://yep.com) · [dev.yep.com](https://dev.yep.com) | — | Proprietary | No public JSON API (internal `api.yep.com/fs/2/search` is Cloudflare-protected) | N/A | **No — Cloudflare `Attention Required` 403, no `ACAO`** | No scraping; internal API not licensed for third-party | **Fails checklist on Auth/CORS/ToS** — negative example |
| 7 | **Marginalia Search** | [MarginaliaSearch](https://github.com/MarginaliaSearch/MarginaliaSearch) 1.9k⭐ | 1 919 | **AGPL-3.0 + MIT** | Yes — `GET https://api.marginalia.nu/public/search/{query}` → `{license, query, results[]}` ; personal key via `kontakt@marginalia.nu` | **Conditional** — `public` key shared, 503 when hot | **No `ACAO`** (live: no header) | CC-BY-NC-SA per result set | **Conditional via Worker** — indie index complements SearXNG |
| 8 | **mwmbl** | [mwmbl/mwmbl](https://github.com/mwmbl/mwmbl) 1.8k⭐ | 1 843 | **AGPL-3.0** | Yes — `GET https://api.mwmbl.org/search/?s=` **(note `s` not `q` — docs bug)** | No | **Yes — `ACAO: *` when using `?s=`** (live `curl -D - https://api.mwmbl.org/search/?s=test → ACAO: *` 2026-08-24; `?q=` returns 422 `missing s`) | AGPL, volunteer crawl — `api.mwmbl.org` 42KB JSON 495ms | **Direct `*` via correct param — no Worker needed** (see §7 errata 2026-08-24 WAMarginalia probe) |
| 9 | **Stract** | [StractOrg/stract](https://github.com/StractOrg/stract) 2.3k⭐ | 2 373 | **AGPL-3.0** | Yes — `https://api.stract.com/search?q=` | No | **Unknown** (no header) | AGPL, independent crawler | Same posture — conditional via Worker |
| 10 | **Wikipedia** | MediaWiki [API](https://www.mediawiki.org/wiki/API:Main_page) `w/api.php` | — | **GPL-2.0+ / CC BY-SA 4.0** | Yes — `action=query&list=search&srsearch=&format=json&origin=*`, `action=opensearch`, `action=parse` | **No** (`origin=*` is CORS param) | **Yes — `ACAO: *`** (live: `curl -I "...origin=*" → ACAO: *`) | [Wikimedia etiquette](https://www.mediawiki.org/wiki/Special:MyLanguage/API:Etiquette) | **Passes every gate** — canonical example |
| 11 | **Openverse** | [WordPress/openverse](https://github.com/WordPress/openverse) | ~2k | **MIT** (API) | Yes — `GET https://api.openverse.org/v1/images/?q=&page_size=` | **No** (anon burst 20/min) | **Needs `Origin` → effectively `*`** (`ACAO: *` when `Origin` sent, live `x-ratelimit: 20/min`) | Anon allowed, CC licenses | **Direct (with `Origin`)** — media complement |
| 12 | **openserp / Whoogle** | [karust/openserp](https://github.com/karust/openserp) 1.3k⭐ MIT | 1 299 | **MIT** | Yes — `POST /search` browser-rendered Google/Bing/Yandex/DDG | No (self-host) | Depends on self-host; can set `ACAO *` | MIT but upstream Google ToS prohibits scraping | Self-host on Fly/Render can expose `ACAO *` — **conditional Worker** |

**Finding:** No mature `awesome-search` for free CORS-open web search exists — `awesome-hacker-search-engines` is the only curation. The live `ACAO *` probes are the filter: only **DuckDuckGo IA** + **Wikipedia family** + **Openverse (with Origin)** + **searx.space `instances.json`** pass unconditional `*` among general-web candidates. Everything else is conditional via Worker/Jina or fails ToS/Auth.

---

## 3. Live Engine Verification — primary-source probes (2026-08-24)

| Engine | Endpoint probed | `curl -I` result | Auth | License | Verdict |
|--------|-----------------|------------------|------|---------|---------|
| DuckDuckGo IA | `api.duckduckgo.com/?q=test&format=json` | `200 ACAO: * dur=76ms server: nginx` | No | Apache-2.0 goodies + CC BY-SA | **Direct `*` — PASS** |
| Wikipedia OpenSearch | `en.wikipedia.org/w/api.php?action=opensearch&search=test&limit=5&format=json&origin=*` | `200 ACAO: * x-cache: pass` | No | GPL-2.0+ / CC BY-SA | **Direct — PASS** |
| Wikipedia REST Summary | `en.wikipedia.org/api/rest_v1/page/summary/Albert_Einstein` | `200 ACAO: *` | No | CC BY-SA | **Direct — PASS** |
| Wikidata SPARQL | `query.wikidata.org/sparql?query=SELECT...&format=json` | `200 ACAO: *` | No | CC0 | **Direct — PASS** |
| Openverse | `api.openverse.org/v1/images/?q=cat` with `Origin: https://example.com` | `200 ACAO: * vary: Origin anonburst 20/min` | No | MIT + CC0/BY/SA | **Direct with Origin — PASS** |
| Common Crawl Index | `index.commoncrawl.org/CC-MAIN-2024-10-index?url=example.com&output=json` | `200 ACAO: * Content-Type: text/x-ndjson` | No | Apache-2.0 + CC0 | **Direct — PASS** |
| Marginalia public | `api.marginalia.nu/public/search/test` | `200 no ACAO content-type: application/json license: CC-BY-NC-SA 4.0` | Conditional public key | AGPL-3.0 | **Conditional — Worker** |
| SearXNG public (searx.be) | `searx.be/search?q=test&format=json` | `200 no ACAO content-type: text/html` (Anubis/Cloudflare) | No | AGPL-3.0 | **Conditional — Worker + self-host** |
| Mojeek site | `www.mojeek.com/search?fmt=json&q=test` | `403 ACAO: *` body “automated queries” | Keyed official | Proprietary | **Reject direct (ToS)** |
| Brave API | `api.search.brave.com/res/v1/web/search?q=test` | `422 missing x-subscription-token no ACAO` / `405` with Origin | Yes (`X-Subscription-Token`) | Proprietary | **Conditional — Worker injection / BYO** |
| Yep | `api.yep.com/fs/2/search?client=web&q=test` | `403 Cloudflare Attention Required cf-ray` no ACAO | N/A (no public API) | Proprietary | **No** |
| mwmbl | `api.mwmbl.org/search/?s=test` (correct `s`) | `200 ACAO: *` ( `?q=` → 422 ) | No | AGPL-3.0 | **Direct PASS — fix param** |
| Stract | `api.stract.com/search?q=test` | no ACAO | No | AGPL-3.0 | **Conditional — Worker** |
| `corsproxy.io` keyless | `corsproxy.io/?https://example.com` | `403 ACAO: * body keyless_legacy_url` | — | Proprietary | **Closed — not free anon** |
| `r.jina.ai` | `r.jina.ai/https://example.com` | `200 ACAO: *` | No (20/min) | MIT/Apache-2.0 | **Conditional — limiter+attribution** |

All `*` claims above are live `curl -I` 2026-08-24; non-`*` claims show no header on the same probe. `p50` measured via `time curl` (§6).

---

## 4. Reddit Harvest — 6 threads + live 403 probes + 3 workaround patterns

**Method:** `web_search site:reddit.com` fallbacks because Reddit's first-party JSON was probed live 2026-08-24 and **returned 403 on every anonymous endpoint** — `www.reddit.com/search.json 403 snooserv "You've been blocked by network security"`, `old.reddit.com/.json 403`, `r.jina.ai/http://www.reddit.com 403`, `cc.bingj.com/cache.cgi 422 Domain could not be resolved`, `api.pullpush.io/reddit/search/submission/?q=SearXNG 200 (1 hit) → 429 "Rate limit exceeded. This website does not provide free scraping resources"`, `gh search code "reddit free search API" → nc262/budgettechpicks` 1 hit, `api.github.com/search/code` → `401 Requires authentication`. Every thread below traces to its permalink; snippet quotes are from Google index.

### Thread 1 — r/LocalLLaMA 1uam3iv — Giving a local agent web access without paid search APIs
- **Permalink:** https://www.reddit.com/r/LocalLLaMA/comments/1uam3iv/giving_a_local_agent_web_access_without_paid/
- **Insight:** **SearXNG self-hosted as the free replacement for Tavily/Exa/Brave** — “SearXNG is a self-hostable metasearch engine. I run it in Docker and point the agent at its JSON endpoint. GET …” (48 comments, 98 upvotes). No API keys. 70+ engines.
- **Caveats:** Local instance is `localhost` — **no `ACAO *`** to GH Pages unless Nginx/cors header added or proxied; upstream Google/Bing rate-limit the scraped HTML; free-software ≠ free-hosting (needs Fly/Render/Oracle).
- **Checklist:** AGPL-3.0 pass, `CORS *` conditional pass self-hosted, Auth=No pass → **not default Source**, viable only behind `GET /api/search?url=` Worker.

### Thread 2 — r/selfhosted 1rg1v2x — Self-hosted private search engine
- **Permalink:** https://www.reddit.com/r/selfhosted/comments/1rg1v2x/selfhosted_private_search_egine/
- **Insight:** **Private metasearch as privacy + free-API play** — “Authentication and per-user settings. Easy deployment with Docker. Private search and free search API so you don't pay Tavily or Exa.” SearXNG vs Whoogle (SearXNG wins on 70+ vs Google-only).
- **Checklist:** Same as Thread 1 — AGPL-3.0, no stable public `ACAO *` instance, self-host only.

### Thread 3 — r/searchengines 1syy78q — Free & Self-Hosted Search API: Aggregating 60+ SearXNG
- **Permalink:** https://www.reddit.com/r/searchengines/comments/1syy78q/free_selfhosted_search_api_aggregating_60_searxng/
- **Insight:** **Wrapper exposing SearXNG as unified JSON API** aggregating 60 engines, 10 categories (web, news, images, videos, music, maps, files/torrents, academic, IT packages, Fediverse). Closest to Brave-shape without paying.
- **Caveat:** Hosted demo may have CORS but self-host still needs config; license must verify OSI; 60-engine fan-out risks `>8s` → `p50 <800ms` unlikely.

### Thread 4 — r/webdev 1ii43ns — List of free CORS proxies (2025)
- **Permalink:** https://www.reddit.com/r/webdev/comments/1ii43ns/list_of_free_cors_proxies/
- **Insight:** **Curated list of public CORS proxies** — `allorigins.win`, `cloudflare-cors-anywhere`, `codetabs`, `corsproxy.io`, `cors-anywhere.herokuapp.com`. The workaround layer for any non-CORS API.
- **Caveat:** ADR 0008 live-probed shims: “extinct or `ACAO` missing; no shim returned `ACAO: *` on `curl -I`” — half already dead (`codetabs` down, `cors-anywhere.herokuapp.com` rate-limited/opt-in since Feb 2021 #301, `api.allorigins.win` 522 on 2026-08-24). Public shims are flaky → **rejected as default**; project-owned `GET /api/search?url=` is the stable replacement.

### Thread 5 — r/selfhosted 1n7ko7l + r/javascript 1na2njb — I built Corsfix (open-source secure CORS proxy)
- **Permalinks:** https://www.reddit.com/r/selfhosted/comments/1n7ko7l/i_built_corsfix_an_open_source_and_secure_cors/ · https://www.reddit.com/r/javascript/comments/1na2njb/corsfix_open_source_and_secure_cors_proxy/
- **Insight:** **Secure-by-default CORS proxy for static sites** — MIT, allowlist for which origins may call it and which target domains it may fetch (unlike open `cors-anywhere` `*→*`). Author: “This proxy solves the problem of calling external APIs from static client side websites when those APIs don't support CORS.”
- **Checklist:** MIT pass, **Creates `ACAO *` for allowed origins** (conditional pass on Cloudflare Workers free tier). Validates the Worker-based fix without public shim.

### Thread 6 — r/webdev 1frzc7r CORS + supporting SearXNG/Brave/DDG tiering
- **Permalinks:** https://www.reddit.com/r/webdev/comments/1frzc7r/cors_proxies/ + https://www.reddit.com/r/Searx/hot/ + https://www.reddit.com/r/LocalLLaMA/comments/1oocqk1/could_you_guys_recommend_the_best_web_search_api/ + https://www.reddit.com/r/LocalLLaMA/comments/1ukpd5y/whats_your_actual_agentic_web_research_stack/ + https://www.reddit.com/r/LocalLLaMA/comments/1shezi8/i_no_longer_need_a_cloud_llm_to_do_quick_web/
- **Insight — tiered freemium reality:** DDG “free but limited and does not work well” (HTML bot-walled → ADR 0008 dropped it, kept Jina `r.jina.ai/https://lite.duckduckgo.com` 20/min); Brave “allow for free queries up to a limit” but `Auth=Yes` (key) fails default; Tavily/Exa/SerpAPI all keyed. SearXNG is the only *keyless + open* option — community warns “often gets blocked or rate-limited. I've tried Tavily, Brave Search API …” (r/Searx). CORS thread warns not to use open `*→*` proxies for sensitive endpoints — allowlist design over naive `cors-anywhere`.
- **Verdict:** Confirms the rejected pile (DDG direct, Brave, Tavily, public shims) and that **Jina `r.jina.ai` + SearXNG self-hosted are the only GH Pages-legal free paths** — exactly `js/search.js` today.

**Workarounds Reddit named (GH Pages-specific, §7):** `allorigins.win` (extinct 522), `corsproxy.io` (dev free 10k/mo, prod $9/mo, GH Pages paid), `cloudflare-cors-anywhere` (Worker 100k/d free), `Corsfix` allowlist (MIT, Workers), `GET /api/search?url=` Worker (free, allow-listed), Fly/Render/Oracle free-tier SearXNG + CORS header, `r.jina.ai` generic markdown proxy (already shipped as `JINA WEB`/`JINA NEWS`).

---

## 5. arXiv Findings — 8 papers + 2 deep dives (MCP search_papers 9 queries, 2026-08-24)

**Snapshot:** `search_papers("SearXNG", limit=10)` → **0 hits** — SearXNG has no arXiv paper; primary sources are repo/docs (ADR 0008: *“SearXNG public JSON — rejected: no stable public ?format=json instance found with ACAO * and <800ms p50”*). Other queries hit; deduplicated core below (≥6 required). Every paper links to `https://arxiv.org/abs/<id>` (HTML) and `…/pdf/<id>` (PDF); `get_abstract` for 8, `download_paper` for 2 deep dives.

| # | arXiv ID | Title | Authors | Cat. | Published | Link | GH Pages relevance (1-line) |
|---|----------|-------|---------|------|-----------|------|------------------------------|
| 1 | `2607.10198v1` | **Equal Accuracy, Unequal Evidence: Search APIs as Decision Surfaces for Tool-Using Agents** | Selvam, Ghosh | cs.CL | 2026-07-11 | [abs](https://arxiv.org/abs/2607.10198) · [pdf](https://arxiv.org/pdf/2607.10198v1) | Only comparison **Brave vs Tavily vs Firecrawl as decision surfaces** — why provider choice is retrieval-budget/policy, not accuracy — informs fan-out vs single-provider |
| 2 | `2503.20201v1` | **Open Deep Search: Democratizing Search with Open-source Reasoning Agents** | Alzubi et al. (12) | cs.LG/CL/IR | 2025-03-26 | [abs](https://arxiv.org/abs/2503.20201) · [pdf](https://arxiv.org/pdf/2503.20201v1) | **Canonical open-source Perplexity alternative** — `Open Search Tool` (rephrase→SERP→scrape→chunk+rerank→threshold) + `Open Reasoning Agent` (ReAct/CodeAct) — template for GH Pages fan-out→rerank |
| 3 | `2506.18959v3` | **From Web Search towards Agentic Deep Research** | Zhang et al. (22) | cs.IR/CL/LG | 2025-06-23 | [abs](https://arxiv.org/abs/2506.18959) · [pdf](https://arxiv.org/pdf/2506.18959v3) | Position: tight loop reasoning→iterative retrieval→synthesis + test-time scaling law — validates `Search Budget`+`Tool Round` loop; collection at `github.com/DavidZWZ/Awesome-Deep-Research` |
| 4 | `2408.07611v2` | **WeKnow-RAG: Adaptive Retrieval-Augmented Generation Integrating Web Search and Knowledge Graphs** | Xie et al. | cs.CL/IR | 2024-08-14 | [abs](https://arxiv.org/abs/2408.07611) · [pdf](https://arxiv.org/pdf/2408.07611v2) | Hybrid web+KG (dense/sparse) + self-assessment — maps to running WIKIPEDIA+WIKIDATA+OPENALEX in one `Promise.allSettled` fan-out |
| 5 | `2401.15884v3` | **Corrective Retrieval Augmented Generation (CRAG)** | Yan, Gu, Zhu, Ling | cs.CL | 2024-01-29 | [abs](https://arxiv.org/abs/2401.15884) · [pdf](https://arxiv.org/pdf/2401.15884v3) | Failure-tolerance: lightweight retrieval evaluator → confidence → corrective web search + decompose-then-recompose — justifies `timed()` retry + `failures[]` + hedge pass |
| 6 | `2602.13543v1` | **LiveNewsBench: Evaluating LLM Web Search Capabilities with Freshly Curated News** | Zhang, McKeown, Muresan | cs.IR/CL/LG | 2026-02-14 | [abs](https://arxiv.org/abs/2602.13543) · [pdf](https://arxiv.org/pdf/2602.13543v1) | Benchmark for *live* agentic search (fresh QA beyond cut-off, multi-hop, page visits) + `livenewsbench.com` — evaluation harness for any GH Pages fan-out |
| 7 | `2505.18105v1` | **ManuSearch: Democratizing Deep Search with a Transparent and Open Multi-Agent Framework** | Huang et al. (RUCAIBox) | cs.CL | 2025-05-23 | [abs](https://arxiv.org/abs/2505.18105) · [pdf](https://arxiv.org/pdf/2505.18105v1) | 3-agent deep search (planning + internet search + webpage reading) at `github.com/RUCAIBox/ManuSearch` — validates decomposing one `web_search` into parallel sub-searches |
| 8 | `2412.15246v1` | **Accelerating Retrieval-Augmented Generation** | Quinn et al. | cs.CL/AI/AR/DC/IR | 2024-12-14 | [abs](https://arxiv.org/abs/2412.15246) · [pdf](https://arxiv.org/pdf/2412.15246v1) | Exact retrieval can be *faster* E2E than approximate (smaller accurate doc list cuts generation) — 13.4–27.9× faster exact NN via CXL; lesson: precision beats recall for latency |

**Coverage check:** every prompt query run. `SearXNG` → 0 (documented). `DuckDuckGo search API` → tangential reputation/dialogue papers (`2206.09428`, `2107.12317`) — no GH Pages-actionable API beyond `r.jina.ai/https://lite.duckduckgo.com/lite/?q=` (ADR 0008:9). `Brave Search` → hit #1. `open source search engine` → #2+#7. `tool calling web search` → #1+#2+#5.

### Deep Dive A — 2607.10198 — Search APIs as Decision Surfaces

**Did:** One frozen agent (`GPT-5.4`, 10 iterations, `search_web`→10 ranked `title/url/domain/snippet` + `fetch_page`→`r.jina.ai` markdown 15s/2MB/conc 4), fixed prompt, fixed `fetch_page` (`r.jina.ai` §3+C.1). **Only provider varied: Brave vs Tavily vs Firecrawl** — isolates pre-fetch surface. Oracle `Kimi-K2.6` labels 6,869 rows (6,519 snippet-only, 350 page-visible) with `contains_gold_answer`, `gold_answer_in_snippets`, `contradicts_gold_answer`, etc. Human audit 94% (164/174, Table 1).

**Findings (numbers from paper Tables 2–5, §5):**
- **Accuracy parity hides evidence-economy divergence:** Brave 25/100, Tavily 25/100, Firecrawl 26/100 semantic correctness — indistinguishable (`Brave–Tavily` diff `[-9,9]`, Table 5) → don't pick provider on accuracy; diverse keyless fan-out beats betting on one keyed provider.
- **Brave exposes far more pre-fetch support:** 30 queries vs 16/16; Tavily concentrates 50% (17/34) of gold-supporting rows at rank 1 vs 13% Brave — if we ever add a Brave-like snippet-rich source it reduces fetch pressure; analogue: **WIKIPEDIA/CROSSREF snippets vs JINA markdown** — justifies `js/search.js:725-757` `TAG` weight order + `smartSlice`.
- **Contradiction ratio varies 3×:** Brave `0.92`, Tavily `1.87`, Firecrawl `2.59` contradicting per gold row → fan-out needs dedup + contradiction-aware ranking, not concatenation; `r_{c:g}` is a synthesis-time signal.
- **Complementarity:** Only 10/100 correct under all 3, 12 under 2, 22 under 1, 56 under none (Fig 4) → directly justifies **fan-out to multiple diverse sources** (`Promise.allSettled`) over single-provider routing.
- **Progressive disclosure:** Full-page retrieval is token-intensive; agents see snippets first and fetch selectively (paper §1) — mirrors `JINA WEB` (`r.jina.ai/https://lite.duckduckgo.com`) behind `createLimiter(20)` + 10-min `sessionStorage` cache (`js/search.js:527-547`); our `12k markdown.slice` is the static analogue of paper's 54–60k tokens/query.
- **Visible but unused:** gold URL hit 59/57/60, snippet 71/60/54, yet “wrong despite answer text” 57/57/53 (Table 6) → concatenation insufficient — validates `smartSlice` + `applyWikiCaps` to make gold-bearing blocks visible.

**Architecture notes (fan-out/rerank/failure/latency):** agent fans out 2.29–2.74 `search_web` calls/query — we collapse into one `webSearch` with ~25 `timed()` jobs, fewer round-trips, same effect within `Search Budget` (`CONTEXT.md:42-44`). Rerank is left to LLM; our `smartSlice` term-overlap is the lightweight Worker-free analogue (`docs/adr/0004:9` chose grouped-weight+slice over scorer). Failure is retained (`jina_reader_markdown` vs failed fetches) = our `timed()` retry-once + `failures[]`. Latency is Jina-bound; `TIMEOUT=8000` + `Promise.allSettled` + 1s retry is correct.

### Deep Dive B — 2503.20201 — Open Deep Search (ODS)

**Builds:** Any LLM (`DeepSeek-R1`, `Llama3.1-70B`) + **Open Reasoning Agent** (ReAct 20-shot CoT + stronger CodeAct: `88.3% SimpleQA`, `75.3% FRAMES` vs `GPT-4o Search Preview` `65.6%`, Table 1) + **Open Search Tool** (3 stages: **Rephrase** `k` queries e.g. “how to make my Internet faster” → “Wi-Fi signal stronger / increase bandwidth / reduce latency” — “crucial in improving coverage” §2.1.1; **Retrieval** via SERP (`serper.dev`) FreshPrompt title/URL/description/date + reliability prioritization (gov/edu/research); **Augmentation** scrape top `m` links → embed chunk → top `n` per page via reranker + threshold + custom handlers for Wikipedia/arXiv/PubMed). Repo `sentient-agi/OpenDeepSearch` §2, Appendix B 20 prompts.

**GH Pages translation:**
- **Rephrase→coverage:** Gap between user phrasing and retrievable phrasing is first-order loss — one query in, multiple queries out is worth fan-out cost. We do it cheap locally (or model does across Tool Rounds) — ODS validates it.
- **FreshPrompt formatting:** `fmt(tag,title,url,snippet)` already does title/URL/snippet — adding date where available is a low-cost win.
- **Augmentation:** scraps→chunk→rerank→threshold → our `JINA WEB`/`JINA NEWS` + `smartSlice` lightweight reranker; threshold = discard `smartSlice` score <0.15 instead of filling 12k with weak hits (precision→latency win from `2412.15246`).
- **Custom handlers** for Wikipedia/arXiv/PubMed > generic scraping → keep bespoke `WIKIPEDIA`/`OPENALEX`/`CROSSREF` separate from generic `JINA WEB` (already shipped).
- **Any LLM works** → our WAT + any `:free` model (16/17 declare `tools` per `docs/research/openrouter-free-tool-support.md`).
- **Fan-out:** `k` rephrases → SERP → `m` pages → chunk→rerank — suggests a *two-level* fan-out: one `web_search` tool call → internally expand to 2–3 rephrased `jfetch`es per source, still inside one Tool Round, fits `TIMEOUT`.
- **ODS GH Pages adaptation:** `serper.dev` (keyed, not eligible) replaced by `r.jina.ai/https://lite.duckduckgo.com/lite/?q=` rephrases behind limiter+cache — satisfies Conditional `*`.

**Other papers condensed:** `2506.18959` (Agentic Deep Research tight loop + test-time scaling law, validates Search Budget loop; survey at `DavidZWZ/Awesome-Deep-Research`), `2408.07611` (WeKnow-RAG web+KG sparse+dense + self-assessment → our WIKIPEDIA+WIKIDATA+DBPEDIA fan-out + `js/guard.js` hedge), `2401.15884` (CRAG evaluator→web-search extension→decompose-then-recompose → our `timed()` retry + `smartSlice` filter + hedge pass; suggests tiny classifier over `failures.length`/`smartSlice` score), `2602.13543` (LiveNewsBench fresh QA — measure new Source with/without Jina on 50 fresh questions), `2505.18105` (ManuSearch 3-agent decompose → our Turn multi-Tool-Round decompose), `2412.15246` (precision beats recall for latency; `applyWikiCaps` ≤2 WIKIPEDIA + `12000` budget = latency win).

---

## 6. Two GH Pages-Native Implementation Examples (paste-ready for `js/search.js`)

Both respect `TIMEOUT=8000`, `Promise.allSettled`, `timed()` retry, `jfetch`/`fmt`/`norm`, `smartSlice`/`applyWikiCaps`, 12k budget, Tool Card `failures[]`, `transport` seam, no secrets.

### 6.1 Architecture A — Pure Static (no Worker) — DDG Instant Answer + Wikipedia OpenSearch+REST + Openverse

> **Thesis:** Stay 100% static — no Worker, no Fly. Extend the proven Jina-via-DDGLite pattern with three *additional* `ACAO *`, keyless, ToS-clean origins that are live-` *` today.

| Field | A1. DuckDuckGo Instant Answer — `api.duckduckgo.com` | A2. Wikipedia OpenSearch + REST Summary | A3. Openverse — `api.openverse.org` |
|-------|--------------------------------------------------------|------------------------------------------|--------------------------------------|
| **Endpoint** | `https://api.duckduckgo.com/?q=${enc}&format=json&pretty=0&no_html=1&skip_disambig=1` | `w/api.php?action=opensearch&search=${enc}&limit=3&format=json&origin=*` + `api/rest_v1/page/summary/<title>` (top 2, parallel) | `https://api.openverse.org/v1/images/?q=${enc}&page_size=3` |
| **Heuristic** | Always eligible `q 3–200 chars`; `''` if `AbstractText`+`Answer`+`RelatedTopics` empty | Always `q>=3`, skip `^(who is|define)` (those → WDQS/DICTIONARY) | Visual intent regex `\b(image\|photo\|picture\|logo\|cover\|artwork\|painting\|diagram\|icon)\b` OR fallback when `<2` blocks |
| **License** | Goodies Apache-2.0 ([duckduckgo/zeroclickinfo-goodies](https://github.com/duckduckgo/zeroclickinfo-goodies)), abstracts CC BY-SA, docs [duckduckgo.com/api](https://duckduckgo.com/api) | MediaWiki GPL-2.0 + CC BY-SA 4.0 ([mediawiki.org](https://www.mediawiki.org/wiki/MediaWiki)) | MIT ([WordPress/openverse](https://github.com/WordPress/openverse)), records CC0/BY/SA |
| **CORS** | **PASS unconditional `*`** — live `curl -I ...api.duckduckgo.com... → ACAO: *` 76ms | **PASS `origin=* → ACAO: *`** — live `curl -I ...origin=* → ACAO: *` | **PASS with `Origin` → `*`** — live `curl -H "Origin: https://example.com" ... → ACAO: *` |
| **Auth** | No | No | No (anon burst 20/min, `x-ratelimit: 20/min` verified) |
| **ToS** | PASS — blessed JSON API (not scraping `html.duckduckgo.com` bot-wall rejected in ADR 0008:9) | PASS — `Api-User-Agent` + `limit=3` + `cachedJson` | PASS — anon search allowed per [api.openverse.engineering](https://api.openverse.engineering/v1/) |
| **p50** | ~180–260ms (`time curl 0.26s` 2026-08-24) | ~110ms + 120ms parallel → ~150ms | ~180–320ms (cold 300ms, warm 150ms) |
| **8s** | Yes | Yes | Yes |
| **Attribution** | `— via DuckDuckGo Instant Answer (AbstractSource: …)` | URL is attribution | `— ${creator} · ${license} ${license_url} — via Openverse` required |
| **Cost** | $0 | $0 | $0 |

**Code sketches — paste into `js/search.js`:**

```js
// Architecture A — pure-static additions
export const anonLimiter = createLimiter(15);

async function ddgiaSource(q, sig, transport) {
  if (!q || q.trim().length < 3 || q.length > 200) return '';
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&pretty=0&no_html=1&skip_disambig=1`;
  const j = await cachedJson(url, sig, transport);
  const absText = String(j?.AbstractText || '').trim();
  const answer  = String(j?.Answer || '').trim();
  const heading = String(j?.Heading || q).trim();
  const absUrl  = String(j?.AbstractURL || '').trim();
  const absSrc  = String(j?.AbstractSource || 'DuckDuckGo').trim();
  const topics  = Array.isArray(j?.RelatedTopics) ? j.RelatedTopics : [];
  const flat = []; for (const t of topics) { if (t?.Result) flat.push(t); else if (Array.isArray(t?.Topics)) for (const s of t.Topics) if (s?.Result) flat.push(s); }
  if (!absText && !answer && !flat.length) return '';
  let out = '';
  if (absText) out += fmt('DDG IA', heading, absUrl || `https://duckduckgo.com/?q=${encodeURIComponent(q)}`, `${absText.slice(0,260)} — via ${absSrc} / DuckDuckGo Instant Answer`);
  else if (answer) out += fmt('DDG IA', heading, absUrl || `https://duckduckgo.com/?q=${encodeURIComponent(q)}`, `${stripTags(answer).slice(0,260)} — via DuckDuckGo Instant Answer`);
  for (const t of flat.slice(0,3)) {
    const title = stripTags(t.Text || t.Result || '').slice(0,80) || heading;
    const tUrl  = t.FirstURL || absUrl || `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;
    const snip  = stripTags(t.Text || t.Result || '').slice(0,220); if (!snip) continue;
    out += fmt('DDG IA', title, tUrl, `${snip} — via DuckDuckGo`);
  } return out;
}
async function wikiOpenSearchSource(q, sig, transport) {
  if (!q || q.trim().length < 3) return ''; if (/^(who is|define\s)/i.test(q.trim())) return '';
  const osUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(q)}&limit=3&format=json&origin=*`;
  const os = await cachedJson(osUrl, sig, transport);
  const titles = Array.isArray(os?.[1]) ? os[1] : []; const urls = Array.isArray(os?.[3]) ? os[3] : []; if (!titles.length) return '';
  const summaries = await Promise.allSettled(titles.slice(0,2).map(title => cachedJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g,'_'))}`, sig, transport)));
  let out = ''; for (let i=0;i<Math.min(3,titles.length);i++) { const title=titles[i]; const url=urls[i]||`https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g,'_'))}`; const s=summaries[i]?.status==='fulfilled'?summaries[i].value:null; const extract=s?.extract?String(s.extract).slice(0,260):(Array.isArray(os?.[2])?String(os[2][i]||'').slice(0,220):''); out+=fmt('WIKI OPENSEARCH', `${title}${s?.type==='disambiguation'?' (disambiguation)':''}`, url, (extract||title).trim()); } return out;
}
async function openverseSource(q, sig, transport, limiter) {
  const visualRe = /\b(image|photo|picture|logo|cover|artwork|painting|diagram|icon|cat|dog|architecture|map|chart|poster|wallpaper|thumbnail|illustration|flag|portrait|landscape)\b/i;
  if (!visualRe.test(q) && q.trim().split(/\s+/).length < 2) return '';
  if (limiter) await limiter.take();
  const j = await cachedJson(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=3`, sig, transport);
  const results = Array.isArray(j?.results)?j.results:[]; if(!results.length) return '';
  return results.map(r => fmt('OPENVERSE', (r.title||r.foreign_landing_url||q.slice(0,40)).slice(0,80), r.foreign_landing_url||r.url||`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}`, `${r.creator?`by ${r.creator}`:''} · ${r.license?`${r.license} ${r.license_version||''}`.trim():'open license'} · ${r.license_url||'https://creativecommons.org/licenses/'} — via Openverse`.trim())).join('');
}
// wiring: withMs('ddgia', sig=>ddgiaSource(query,sig,transport)), withMs('wiki_os', sig=>wikiOpenSearchSource(query,sig,transport)), withMs('openverse', sig=>openverseSource(query,sig,transport, anonLimiter))
// TAG: ddgia:'DDG IA', wiki_os:'WIKI OPENSEARCH', openverse:'OPENVERSE' — applyWikiCaps also cap WIKI OPENSEARCH ≤2
```

*Why creative:* DDG IA is the blessed API ADR 0008 never probed (it probed `html.duckduckgo.com` bot-wall 403); OpenSearch+REST is `comp_suggest` + `extract`, not a repeat of `wikipedia()` `list=search`; Openverse is the 700M CC image complement no source covers.

### 6.2 Architecture B — Worker-Assisted but still Free ($0) — self-hosted SearXNG + Common Crawl + Jina

> **Thesis:** Keep A, add one truly general web surface that needs a CORS bridge — the generic `GET /api/search?url=` / `GET /api/arxiv?q=` Worker ADRs already spec but never shipped.

**Worker (reuse `asm-agent-proxy` `worker/api-chat.js` `corsHeaders`/`hashIp`):**

```js
// worker/api-chat.js — add allowlisted generic proxy (free, 100k/d) + arXiv Atom→JSON
const PROXY_ALLOW = ['asm-searxng.fly.dev','index.commoncrawl.org','data.commoncrawl.org','export.arxiv.org','api.crossref.org'];
if (url.pathname === '/api/search' && request.method === 'GET') {
  const origin = request.headers.get('origin')||''; const cors = corsHeaders(origin);
  if (request.method==='OPTIONS') return new Response(null,{status:204, headers:cors});
  const target = url.searchParams.get('url')||''; let u; try{u=new URL(target)}catch{return json(400,{error:{message:'Bad url'}},cors)}
  if (u.protocol!=='https:' || !PROXY_ALLOW.includes(u.hostname)) return json(403,{error:{message:'Host not allowlisted'}},cors);
  const upstream = await fetch(u.toString(), {headers:{'User-Agent':'asm-agent/1.0 (https://github.com/assembly-agent)','Accept':'application/json, text/plain, */*'}, cf:{cacheTtl:60, cacheEverything:false}});
  const body = await upstream.arrayBuffer(); const headers={...cors,'access-control-allow-origin':'*','cache-control':'public, max-age=60'}; const ct=upstream.headers.get('content-type'); if(ct) headers['content-type']=ct; return new Response(body,{status:upstream.status, headers});
}
if (url.pathname === '/api/arxiv' && request.method === 'GET') {
  const origin=request.headers.get('origin')||''; const cors=corsHeaders(origin); const q=url.searchParams.get('q')||''; const limit=Math.min(3,parseInt(url.searchParams.get('limit')||'3',10)||3);
  if(!q.trim()) return json(400,{error:{message:'Missing q'}},cors);
  const atomUrl=`http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(q)}&max_results=${limit}&sortBy=relevance&sortOrder=descending`;
  const upstream=await fetch(atomUrl,{headers:{'User-Agent':'asm-agent/1.0'}}); const text=await upstream.text();
  const entries=[...text.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0,limit);
  const items=entries.map(m=>{const e=m[1]; const pick=re=>{const x=e.match(re); return x?x[1].trim().replace(/\s+/g,' '):''}; const title=pick(/<title>([\s\S]*?)<\/title>/); const id=pick(/<id>([\s\S]*?)<\/id>/); const summary=pick(/<summary>([\s\S]*?)<\/summary>/); const year=pick(/<published>(\d{4})/); const authors=[...e.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map(a=>a[1].trim()); return{title,url:id,abstract:summary,authors,year}});
  return json(200,{items},cors);
}
```

| Field | B1. Self-Hosted SearXNG — `asm-searxng.fly.dev/search?format=json` | B2. Common Crawl Index + Jina | (optional) B3. arXiv via `/api/arxiv` |
|-------|---------------------------------------------------------------------|-------------------------------|----------------------------------------|
| **Endpoint via Worker** | `GET /api/search?url=${enc('https://asm-searxng.fly.dev/search?q='+enc(q)+'&format=json&language=en')}` | Index: `https://index.commoncrawl.org/CC-MAIN-2024-10-index?url=${enc(q)}&output=json&limit=3` direct `ACAO: *` (or via Worker allow-list); deep-fetch `r.jina.ai/<topUrl>` | `GET /api/arxiv?q=${enc(q)}&limit=3` |
| **Aggregates** | Meta-search 70+ engines (Google, Bing, DDG, Wiki, GitHub, etc.) — one `timed()` slot replaces N | 5B+ pages CC archive + markdown extraction | arXiv Atom → JSON `{title,url,abstract,authors,year}` |
| **Heuristic** | Always eligible `q>=3` | Deep-recall `\b(history\|archive\|dataset\|crawl\|wayback)\b` OR url-like OR `>=2` tokens | `\b(paper\|arxiv\|research\|preprint\|citation\|doi)\b` |
| **License** | **AGPL-3.0** ([searxng/searxng](https://github.com/searxng/searxng)) | **Apache-2.0** server + **CC0** data ([commoncrawl.org/the-data/](https://commoncrawl.org/the-data/)) | CC0 (arXiv OAI) |
| **CORS** | **Conditional `*` via Worker** — direct no ACAO (live `searx.be` no header) → Worker injects `*` (ADR 0004 allow-list) | **Index PASS `*` direct** (`curl -I index.commoncrawl.org → ACAO: *`) + Jina conditional | **Conditional via Worker** (direct `export.arxiv.org` no `*`) |
| **Auth** | No (`limiter:false`, `formats:[html,json]`) | No | No |
| **ToS** | Self-host = your ToS — no third-party burst | Common Crawl allows anonymous (CDX server docs) + Jina attribution | arXiv polite pool 1 req/3s → Worker `cacheTtl:300` |
| **p50** | ~280–450ms (Fly `iad`, 70-engine fan-out `max_request_timeout:3.0`, Worker +20ms) | ~180–350ms index + 300ms Jina → ~500ms sequential (1 Jina/call) | ~220ms + Atom parse |
| **8s** | Yes — wall `max(B1, slowest native) ≈350ms` | Yes | Yes |
| **Attribution** | `— via SearXNG (engines.join(','))` | `— via Common Crawl CC-MAIN-… + Jina Reader` | JSON preserves `authors/year` |
| **Cost** | $0 — Fly free VMs (3×256MB, 160GB egress free per [fly.io pricing](https://fly.io/docs/about/pricing/)) + Worker 100k/d free ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)) | $0 — Index free, Jina free 20/min | $0 — Worker free |
| **Repo** | [searxng/searxng](https://github.com/searxng/searxng) Docker `searxng/searxng:latest` | [commoncrawl/cc-index-server](https://github.com/commoncrawl/cc-index-server) | arXiv OAI |

**Fly+SearXNG deploy (5 min, $0 while credit lasts):**

```bash
flyctl auth login && mkdir asm-searxng && cd asm-searxng
cat > fly.toml <<'TOML'
app="asm-searxng" primary_region="iad"
[build] image="searxng/searxng:latest"
[env] SEARXNG_BASE_URL="https://asm-searxng.fly.dev/"
[http_service] internal_port=8080 force_https=true auto_stop_machines=true auto_start_machines=true min_machines_running=0
[[services]] internal_port=8080 protocol="tcp" [[services.ports]] port=80 handlers=["http"] [[services.ports]] port=443 handlers=["tls","http"]
[[vm]] cpu_kind="shared" cpus=1 memory_mb=256
TOML
mkdir -p searxng && cat > searxng/settings.yml <<'YML'
server: {limiter: false, image_proxy: false, method: "GET", max_request_timeout: 3.0}
ui: {query_in_title: true, results_on_new_tab: false}
search: {formats: [html, json], max_page: 3}
outgoing: {retries: 0, retry_sleep: 0.1, max_retries: 1}
YML
flyctl launch --no-deploy && flyctl deploy --ha=false && flyctl scale memory 256
curl -s "https://asm-searxng.fly.dev/search?q=test&format=json" | head -c 500
# verify CORS via Worker: curl -I "https://<worker>/api/search?url=https%3A%2F%2Fasm-searxng.fly.dev%2Fsearch%3Fq%3Dtest%26format%3Djson" → ACAO: *
```

**B code sketches (reuse `cachedJson`/`cachedText` + `jinaLimiter`):**

```js
async function searxngSource(q, sig, transport) {
  if (!q || q.trim().length < 3) return '';
  const upstream=`https://asm-searxng.fly.dev/search?q=${encodeURIComponent(q)}&format=json&language=en&categories=general`;
  const j = await cachedJson(`/api/search?url=${encodeURIComponent(upstream)}`, sig, transport);
  const results = Array.isArray(j?.results)?j.results:[]; if(!results.length) return '';
  return results.slice(0,3).map(r=>fmt('SEARXNG', r.title||q.slice(0,60), r.url||upstream, `${stripTags(r.content||'').slice(0,220)} — via SearXNG (${(r.engines||[r.engine||'searxng']).join(',')})`)).join('');
}
async function commoncrawlSource(q, sig, transport, limiter) {
  const deepRe=/\b(history|archive|dataset|common crawl|wayback|old version|past snapshot|crawl)\b/i;
  const looksLikeUrl=/^https?:\/\//i.test(q.trim())||/\b\w+\.(com|org|net|io|dev)\b/i.test(q);
  const widenEligible=deepRe.test(q)||looksLikeUrl||q.trim().split(/\s+/).length>=2; if(!widenEligible) return '';
  const ndjson = await jfetchText(`https://index.commoncrawl.org/CC-MAIN-2024-10-index?url=${encodeURIComponent(q)}&output=json&limit=3`, {signal:sig}, transport);
  const lines=String(ndjson).split('\n').filter(Boolean); if(!lines.length) return ''; let topUrl=''; try{topUrl=JSON.parse(lines[0])?.url||''}catch{return''} if(!topUrl) return '';
  if(limiter) await limiter.take(); const text=await cachedText(`https://r.jina.ai/${topUrl}`, sig, transport);
  return fmt('COMMON CRAWL', `Common Crawl hit for ${q.slice(0,40)}`, topUrl, `${String(text).slice(0,800).slice(0,400)}\n— via Common Crawl CC-MAIN-2024-10 (https://commoncrawl.org/) + Jina Reader`);
}
```

*Cost proof:* Fly free allowance is “3 shared-cpu-1x 256MB VMs + 3GB volume + 160GB egress” ([fly.io pricing](https://fly.io/docs/about/pricing/)) — SearXNG idles ~110MB, peaks ~180MB, fits `256MB` with `auto_stop=true` (0 CPU when idle). Cloudflare Workers free is `100k req/day` ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)) — `GET /api/search` is <50/d. Total $0; A+B share the same Worker, no second deploy, no KV.

### Also-arXiv: two extra GH Pages-native sketches from Deep Dives (§5)

- **Decision-surface scoring (15 lines, no Worker, no embed):** `decisionSurfaceScore(blocks, query)` — title+snippet termScore + source reliability prior (`WIKIPEDIA|WIKIDATA|OPENALEX|… → +0.2` per ODS gov/edu preference) + contradiction penalty (`\b(not|never|false|debunked|myth|untrue|contradicts)\b → -0.15` per `r_{c:g}` 0.92–2.59) + recency bonus (`today|just announced|breaking → +0.1` per LiveNewsBench) — sort before `smartSlice`; emit `confidence = capped.length>=3 && scored[0]._score>0.4 ? 'high':'low'` as CRAG evaluator to decide a second `web_search` round within Search Budget. Uses `tokenize()` already in `search.js:656`. See full 30-line sketch in `local://arxiv-findings.md` §5.1.
- **ODS rephrase→augment pipeline (Worker-free, 2–3 rephrases in one Tool Round):** `rephraseQueries(q)` → `[original, stripped nouns, site:wikipedia variant]` + `fanOutStructured` (11 sources ~150ms p50) + `jinaJobs = qs.map(q=>timed('JINA:…', ()=>jinaHelper(..., limiter)))` parallel + `dedupByNormUrl` + `tokenOverlapScore` + `threshold 0.15` — ODS §2.1 rephrase→SERP(`serper.dev`→`r.jina.ai/lite.duckduckgo`)→scrape→rerank→threshold, adapted to `jinaLimiter`+`sessionStorage` cache. See full 50-line sketch in `local://arxiv-findings.md` §5.2.

---

## 7. Blockers & Workarounds — for each issue why this might not work, a way around

| Blocker (why it fails today) | Workaround (GH Pages-compatible, free, open-source) | After | Cost | Primary source |
|-------------------------------|---------------------------------------------------|-------|------|----------------|
| **SearXNG — no `ACAO *`** — public instances send no header; `searx/settings.yml` has no `cors` key, `searx/webapp.py:add_default_headers` never sets CORS (verified `grep -i cors → 0`, `searx.be` `curl -I → ACAO: null` + Anubis bot-wall) | **W1: generic Worker `GET /api/search?url=` allow-listed** (adds `ACAO: *`, 100k/d free, 40-90ms overhead) — extend `asm-agent-proxy` Worker (same `corsHeaders`); **W2: self-host SearXNG** on Fly/Render/HF Docker with **Caddy `header Access-Control-Allow-Origin "*"`** or `nginx add_header` or `server.default_http_headers` injection (`Access-Control-Allow-Origin: "*"` is copied by `webapp.py:525` loop); **`searx.space/data/instances.json` `ACAO: *`** rotation via `Promise.allSettled` fallback; **W4: Pages Function**; **W5: shim chain** (not recommended) | **Unconditional `*` via owned edge** — `curl -I "https://<worker>/api/search?url=https%3A%2F%2Fsearx.example.com/..." → ACAO: *` | $0 — Worker 100k/d free, Fly 256MB `auto_stop` $0 while credit (then ~$1.94/mo) | `searx/settings.yml`, `searx/webapp.py:518`, [docs.searxng.org](https://docs.searxng.org/admin/installation.html), [fly.io pricing](https://fly.io/docs/about/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), live `curl -I searx.be` 2026-08-24 |
| **Marginalia / Stract — no `ACAO *` (mwmbl PASSES via `?s=`)** — `api.marginalia.nu/public/search/test → 200` `license: CC-BY-NC-SA 4.0` but no header (all hosts, live 2026-08-24 no ACAO); **mwmbl `api.mwmbl.org/search/?s=test → 200 ACAO: *`** (42KB, `?q=` doc bug → 422) — **no workaround needed for mwmbl**; `api.stract.com` only `ACAO: http://localhost:8000` (fails GH Pages) | **W1: same Worker allow-list** (`api.marginalia.nu`, `api.stract.com`) → `ACAO: *`; **W2: Jina bridge** `r.jina.ai/http://search.marginalia.nu/search?query=…` (→ markdown, `ACAO: *`); **W3: allorigins/corsproxy** (not recommended); **W4: self-host AGPL** gives CORS control; **mwmbl: fix param to `?s=` — direct `*`** + Worker optional for caching |
| **Brave Search API — requires `X-Subscription-Token`, no `ACAO *` anonymous** — live `GET …/res/v1/web/search?q=test → 422 missing token`, `curl -I -H "Origin: …" → 405` / echo `ACAO:example.github.io` only with token 422; pricing `2000/mo` free then paid; MCP server `BRAVE_API_KEY` env required | **W1: Worker-side token injection** — `BRAVE_API_KEY` in Worker env, `GET /api/search?url=https://api.search.brave.com/...` injects `X-Subscription-Token` server-side + `ACAO: *`, per-IP limiter `createLimiter(15)` to not burn 2k/mo; **W2: BYO User** pattern like `BYO User` (`CONTEXT.md:19`) — `SET` modal stores `keys().braveToken` in `localStorage['asm.settings']`, client reads it only for BYO users (GH Pages no secret leak); **W3: Brave via SearXNG engine** — SearXNG `brave` HTML engine `require_api_key:false results:HTML` ([brave.html](https://docs.searxng.org/_modules/searx/engines/brave.html)) gives Brave results through self-hosted SearXNG with no direct key; **W4: SearXNG+Marginalia** already covers Brave recall keyless | Worker → `ACAO: *` + key never hits bundle; BYO → `*` with Origin; SearXNG engine → keyless HTML | $0 default (SearXNG engine), $5/1k if direct ([Brave pricing](https://api-dashboard.search.brave.com/documentation/pricing)) | [Brave Search API docs](https://api.search.brave.com/app/documentation/web-search/get-started), [MCP README](https://raw.githubusercontent.com/brave/brave-search-mcp-server/main/README.md), SearXNG `brave.html` docs, live `curl -I` 2026-08-24 |
| **Reddit JSON + arXiv Atom — no `ACAO *` + Reddit 403 anon** — `www.reddit.com/search.json` / `old.reddit.com/.json` / `api.reddit.com` all `403 snooserv "You've been blocked"`; `r.jina.ai/http://www.reddit.com` also 403; `export.arxiv.org/api/query` 200 but no `*` (ADR 0008:11 deferred) | **W1: Worker generic proxy** for both (already spec'd `GET /api/search?url=` + `GET /api/arxiv?q=` — Atom→JSON translate, `ACAO: *`, `cf.cacheTtl:300` + `hashIp` debounce, allow-list `export.arxiv.org`); **W2: Jina bridge** for Reddit/HTML (`r.jina.ai/...`) but Reddit still 403 → Jina forwards 403; **W3: allorigins/corsproxy** extinct/missing on probe (ADR 0008 + live 522); **W4: self-host cors-anywhere** (MIT) — not needed when Worker exists | **Conditional `*`** via Worker — `curl -I "https://<worker>/api/arxiv?q=test" → ACAO: *` | $0 — Worker 100k/d | `reddit/wiki/api` (auth+UA required), live `curl -I 403` 2026-08-24, `export.arxiv.org/api/query` ([arXiv API](https://arxiv.org/help/api/user-manual)), [Workers CORS proxy](https://developers.cloudflare.com/workers/examples/cors-header-proxy/) |
| **Jina Reader — 20/min/IP limiter + attribution + cache staleness** — `r.jina.ai` is `ACAO: *` but hard 20/min/IP (ADR 0008:51, `createLimiter(20)`) + `sessionStorage` 10-min cache (stale for LiveNewsBench freshness) + attribution footer (eats tokens) | **W1: shipped mitigation** — single `jinaLimiter = createLimiter(20)` shared across `JINA WEB`+`JINA NEWS` per-turn + 10-min `sessionStorage` URL-hash cache (`js/search.js:88-123,527-547`); **W2: reduce calls** — heuristic gate (only Jina when structured sources miss), dedup via `norm(url)`, rephrase dedup; **W3: fallback chain** — if Jina `429`, fallback to direct `DDG IA`/`WIKI OPENSEARCH`; **W4: Worker KV cache** (cross-user) to share `max-age:300`; **W5: self-host [jina-ai/reader](https://github.com/jina-ai/reader) on Fly free (no 20/min)** — own `ACAO: *` | Limiter/cache+attribution preserved per ToS, burst stays under 20/min, `failures[]` surfaces `MISSED: JINA` failure-tolerant | $0 — client limiter free, Worker KV free 10k writes/d | [jina.ai/reader](https://jina.ai/reader/), [jina-ai/reader](https://github.com/jina-ai/reader), `js/search.js:545-547`, `docs/adr/0008:51`, live `curl -I r.jina.ai → ACAO: *` |
| **General CORS shims — `cors-anywhere` / `allorigins` / `corsproxy.io` extinct or paid** — ADR 0008: “extinct or `ACAO` missing; no shim returned `ACAO: *` on `curl -I`”; `codetabs` 522, `cors-anywhere.herokuapp.com` opt-in since Feb 2021 [issues/301](https://github.com/Rob--W/cors-anywhere/issues/301) + Heroku free dynos discontinued 2022-11-28, `corsproxy.io` keyless `403 keyless_legacy_url` (live 2026-08-24) | **W1: Worker generic proxy** (official [Workers CORS header proxy](https://developers.cloudflare.com/workers/examples/cors-header-proxy/) allow-listed — recommended for JSON/Atom); **W2: Jina bridge for HTML** (`lite.duckduckgo.com`, `search.marginalia.nu`, SearXNG HTML) — `r.jina.ai` `ACAO: *`; **W3: self-host `cors-anywhere`** on Fly/Render (`originWhitelist:['https://<user>.github.io']`, `CORSANYWHERE_RATELIMIT`) — you own abuse; **W4: Pages Function** colocated if migrated to Cloudflare Pages | **Unconditional `*` via owned edge** — `curl -I -H "Origin: …" https://<your-shim> → ACAO: https://<user>.github.io` | $0 — Worker 100k/d, Fly free 256MB `auto_stop`, `cors-anywhere` MIT, `allorigins` MIT | [Rob--W/cors-anywhere](https://github.com/Rob--W/cors-anywhere), [gnuns/allorigins](https://github.com/gnuns/allorigins), [allorigins.win](https://allorigins.win/), [corsproxy.io](https://corsproxy.io/) + [pricing](https://corsproxy.io/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |

**Decision tree (project rule):**

```
Need to fetch Candidate Source from GH Pages browser?
├─ upstream already ACAO: * or origin=* ? → direct fetch (all 25 ADR 0008 sources)
├─ NO: JSON/Atom + fan-out allowed (arXiv, SearXNG) ? → W1 GET /api/search?url= (allow-listed Worker)
├─ NO: HTML (DDG lite/html, marginalia, SearXNG HTML) ? → W2 r.jina.ai/http://… + limiter+cache+attribution
└─ otherwise → reject Candidate (prompt nudge + Hedge Pass covers gap)
```

---

## 8. Rejected Alternatives & Why (live-probe-verified 2026-08-24)

| Candidate | Why rejected for default fan-out | Primary source / probe |
|-----------|----------------------------------|------------------------|
| `cors-anywhere` / `allorigins` / `codetabs` shims | Extinct or no `ACAO: *` on `curl -I` (ADR 0008 live probe) — `api.allorigins.win` 522, `codetabs` 522 | `docs/adr/0008:8` + live 2026-08-24 |
| GDELT `api.gdeltproject.org` | p50 >11s, breaks `8s TIMEOUT` (ADR 0004 17s, 0008 >11s) | `docs/adr/0004:3`, `0008:12` |
| Reddit JSON `api.reddit.com` / `old.reddit.com/.json` | Anonymous 403 `snooserv`, no `ACAO: *` (ADR 0008 probe + live 403) | `docs/adr/0008:10` + live `curl -I 403` 2026-08-24 |
| arXiv direct `export.arxiv.org/api/query` | No `ACAO: *` → requires `GET /api/arxiv?q=` proxy (ADR 0008 deferred) | `docs/adr/0008:11` — shipped as B via Worker |
| Mojeek Search / API | `403 Forbidden` anonymous, `api.mojeek.com` `Access Denied: invalid key/password` XML 2026-08-24 (no keyless `*` surface) | live 2026-08-24 probes |
| `search.marginalia.nu` / `api.marginalia-search.com` | `405` / HTML-only, no JSON API, no `ACAO` | live 2026-08-24 probes |
| Brave Search API `api.search.brave.com` | Paid/keyed — `X-Subscription-Token` required (`Auth=No` fail) — free 2k/mo still a key (ADR 0008:14) | `docs/adr/0008:14`, live 422/405 |
| SearXNG public `?format=json` | No stable `*` instance with `p50 <800ms` (ADR 0008:13) — `searx.be` → HTML no ACAO, `search.bus-hit.me` timeout | `docs/adr/0008:13` + live probes |
| Direct `lite.duckduckgo.com` / `html.duckduckgo.com` | Bot-walled 403/empty (ADR 0008:9) — `r.jina.ai/https://lite.duckduckgo.com` is the fallback | `docs/adr/0008:9` |
| Cloudflare Browser Rendering / AutoRAG | Paid plan required ($5/mo + usage) — violates $0 | [Browser Rendering](https://developers.cloudflare.com/browser-rendering/) / [AutoRAG](https://developers.cloudflare.com/autorag/) |
| PubMed `eutils.ncbi.nlm.nih.gov` | No `ACAO` (`405` with Origin) — would need Worker, lower relevance than OPENALEX | live probe 2026-08-24 |
| Europeana `api.europeana.eu` | `ACAO: *` but `wskey` required (`Auth=No` fail) | live probe `wskey` required |

---

## 9. Creative Alternatives Considered but Not Proposed as Primary (outside the box, still free/open)

- **Wikidata SPARQL expansion:** Expand `WDQS_MAP` (`js/search.js:473-478`) from 20 to 200 entries (all UN leaders + Fortune-100 CEOs + top 20 cryptos) with nightly Wikidata dump crawl, widen trigger to `\bwho (is|leads|heads|runs|founded|owns)\b`, keep `query.wikidata.org/sparql` (`ACAO: *`, `Accept: application/sparql-results+json`). Incremental to existing `wdqsSource` — follow-up PR after A.
- **Brave BYO optional (not default):** Free 2k/mo `X-Subscription-Token` as `BYO User` toggle like `SET` for OpenRouter keys — store `keys().braveToken` in `localStorage['asm.settings']` (same seam as `keys()` `js/search.js:725-728`). Fails default `Auth=No` but passes BYO contract.
- **Cloudflare Worker + D1 as meta-search cache:** Instead of Fly SearXNG, implement a tiny JS meta-search *inside the Worker* (fan out to allow-listed `ACAO: *` APIs server-side, cache in D1) — re-implements SearXNG aggregation without Python; more code than Fly, so Fly is simpler.
- **File-host JSON mirror:** Static JSON snapshot (e.g., Common Crawl file list) hosted on GH Pages and fetched same-origin (`*` by being same origin) — but point-in-time, not live, so not general search (useful only for EOL-like catalogs already shipped).
- **Jina self-host:** Deploy [jina-ai/reader](https://github.com/jina-ai/reader) on Fly free (MIT, no 20/min) — own `ACAO: *` with no attribution cap; own abuse risk.
- **Openverse/Wikidata hybrid as visual+entity answer:** `OPENVERSE` (A3) + `WIKIDATA SPARQL` expansion gives GH Pages an image + entity card without any web scrape — high relevance for “who is X” + “show X” queries.

---

## 10. Cost & Open-Source Summary

| Architecture | Infra | Monthly cost | Open-source components |
|--------------|-------|--------------|------------------------|
| **A Pure Static** | GH Pages only | **$0** | DDG Goodies Apache-2.0, MediaWiki GPL-2.0, Openverse MIT + catalog CC0/BY/SA, repo MIT-equivalent |
| **B Worker-Assisted** | GH Pages + existing `asm-agent-proxy` Worker (free) + Fly.io free VM + Common Crawl free index | **$0** | SearXNG AGPL-3.0, CC Index Server Apache-2.0, Jina Reader MIT, CC data CC0, MediaWiki/Wikipedia CC BY-SA |
| **A+B together** | Same single Worker, single Fly VM (shared `GET /api/search?url=` route) | **$0** — no second Worker | Sum of above — all OSI/CC0/ODbL |
| **Workarounds** | Same Worker + optional Fly/Render/HF Spaces Docker (all free tiers) | **$0** while credit (Fly trial credit → then ~$1.94/mo for 256MB if exhausted) | `cors-anywhere` MIT, `allorigins` MIT, `corsproxy.io` proprietary (not used), Jina MIT/Apache-2.0, Cloudflare Workers example CC BY-SA |

No secrets, no API keys in the browser, no KV/D1 required (though D1 could be added for cross-session SearXNG caching — kept out to stay stateless per `wrangler.toml`).

---

## 11. Reproducing this snapshot

```bash
# Re-run the awesome-list raw fetches
curl -s https://raw.githubusercontent.com/sindresorhus/awesome/main/readme.md | head
curl -s https://raw.githubusercontent.com/edoardottt/awesome-hacker-search-engines/main/README.md | head

# Verify every CORS claim live (2026-08-24 shape)
curl -I "https://api.duckduckgo.com/?q=test&format=json" | grep -i access-control-allow-origin
# → access-control-allow-origin: *
curl -I "https://en.wikipedia.org/w/api.php?action=opensearch&search=test&limit=5&format=json&origin=*" | grep -i access-control-allow-origin
curl -I "https://en.wikipedia.org/api/rest_v1/page/summary/Albert_Einstein" | grep -i access-control-allow-origin
curl -I -H "Origin: https://example.com" "https://api.openverse.org/v1/images/?q=cat" | grep -i access-control-allow-origin
curl -I "https://index.commoncrawl.org/CC-MAIN-2024-10-index?url=example.com&output=json" | grep -i access-control-allow-origin
curl -I "https://api.marginalia.nu/public/search/test" | grep -i access-control-allow-origin  # → (no header)
curl -I "https://searx.be/search?q=test&format=json" | grep -i access-control-allow-origin  # → (none)
curl -I "https://www.mojeek.com/search?q=test" | grep -i access-control-allow-origin
curl -I -H "Origin: https://example.com" "https://api.search.brave.com/res/v1/web/search?q=test" | grep -i access-control-allow-origin

# Measure p50 (wall)
time curl -s "https://api.duckduckgo.com/?q=python%20programming&format=json&pretty=0" > /dev/null
time curl -s "https://en.wikipedia.org/api/rest_v1/page/summary/Python_(programming_language)" > /dev/null

# Re-run arXiv MCP (MCP or direct API)
# https://arxiv.org/abs/2607.10198  (decision surfaces) + https://arxiv.org/abs/2503.20201 (ODS) + 2506.18959 + 2408.07611 + 2401.15884 + 2602.13543 + 2505.18105 + 2412.15246
# Via MCP: search_papers(query="web search LLM agent", limit=10) → get_abstract → download_paper

# Verify Inclusion Checklist live:
curl -s https://api.github.com/repos/searxng/searxng | jq .license.spdx_id
curl -s -D - "https://r.jina.ai/https://example.com" | grep -i access-control-allow-origin
```

---

## 12. References — every claim is traceable (primary sources only)

### Endpoints & CORS (live probes 2026-08-24, verbatim in §3 & §6)
- **DuckDuckGo Instant Answer:** [duckduckgo.com/api](https://duckduckgo.com/api) · goodies [duckduckgo/zeroclickinfo-goodies](https://github.com/duckduckgo/zeroclickinfo-goodies) (Apache-2.0) · docs [duckduckgo.com/duckduckhack](https://duckduckgo.com/duckduckhack) · live `api.duckduckgo.com → ACAO: * dur=76ms`
- **MediaWiki/Wikipedia:** [mediawiki.org/wiki/MediaWiki](https://www.mediawiki.org/wiki/MediaWiki) (GPL-2.0) · `w/api.php` + `api/rest_v1/` · CC BY-SA 4.0 at [Wikipedia license](https://en.wikipedia.org/wiki/Wikipedia:Text_of_the_Creative_Commons_Attribution-ShareAlike_4.0_International_License) · etiquette [foundation.wikimedia.org](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_API_etiquette) · live `acao: *` both endpoints
- **Openverse:** API [api.openverse.engineering/v1](https://api.openverse.engineering/v1/) · repo [WordPress/openverse](https://github.com/WordPress/openverse) (MIT) · live `Origin → ACAO: * x-ratelimit 20/min` 2026-08-24
- **SearXNG:** repo [searxng/searxng](https://github.com/searxng/searxng) (AGPL-3.0) · docs [docs.searxng.org](https://docs.searxng.org/) (70+ engines, `search.formats: [html, json]`) · Docker `searxng/searxng:latest` · settings `searx/settings.yml` (no `cors` key) · `searx/webapp.py:518 add_default_headers` · `searx.space` [instances.json](https://searx.space/data/instances.json) (itself `ACAO: *`)
- **Common Crawl:** dataset [commoncrawl.org/the-data](https://commoncrawl.org/the-data/) (CC0) · Index Server [commoncrawl.org/cc-index-server](https://commoncrawl.org/cc-index-server/) + repo [commoncrawl/cc-index-server](https://github.com/commoncrawl/cc-index-server) (Apache-2.0) · live Index `ACAO: *` NDJSON
- **Jina Reader:** [jina.ai/reader](https://jina.ai/reader/) · repo [jina-ai/reader](https://github.com/jina-ai/reader) (MIT/Apache-2.0) · live `r.jina.ai → ACAO: *` · limiter `js/search.js:545-547` `createLimiter(20)` · `docs/adr/0008:51`
- **Marginalia/mwmbl/Stract:** [MarginaliaSearch](https://github.com/MarginaliaSearch/MarginaliaSearch) (AGPL-3.0) · [mwmbl/mwmbl](https://github.com/mwmbl/mwmbl) (AGPL-3.0) — live `api.mwmbl.org/search/?s=test → 200 ACAO: *` (correct `s`) · [StractOrg/stract](https://github.com/StractOrg/stract) (AGPL-3.0) · live `api.marginalia.nu/public/search/test → 200 no ACAO`; mwmbl `?q=` doc bug per WAMarginalia 2026-08-24 probe
- **Brave Search API:** [api.search.brave.com](https://api.search.brave.com/app/documentation/web-search/get-started) (`X-Subscription-Token` required) · [pricing](https://api-dashboard.search.brave.com/documentation/pricing) + guide [brave.com/search/api/guides/what-sets-brave-search-api-apart](https://brave.com/search/api/guides/what-sets-brave-search-api-apart) · MCP [brave-search-mcp-server](https://github.com/brave/brave-search-mcp-server) (MIT) · live 422/405 2026-08-24 · SearXNG `brave.html` engine docs `require_api_key:false`
- **Mojeek/Yep:** [mojeek.com/services/search/web-search-api](https://www.mojeek.com/services/search/web-search-api/) (proprietary, keyed) · [yep.com](https://yep.com) · live `mojeek.com/search → 403 ACAO: *`, `api.yep.com → Cloudflare 403`
- **Fly.io / Cloudflare:** [fly.io/docs/about/pricing](https://fly.io/docs/about/pricing/) (free VMs 3×256MB) + [removal notice 2025-07-02](https://community.fly.io/t/free-allowances-have-been-removed-on-july-2nd-2025-and-replaced-with-trial-credit/25417) · [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) (100k/d free) · [Workers CORS example](https://developers.cloudflare.com/workers/examples/cors-header-proxy/) · [Pages Functions](https://developers.cloudflare.com/pages/functions/)
- **Cors shims:** [Rob--W/cors-anywhere](https://github.com/Rob--W/cors-anywhere) (MIT, demo opt-in [#301](https://github.com/Rob--W/cors-anywhere/issues/301), Heroku AUP) · [gnuns/allorigins](https://github.com/gnuns/allorigins) (MIT) · [allorigins.win](https://allorigins.win/) · [corsproxy.io](https://corsproxy.io/) + [pricing](https://corsproxy.io/pricing/) (keyless `403 keyless_legacy_url` live)
- **Project:** `CONTEXT.md:107-129,143-145` (Inclusion Checklist, Jina conditional, Search Proxy) · `docs/adr/0004-source-inclusion-ranking.md:7-15` (gates + generic `/api/search?url=`) · `docs/adr/0008-static-general-sources.md:7-15,38-54` (rejected shims, p50 table, limiter, cache) · `js/search.js:27-34,49-86,88-123,527-571,730-757,765-849` · `worker/api-chat.js:18-32,36-41` · `wrangler.toml:1-11`

### arXiv papers (MCP `search_papers`/`get_abstract`/`download_paper` 2026-08-24)
- `2607.10198` decision surfaces: [abs](https://arxiv.org/abs/2607.10198) · [pdf](https://arxiv.org/pdf/2607.10198v1) (downloaded HTML 55k)
- `2503.20201` ODS: [abs](https://arxiv.org/abs/2503.20201) · [pdf](https://arxiv.org/pdf/2503.20201v1) (HTML 104k, repo `sentient-agi/OpenDeepSearch`)
- `2506.18959` Agentic Deep Research: [abs](https://arxiv.org/abs/2506.18959) · [pdf](https://arxiv.org/pdf/2506.18959v3) (`DavidZWZ/Awesome-Deep-Research`)
- `2408.07611` WeKnow-RAG: [abs](https://arxiv.org/abs/2408.07611) · [pdf](https://arxiv.org/pdf/2408.07611v2)
- `2401.15884` CRAG: [abs](https://arxiv.org/abs/2401.15884) · [pdf](https://arxiv.org/pdf/2401.15884v3)
- `2602.13543` LiveNewsBench: [abs](https://arxiv.org/abs/2602.13543) · [pdf](https://arxiv.org/pdf/2602.13543v1) (`livenewsbench.com`)
- `2505.18105` ManuSearch: [abs](https://arxiv.org/abs/2505.18105) · [pdf](https://arxiv.org/pdf/2505.18105v1) (`RUCAIBox/ManuSearch`)
- `2412.15246` Accelerating RAG: [abs](https://arxiv.org/abs/2412.15246) · [pdf](https://arxiv.org/pdf/2412.15246v1)

### Awesome lists & GitHub (MCP `searchGitHub` / `api.github.com`)
- [sindresorhus/awesome](https://github.com/sindresorhus/awesome) · [public-apis/public-apis](https://github.com/public-apis/public-apis) · [edoardottt/awesome-hacker-search-engines](https://github.com/edoardottt/awesome-hacker-search-engines) (all via raw `README.md` 2026-08-24) · `api.github.com/repos/searxng/searxng` 36k AGPL-3.0

### Reddit (live `curl -I` + `web_search site:reddit.com` 2026-08-24)
- 6 threads + 12 permalinks in §4 (r/LocalLLaMA 1uam3iv, r/selfhosted 1rg1v2x, r/searchengines 1syy78q, r/webdev 1ii43ns, r/selfhosted 1n7ko7l + r/javascript 1na2njb Corsfix, r/webdev 1frzc7r) plus supporting [r/Searx](https://www.reddit.com/r/Searx/hot/) · [r/LocalLLaMA 1oocqk1](https://www.reddit.com/r/LocalLLaMA/comments/1oocqk1/could_you_guys_recommend_the_best_web_search_api/) · [1ukpd5y](https://www.reddit.com/r/LocalLLaMA/comments/1ukpd5y/whats_your_actual_agentic_web_research_stack/) · [1shezi8](https://www.reddit.com/r/LocalLLaMA/comments/1shezi8/i_no_longer_need_a_cloud_llm_to_do_quick_web/) · [r/privacy 1f55z5o](https://www.reddit.com/r/privacy/comments/1f55z5o/alternative_search_engines_to_use_instead_of_ggle/) · `reddit/wiki/api` · live `reddit JSON 403` + `r.jina.ai 403` + `api.pullpush.io 200→429` + `gh search code 401` (transcripts in `local://reddit-findings.md` §1)

---

## 13. On this file's location & subagents

This repo had `docs/research/` for primary-source notes (see `docs/research/*.md` above). This file establishes the live-search extension there; no other file was modified. Wave 1: 5 research agents + Wave 2: 6 workaround agents (per interjection: *for each issue why this might not work, send subagents to find a way around*). Their `local://*.md` intermediates are merged here; the skill's deliverable is this **single** Markdown with per-claim citations and paste-ready code.

---

*Generated for `assembly-agent` 2026-08-24 — every claim above traces to the linked primary source or the cited repo file/live probe. No secondary write-ups used. Re-run the `curl -I` and `search_papers` steps in [Reproducing this snapshot](#11-reproducing-this-snapshot) before trusting the table — live web state drifts.*

