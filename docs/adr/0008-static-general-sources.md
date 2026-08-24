# Static-pure general-purpose Sources: heuristics, caps, and Hedge Pass

Eval and the Sweep left a general-purpose hole: the 12-source fan-out (WIKIPEDIA, HACKER NEWS, STACK OVERFLOW, GITHUB, WIKIDATA, OPENALEX, CROSSREF, SEMANTIC SCHOLAR, DOAJ, OPEN LIBRARY, DBPEDIA, LOBSTE.RS) covered code/tech/science but returned heuristic-miss `''` on scores, prices, FX, weather, demographics, EOL, news, dictionary, and TV. GH Pages is static, no secrets — every default Source must be keyless, CORS `*` (or `origin=*`), and fit the 8s `TIMEOUT` with p50 <800ms. We expand to ~25 Sources without growing the Worker.

## Considered Options

- Grow the Worker with per-source routes (one proxy per non-CORS API) — rejected per operator constraint: each Worker route adds deploy/config surface, and the operator prefers zero new Worker paths; static-pure keeps GH Pages + the single `asm-agent-proxy` unchanged.
- Public CORS shims (`cors-anywhere`, `allorigins`, etc.) — rejected: live probe 2026-08-24 shows extinct or `access-control-allow-origin` missing; no shim returned `ACAO: *` on `curl -I`.
- DDG HTML/JSON direct (`html.duckduckgo.com`, `api.duckduckgo.com`) — rejected: bot-walled (403 / empty) behind Jina; `r.jina.ai/https://lite.duckduckgo.com/lite/?q=` is the measured fallback (~300ms, markdown) behind a 20/min/IP limiter.
- Reddit JSON (`old.reddit.com/.json`, `api.reddit.com`) — rejected: live probe 403 on anonymous fetch, no `ACAO: *`.
- arXiv direct (`export.arxiv.org/api/query`) — rejected: no `ACAO: *`, would require `GET /api/arxiv?q=` proxy; deferred to keep the expansion Worker-free.
- GDELT (`api.gdeltproject.org`) — rejected: p50 >11s on probe, breaks the 8s `TIMEOUT` SLO (ADR 0004: GDELT dropped for same reason).
- SearXNG public JSON — rejected: no stable public `?format=json` instance found with `ACAO: *` and <800ms p50.
- Brave Search API — rejected: paid/keyed, violates `Auth=No` and GH Pages keyless default.
- Keep 12 Sources and ship the new intents as prompt nudges only — rejected: parametric nudge (`If you already know… reply directly`) helps but live eval still showed unsupported claims on weather/scores/FX where a keyless fetch would have grounded the answer.

## Decision

Ship ~25 static-pure Sources, all keyless `ACAO: *` (or `origin=*`), behind heuristic eligibility + `timed()` + `Promise.allSettled` fan-out. Adopted set (endpoint, trigger, measured p50):

- **ESPN** — `https://site.api.espn.com/apis/site/v2/sports/{league}/scoreboard` (football/nfl, basketball/nba, baseball/mlb, soccer/eng.1 …) — league-token heuristic — ~180ms
- **MLB** — `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=YYYY-MM-DD` — mlb/baseball tokens — ~160ms
- **CoinGecko** — `https://api.coingecko.com/api/v3/simple/price?ids=<comma>&vs_currencies=usd` — coin-name list (`bitcoin|btc|ethereum|eth|…`) — ~140ms
- **Frankfurter** — `https://api.frankfurter.dev/v1/latest?from=USD&to=EUR` — currency code/name heuristic — ~120ms
- **Open-Meteo geocoding** — `https://geocoding-api.open-meteo.com/v1/search?name=<place>&count=1` → `{latitude,longitude,country_code}` — shared memoized helper, fires on any place-bearing query — ~150ms
- **Open-Meteo forecast** — `https://api.open-meteo.com/v1/forecast?latitude=&longitude=&current=temperature_2m,weather_code` — `weather|temperature|forecast` or place-intent — ~180ms
- **World Bank** — `https://api.worldbank.org/v2/country/<code>/indicator/SP.POP.TOTL;NY.GDP.MKTP.CD?format=json` — `gdp|population|economy` + `country_code` from same geocoder — ~220ms
- **End of Life** — `https://endoflife.date/api/all.json` (~200 products) — always eligible, client-side product-token match, top 2 only — ~200ms
- **Current Events Portal (CEP)** — `https://en.wikipedia.org/w/api.php?action=parse&page=Portal:Current_events&format=json&origin=*` → `parse.text['*']` HTML `li` — news-intent heuristic — ~210ms
- **Wikidata SPARQL (WDQS)** — `https://query.wikidata.org/sparql?query=<enc>&format=json` — `^who (is|leads)|current (president|prime minister|ceo|pope|king|monarch)` with ~20-entry Q-id map, tiny queries — ~300ms
- **Jina Web** — `https://r.jina.ai/https://lite.duckduckgo.com/lite/?q=<enc>` → markdown — always eligible behind `createLimiter(20)` — ~300ms
- **Jina News** — `https://r.jina.ai/https://news.google.com/rss/search?q=<enc>&hl=en-US&gl=US&ceid=US:en` — news fallback behind same limiter — ~280ms
- **Dictionary** — `https://api.dictionaryapi.dev/api/v2/entries/en/<word>` — `what does X mean|define X` — ~130ms
- **TVMaze** — `https://api.tvmaze.com/search/shows?q=<q>` — `tv show|series|episode` — ~150ms
- **StackExchange (upgraded)** — `search/advanced?q=&site=<site>&pagesize=3&filter=withbody&order=desc&sort=relevance`, multi-site parallel `[stackoverflow,cooking,diy,physics]`, `quota_remaining>50` guard — ~130ms
- plus the 11 retained keyless Sources (WIKIPEDIA, HACKER NEWS, GITHUB, WIKIDATA, OPENALEX, CROSSREF, SEMANTIC SCHOLAR, DOAJ, OPEN LIBRARY, DBPEDIA, LOBSTE.RS) — p50 120–280ms, all `ACAO: *`.

