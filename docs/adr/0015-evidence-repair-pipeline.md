# Evidence-first research pipeline: plan, read, assess, repair

The 2026-09-15 campaign found the research path answering milestone-shaped questions with stale answers: the minimizer stripped meaning-bearing words ("most", "not", "no"), the fan-out sent a career-records question to a scoreboard and an image service, the general-web block was the first 800 characters of a search-results page, and the turn accepted whatever the model produced once it stopped calling `web_search`. We replace the harvest-and-slice shape with a bounded browser-controlled pipeline — plan → route → discover → filter → read → assess → repair — that keeps the deployment fully static and the search fully keyless, and we give the model the sampled device clock on every outbound request.

## Considered Options

- Solve the NBA question directly (league/total special case, or an NBA answer table) — rejected: it is the failure mode the repair exists to fix, not a fix for it.
- A server-side search/reader/time endpoint or a self-hosted search service — rejected: breaks the GH Pages deployment contract and adds infrastructure Approach A does not authorize.
- OpenRouter server-side search/fetch plugins — rejected: keyed, and removes the application's control over what is searched and read.
- Keyed search providers (Brave, Tavily) — rejected: search must work with no account, no key, no trial credit.
- Relevance filtering only when the context budget overflows (today's `smartSlice` fast path) — rejected: context size is not a quality threshold; irrelevant results survive whenever they fit.

## Decision

Five pure modules own the pipeline; the Bridge sequences it; the UI renders one registry.

- `js/research.js` — the planner. `minimizeQuery` stays the privacy boundary byte-for-byte (credentials, long quotes, URL params; STOPWORDS now keeps meaning-bearing words: comparisons, negation, units). `planTask` derives a plan `{ kind, entities, metrics, temporal, scope, facts, query }` deterministically, before any byte leaves the browser; `classifyIntent` routes the Fan-out; `followUpQuery` builds targeted repair queries. All-time/in-history totals plan as `temporal: 'current'`; league career records default to `scope: 'regular season'` unless the text says otherwise (documented in the module header).
- `js/search.js` — routing gates by intent (`factual` keeps the general web: Wikipedia, DDG IA, WIKI OPENSEARCH, MWMBl, JINA WEB; academic/code/scores/news/visual/definition add their adapters; ESPN additionally requires score/scoreboard intent, so career questions never hit a scoreboard). JINA WEB/NEWS parse the reader render into individual blocks with real decoded `uddg=` destination URLs — a search-results page is never again one giant evidence block. `readPage(url)` reads the selected answer pages (direct GET first, `r.jina.ai` fallback behind the shared 20/min limiter; SSRF-safe targets only; 403/challenge/empty are retrieval outcomes, never evidence). `smartSlice` drops zero-overlap blocks regardless of budget.
- `js/evidence.js` — deterministic assessment: `assess`/`assessIfFactual` per-fact verdicts (`supported`/`partial`/`conflicting`/`unavailable`), historical-milestone items cannot satisfy a `current` fact, differing scope is a different question not a conflict; `evidenceFromPage` extracts table/subject/metric evidence from a read page; `repairQuery` names the missing fact.
- `js/sources.js` — the per-turn Source Registry: stable ids, canonical URLs (never lowercased paths, never dropped query params), provenance (`alsoBy`), retrieval status, and the evidence each source supports; failed reads are records, never supporting sources.
- `js/clock.js` — the runtime context: `runtimeContext()` samples the device clock every call (UTC + local date/time via Intl in the resolved IANA zone + offset + explicit fallback/unavailable markers); `setClockSeam` is the test seam. The Bridge appends one `clockLine` to the system message of EVERY outbound model request — initial rounds, tool-result rounds, budget-nudge, hedge, wording pass — sampled at request time, never stored in history.

The Bridge's turn: plan → mandatory fresh lookup (`fresh: true`, cache bypassed) → auto-read the top 2 candidates → model rounds (model tool calls keep the minimize boundary) → sufficiency gate on `factual` turns → at most 2 repair cycles (targeted query + 1 read + one tools-less round nudged by `EVIDENCE_REPAIR_NUDGE`) → hedge pass → settle. Every search (initial, model tool call, repair) counts inside `MAX_RESEARCH_ROUNDS = 5`; page reads cap at `MAX_PAGE_READS = 6` per turn; the turn has a 90s wall budget; stop() cancels reads and repairs; the registry snapshot rides a `sources` event after every mutation and the drawer renders only supporting sources.

## Consequences

- Keyless stays true: the only new third-party endpoint is the already-listed `r.jina.ai` reader, verified 2026-09-15 (ACAO echoes the request Origin, 20 req/min/IP, per-domain abuse blocks return 403 and are treated as outcomes). Direct page reads are attempted first and fall back to the reader when CORS blocks them; no no-cors anywhere.
- WASM memory contract unchanged: history appends stay under the 16 KiB content window (page details are excerpted and hard-capped at ~12k bytes/turn); the engine is untouched.
- Runtime context never accumulates: old clock lines are not persisted, and message history carries no "current time" message; ordinary message timestamps stay as they were.
- Legacy chats keep working: registry snapshots carry `title`/`url`/`snippet`, so old stored sources render and export unchanged.
- The Capability Sweep's canned corpus is less complete for factual prompts (HN/StackExchange/GitHub are code-intent-only now) — a Source firing less often is the intended shape, and the sweep records rather than asserts firing.
- Honest limits: a blocked/challenged page is a retrieval outcome, and the drawer says "Some sources were unreachable."; conflicting totals are reported as conflicting, never averaged; unknown dates stay unknown (`discoveredAt`/`fetchedAt`/`publishedAt`/`updatedAt`/`dataAsOf` are distinct).
- Reproduce the regression: `node --test test/research.test.mjs` (the motivating typo question, clock freshness, registry events, bounded repair) and the browser journey `test/browser/journey-evidence.spec.mjs` over `npm run build && npm run serve`. Live check: `node scripts/live-smoke.mjs` (dated results in `docs/research/web-search-live-free-2026-09-15.md`).