Eligibility is heuristic-miss-is-legal: a Source that does not fire simply contributes no block, never throws. `webSearch(query,{transport})` signature and `{markdown,sources,failures,perSource}` return stay unchanged; every job goes through `timed()`/`withMs()` with `sessionStorage` URL-hash 10-min TTL for Jina + WDQS.

Techniques:

- **Parametric nudge** — `WEB_SEARCH_TOOL` description adds `If you already know a stable answer confidently, reply directly instead of calling web_search.` — reduces empty fan-out when the model already has the answer.
- **Smart slice** — `smartSlice(blocks,query,budget=12000)` term-scores blocks against query terms, then emits in original Source-weight order up to budget; replaces `.slice(0,12000)` after dedup.
- **Wiki caps** — `applyWikiCaps(blocks)` enforces `WIKIPEDIA ≤2` blocks and `WIKIDATA ≤2` (header regex `^### \[TAG\]`), DBPEDIA uncapped; prevents wiki dominance of the 12k window.
- **Client limiter** — `createLimiter(perMinute)` → `{take():Promise}` token-bucket (20/min for Jina) shared across Jina Web + Jina News jobs in the same `webSearch` call.
- **Hedge Pass** — `js/guard.js` (zero imports) exports `looksLikeDenial(text)`, `hedgeNeeded(answer,evidence)`, `HEDGE_PASS_NUDGE`, `repairToolArgs(argsText)`; `js/bridge.js` `runTurn` tracks accumulated tool-result markdown and, once per Turn after natural round-final, if `hedgeNeeded` (denial phrasing AND empty evidence OR denied subject absent from evidence) re-invokes the model tools-less with `HEDGE_PASS_NUDGE` (reusing `BUDGET_NUDGE` plumbing) to rewrite the denial as honest uncertainty. `repairToolArgs` is applied in both single and parallel tool-call paths via `JSON.parse` then regex salvage.

## Consequences

- Fan-out grows 12 → ~25 default, all keyless CORS `*` and works on GH Pages without config; 8s `TIMEOUT` still holds (parallel p95 dominated by slowest Source, WDQS/Jina ~300ms).
- Jina dependency: hard 20 req/min/IP — client limiter + 10-min cache mitigate, but bursts still surface as `failures[]` (`MISSED: JINA WEB`); every Jina block must carry its attribution footer per Jina ToS. Inclusion Checklist gains a conditional note for Jina: `ACAO * via r.jina.ai, attribution required, 20/min/IP limiter`.
- StackExchange anonymous quota 300/day/IP — `quota_remaining>50` guard and 3-result `pagesize` keep budget; exceed surfaces as `FAILED` but never blocks other Sources.
- WDQS etiquette: small hardcoded Q-id map, tiny queries, `Accept: application/sparql-results+json`, cache; abuse risks 429.
- No new Worker routes; arXiv/Reddit/CORS shims remain future candidates only if they clear the Checklist without Worker growth.
