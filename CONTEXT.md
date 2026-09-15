# ASM Agent

Static amber CRT chat that talks to OpenRouter through a WAT engine. The context covers chats, the assistant library, web research, the wording check, the model catalog, storage v2, and free-tier access — plus the release vocabulary a maintainer must not get wrong: the required gate, test classes, the staged artifact and its promotion guard.

## Language

**Free Model**:
A model whose OpenRouter id ends with `:free` and is available at zero cost on the free tier.
_Avoid_: free-tier model, zero-cost model

**Newest-Free**:
The automatic model mode: a new chat resolves `newestFreeModelId()` once and pins the result. Candidates must be free, priced `:free`, and produce text; the newest `created` wins, and ties break on the greater id. The catalog never selects a paid model when the free pool is empty. Catalog refreshes never change an existing chat, and there is no automatic fallback on error.
_Avoid_: auto model, default model

**Operator Key**:
The single `sk-or-...` key owned by the operator and held only on the server to authorize free-model requests.
_Avoid_: shared key, public key, embedded key

**Anonymous User**:
A visitor who uses the agent without supplying an API key.
_Avoid_: guest, unauthenticated user

**BYO User**:
A visitor who supplies their own OpenRouter key in Settings.
_Avoid_: logged-in user, paid user

**Session Key**:
The OpenRouter key kept in `sessionStorage` (`asm.openrouter.key`) for the current browser session. It is the default for a new key. "Remember on this device" optionally persists a key to settings (`asm.settings.key`); removing the key clears both copies. The Bridge reads the key before every request round, and a key that is changed or removed stops a paid turn.
_Avoid_: temporary key, transient key

**Proxy**:
The server edge that receives `POST /api/chat` (and optionally `GET /api/search?url=` / `/api/arxiv?q=` for a CORS-blocked free Source) from the browser and forwards it — chat to OpenRouter with the Operator Key, search to the upstream open API with `access-control-allow-origin: *`.
_Avoid_: backend, gateway, middleware

**Rate Limit**:
The per-IP quota the Proxy can enforce on Anonymous Users to protect the Operator Key. Currently not enforced — Anonymous Users rely on the Operator Key's OpenRouter limit (429); enforcement is deferred until abuse is observed.
_Avoid_: throttling, quota

**Assistant**:
A named set of instructions in the assistant library. The built-in `ASM::AGENT` is always present and protected from edit and delete. Custom assistants can be created, edited, duplicated, deleted, imported, and exported. Custom instructions cannot disable the mandatory web research.
_Avoid_: preset, persona, profile, template

**Assistant Snapshot**:
The `{assistantId, assistantRev, assistantName, instructions}` copy baked into a chat when it starts. Editing an assistant affects only future chats. An older chat can run "Update instructions" to take a newer rev of the same assistant; it never switches to another assistant. A deleted assistant leaves its chats usable on their snapshots.
_Avoid_: reference, pointer, link

**Chat**:
One conversation record in the v2 store: title, timestamps, assistant snapshot, one model choice, and messages. A new chat always starts with the built-in assistant; choosing a different assistant starts a new chat.
_Avoid_: session, thread, conversation

**Migration**:
The one-time v1 to v2 conversion in `js/store.js` (`migrateIfNeeded`). It stages the plan in memory, writes the backup (`asm.legacy.backup.v1`, with the settings key stripped) first, writes the assistants, chats, and settings next, and writes the marker (`asm.migration.v2`) last. A failed write leaves the legacy keys untouched and no marker behind, so a later run retries safely. Legacy keys are not deleted.
_Avoid_: upgrade, data import

**Tool Call**:
The structured request a model streams back to run `web_search`, carrying a name and a JSON `arguments` string.
_Avoid_: function call, tool invocation

**Research Round**:
One `web_search` run for a Turn. The first round is mandatory and fresh: it runs before the first model call with `fresh: true`, so the `sessionStorage` caches do not apply to it. Later rounds come from Tool Calls in Model Rounds. `MAX_RESEARCH_ROUNDS` counts the initial lookup inside the same cap.
_Avoid_: tool round, search hop

**Model Round**:
One request to the model in a Turn. The first model round starts after the mandatory initial Research Round, grounded on the results already in context; a later round can spend one Research Round through a Tool Call whose result is fed back as a `role:"tool"` message. Bounded by the Search Budget, then closed by the `BUDGET_NUDGE` pass.
_Avoid_: tool round, iteration, hop

**Search Budget**:
The largest number of Research Rounds one Turn may spend (`MAX_RESEARCH_ROUNDS`, currently 5, including the initial lookup). The only guaranteed stop in the research loop: when it runs out, a final tools-disabled pass nudged by `BUDGET_NUDGE` forces an answer from the results already in the conversation.
_Avoid_: tool limit, max rounds, retry limit

**Turn**:
One user message processed to a final answer: one mandatory fresh Research Round, then Model Rounds bounded by the Search Budget, optionally closed by the `BUDGET_NUDGE` pass. A built-in answer may take one Wording Check rewrite before it settles. The Turn loop lives in the Bridge; a Chat stores Turns as messages.
_Avoid_: request cycle, completion, exchange

**Wording Check**:
The mechanical ASD-STE100-style pass on an answer from the built-in assistant. `js/ste.js` `checkProse` reports rule-linked violations after the answer settles; a violation can trigger at most one tools-disabled corrective rewrite, which `integrityPreserved` must accept (links, code blocks, numbers, and quoted spans survive). A failed or rejected rewrite keeps the original answer, and a superseded draft never enters the model context. Custom assistants are exempt; interface copy is checked in development and tests, not at runtime. Implemented checks: sentence length over 20 words (rule 5.1), a paragraph over six sentences (rule 6.6), a passive-voice heuristic (rule 3.6), a progressive `-ing` heuristic (rules 3.5 and 3.2), a double negative (no Issue 9 rule number; mapped from Global English rule 3.12 by TechScribe), and more than one command per sentence (rule 5.2).
_Avoid_: STE pass, style pass, rewrite pass

**Scanner**:
The WAT code that reads the SSE stream and stages every Tool Call of the turn in the Tool Call Table. Walks each `tool_calls` line left to right: `"id":"` opens the next slot, `"name":"` and `"arguments":"` land on the slot open at that point.
_Avoid_: parser, SSE reader, tokenizer

**Tool Call Table**:
The Scanner's per-turn staging area at `0x6800` — 8 slots of 256B, one per Tool Call, each holding id, name and its own `arguments` accumulator. Slot 0 aliases the legacy control slots so single-call readers are unchanged; a 9th call is dropped and counted in `tc_overflow`.
_Avoid_: tool call array, slot array, call buffer

**Sweep**:
One run of `scripts/sweep-free-models.mjs`: the same task battery sent to every Free Model in turn, over the Proxy, with canned search results and every raw stream saved.
_Avoid_: benchmark, eval, test matrix

**Capability Tier**:
How far one Free Model gets through a Model Round, L0 to L4. L0 accepts tools; L1 emits a Tool Call the Scanner reads; L2 the query fits the question; L3 it stops searching and answers by itself; L4 it obeys `BUDGET_NUDGE` when the Search Budget is spent. L3 and L4 are two exits, not two steps.
_Avoid_: score, grade, rating, level

**Source**:
A single origin `webSearch` fans out to via `timed()` + `jfetch` + `fmt()` (e.g., `WIKIPEDIA`, `OPENALEX`). Each Source has a tag, a URL builder, and a `norm(url)` dedup key. All default Sources are keyless, CORS `*`, and work on the GH Pages deployment.
_Avoid_: provider, endpoint, engine

**ESPN**:
A scoreboard Source at `site.api.espn.com/apis/site/v2/sports/{league}/scoreboard` that fires on league tokens (`nfl|nba|mlb|premier league|soccer`) or any MLB/NBA/NFL team nickname (`TEAM_LEAGUES` map; cross-league ambiguous nicknames like Giants/Cardinals resolve by a co-mentioned unambiguous teammate's league, else a documented default) and returns live/recent scores.
_Avoid_: sports api, scoreboard provider

**MLB**:
A schedule Source at `statsapi.mlb.com/api/v1/schedule?sportId=1&date=YYYY-MM-DD` that fires on `mlb|baseball` tokens and returns today's games.
_Avoid_: baseball api, mlb endpoint

**COINGECKO**:
A crypto price Source at `api.coingecko.com/api/v3/simple/price?ids=&vs_currencies=usd` that fires on coin names (`bitcoin|btc|ethereum|eth|…`).
_Avoid_: crypto api, price provider

**FRANKFURTER**:
An FX rates Source at `api.frankfurter.dev/v1/latest?from=&to=` that fires on currency codes or names (`USD|EUR|JPY|…`).
_Avoid_: forex api, fx provider

**OPEN-METEO**:
A weather Source via `geocoding-api.open-meteo.com/v1/search?name=&count=1` → `api.open-meteo.com/v1/forecast?current=temperature_2m,weather_code` that fires on `weather|temperature|forecast` or any place-bearing query; the shared memoized geocoder supplies `country_code` for World Bank.
_Avoid_: weather api, forecast provider

**WORLD BANK**:
A demographics Source at `api.worldbank.org` (`/v2/country/{code}/indicator/...`) that fires on `gdp|population|economy` plus a country (via the same geocoder's `country_code`).
_Avoid_: worldbank api, demographics provider

**END OF LIFE**:
An EOL Source at `endoflife.date/api/all.json` (bare slug strings since 2026-08; older `{product,is_maintained,latest}` objects still handled) that is always eligible, matches query tokens against product slugs client-side (`productHit`, top 2), and whose blocks get a `smartSlice` weight boost when the query names a tracked product (`EOL_PRODUCT_LIST` catalog snapshot).
_Avoid_: eol api, lifecycle provider

**CURRENT EVENTS**:
A news-bulletin Source at `en.wikipedia.org/w/api.php?action=parse&page=Portal:Current_events&format=json&origin=*` that fires on news intent and parses `parse.text['*']` HTML `li` bulletins (Portal:Current_events).
_Avoid_: wiki current events, news portal

**WIKIDATA SPARQL**:
A structured-entity Source at `query.wikidata.org/sparql?query=&format=json` that fires on `^who (is|leads)|current (president|prime minister|ceo|pope|king|monarch)` with a small hardcoded Q-id map (~20 offices/countries); queries are kept tiny for etiquette.
_Avoid_: wikidata api, sparql provider

**JINA WEB**:
The general-web fallback Source via `r.jina.ai/https://lite.duckduckgo.com/lite/?q=` → markdown, always eligible behind a shared `createLimiter(20)` 20/min/IP token-bucket and 10-min `sessionStorage` URL-hash cache; attribution footer required.
_Avoid_: jina proxy, web fallback

**JINA NEWS**:
A news RSS Source via `r.jina.ai/https://news.google.com/rss/search?q=&hl=en-US&gl=US&ceid=US:en` → markdown, fires on `\b(news|headlines|right now|today|this week)\b`, behind the same 20/min limiter and cache with attribution.
_Avoid_: news rss, google news provider

**DICTIONARY**:
A definition Source at `api.dictionaryapi.dev/api/v2/entries/en/<word>` that fires on `what does X mean|define X`.
_Avoid_: dictionary api, define provider

**OPEN LIBRARY**:
A books Source at `openlibrary.org/search.json?q=&limit=3` that fires on book-intent tokens (`book(s)|textbook|novel(s)|author(s)|writer(s)|isbn|paperback(s)|hardcover(s)|audiobook(s)|literature|fiction|memoir|poetry|bestseller(s)`).
_Avoid_: open library api, book provider

**TVMAZE**:
A TV-show Source at `api.tvmaze.com/search/shows?q=` that fires on `tv show|series|episode`.
_Avoid_: tv api, show provider

**DDG IA**:
A snippet Source at `api.duckduckgo.com/?q=&format=json` that fires on `q` 3–200 chars and returns `AbstractText`/`Answer`/`RelatedTopics`; attribution via `AbstractSource`.
_Avoid_: duckduckgo api, ddg provider

**WIKI OPENSEARCH**:
A suggest Source at `en.wikipedia.org/w/api.php?action=opensearch&origin=*` + `api/rest_v1/page/summary/` that fires on `q` ≥3 (skip `^who is`/`^define`) and returns title/url/extract for top 3 hits.
_Avoid_: wiki suggest, opensearch provider

**OPENVERSE**:
An image Source at `api.openverse.org/v1/images/?q=&page_size=3` that fires when visual intent `\b(image|photo|picture|logo|cover|artwork|painting|diagram|icon|cat|dog|map|chart|poster|flag|portrait)\b` or `q` has ≥2 tokens; needs `Origin` for `ACAO: *`, anon limiter 15/min (upstream 20/min burst).
_Avoid_: openverse api, image search provider

**MWMBl**:
A general-web Source at `api.mwmbl.org/search/?s=` (note `s` not `q`; `?q=` returns 422) that fires on `q` ≥3 and returns AGPL-3.0 crawl JSON with `ACAO: *`.
_Avoid_: mwmbl api, crawl provider

**Candidate Source**:
A Source evaluated in research harvest but not yet in the `webSearch` fan-out. Filtered by the Inclusion Checklist before it ships.
_Avoid_: candidate, potential source

**Inclusion Checklist**:
The gates a Candidate Source must clear to ship: license OSI/CC0/ODbL, CORS `*` (or `origin=*`), keyless Auth=No, ToS allows anonymous client fan-out, live `curl -I` shows `access-control-allow-origin: *`, relevance High for code/tech/science, p50 <800ms and fits 8s `TIMEOUT`. Conditional `*` via Worker generic proxy is allowed only if free and GH Pages–compatible. Jina Reader sources are conditional: `r.jina.ai` provides `ACAO *` with attribution footer required and a hard 20 req/min/IP — shipped behind a client token-bucket limiter (`createLimiter(20)`) and 10-min `sessionStorage` cache.
_Avoid_: criteria, filter

**Fan-out**:
The parallel `Promise.allSettled(jobs)` batch inside one `webSearch` call. Each job is a `timed(name, fn, failures)` Source. Default is 28 keyless Sources (11 code/science including upgraded STACK OVERFLOW + 13 general-purpose: ESPN, MLB, COINGECKO, FRANKFURTER, OPEN-METEO, WORLD BANK, END OF LIFE, CURRENT EVENTS, WIKIDATA SPARQL, JINA WEB, JINA NEWS, DICTIONARY, TVMAZE + 4 general-web: DDG IA, WIKI OPENSEARCH, OPENVERSE, MWMBl); no key-gated Sources ship by default.
_Avoid_: batch, fanout

**Ranking**:
Ordering of deduped `fmt` blocks before the 12k `markdown.slice`. Grouped by Source weight (job order), then `applyWikiCaps` (WIKIPEDIA ≤2 blocks, WIKIDATA ≤2, WIKIDATA SPARQL ≤2, WIKI OPENSEARCH ≤2 via header `^### \[TAG\]`, DBPEDIA uncapped), then `smartSlice` term-scored selection preserving original order up to budget (END OF LIFE blocks gain `EOL_BOOST` when the query names a tracked product) — chat model does relevance ranking when it synthesizes the answer, not `webSearch` itself.
_Avoid_: scoring, sorting, ordering
**Hedge Pass**:
The single forced tools-less rewrite inserted after a natural round-final when `hedgeNeeded(answer, evidence)` is true — the answer contains existence-denial phrasing (`there is no|does not exist|no such`) and Tool-result evidence is empty or lacks the denied subject. The Bridge re-invokes the model once with `HEDGE_PASS_NUDGE` (honest-uncertainty rewrite instruction, reusing `BUDGET_NUDGE` plumbing) and replaces the final text; at most one per Turn.
_Avoid_: hedge retry, denial fix, second pass

**Search Proxy**:
Optional Worker route `GET /api/search?url=` (and `/api/arxiv?q=`) that forwards a CORS-blocked open source (e.g., arXiv Atom) through the same Worker that holds the Operator Key, adds `access-control-allow-origin: *`, and translates to JSON. Free, no key, only for sources that already pass the rest of the Inclusion Checklist.
_Avoid_: cors proxy, gateway

**Sources Panel**:
The `Sources (N)` disclosure under a finished answer that lists the links the answer used (`title`, `url`, `snippet`). The answer footer also shows the model used, the wording state ("checked wording"), and honest notes such as "Some sources were unreachable." or "Web search was not available for this answer."
_Avoid_: tool card, source list, citations

**Touch Target**:
The interactive hit area of a header, dock, or dialog control at 360–375px. Must be ≥24×24px (WCAG 2.2 2.5.8) and ideally 44×44pt (Apple HIG) with 8px spacing; in ASM Agent this covers the header actions (`.b-act`), the send button (`.b-send`), and the dialog controls (`.b-btn`, `.b-x`, `.b-chip`).
_Avoid_: hitbox, tap area

**Focus Visible**:
The keyboard-only focus indicator drawn via `:focus-visible` (not `:hover` or `outline:none`). In ASM Agent it must remain visible while a `<dialog>` overlay is open and not be obscured by fixed chrome.
_Avoid_: focus ring, focus outline

**Reduced Motion**:
The `prefers-reduced-motion: reduce` degradation that disables ASM Agent's decorative motion — the CRT flicker (4.2s), the scan sweep (9s), the progress marker and streaming cursor blink (1.06s), and smooth scrolling.
_Avoid_: reduced animation, motion safe

**Live Region**:
The decoupled announcement surface for streaming turns: a hidden `role="status" aria-live="polite"` for turn-state transitions and a `role="log"` on `#b-transcript` for navigable history without per-token thrashing (WCAG 4.1.3).
_Avoid_: aria-live container, announcement div

**Safe Area**:
The `env(safe-area-inset-*)` + `viewport-fit=cover` + `100dvh`/`visualViewport` handling that keeps the status line and prompt dock clear of the iPhone notch/Dynamic Island, home indicator, and virtual keyboard without `100vh` clipping.
_Avoid_: notch padding, viewport inset

**Reflow**:
The 320px / 200% zoom layout guarantee (WCAG 1.4.10) that status segments wrap or scroll, dialogs become full-width overlays, and `body {overflow:hidden}` does not permanently hide content.
_Avoid_: responsive wrap, mobile reflow

**Required Gate**:
The one required command, `npm run verify` (`scripts/verify.mjs`), run by the `build-and-test` job. It declares the required step list — manifest validation, toolchain, build, the required Test Classes, the promotion guard, dependency and sentinel checks, lint, audit — and every step runs even after a failure. No workflow YAML restates the steps, and a missing prerequisite fails the gate instead of being skipped.
_Avoid_: full test run, CI suite, pipeline

**Test Class**:
One of the five runner scopes: `offline`, `worker` and `browser` are required; `scheduled-browser` and `live` are optional. A class is executed by `scripts/run-tests.mjs`, which rejects `.only`, `.skip`, `.todo` and retry-only passes in the required classes.
_Avoid_: suite, tier, job, stage

**Test Manifest**:
`test/manifest.json`: the single declaration of which files and suites belong to which Test Class. The workflow files contain no test file lists, and a runnable file under `test/` that is not listed fails the gate.
_Avoid_: test list, CI matrix, discovery

**Staged Artifact**:
`_site/`, assembled once by `npm run build` from the allowlist in `scripts/build-site.sh`. It is immutable: nothing adds files to it or injects build metadata after staging. Its identity is `artifacts/site-inventory.json` (a sha256 per file plus one `treeDigest` over the sorted list) and `_site/build-info.json` (commit, WASM and lockfile digests, dependency versions); the promotion guard is `node scripts/site-inventory.mjs --verify _site`, run after testing, which fails on any byte that changed.
_Avoid_: build output, dist, bundle, upload

**Verified Candidate**:
The commit whose `build-and-test` run produced the Staged Artifact being published. It must still be the tip of `main` when the publisher runs, and the publisher job holds no checkout and executes no test — it consumes the artifact the gate verified.
_Avoid_: deploy commit, release, artifact

**Superseded Deployment**:
A publication run whose Verified Candidate is no longer the tip of `main`. It publishes nothing and reports an explicit no-op; the newer commit's own run publishes it. It is neither a failure nor a deployment claim.
_Avoid_: stale deploy, skipped deploy, cancelled deploy

**Vendor Staging**:
Copying a runtime library's bytes from the lockfile-installed package into `_site/vendor/**` at build time instead of loading it from a CDN. `scripts/check-deps.mjs` re-verifies the staged bytes against `node_modules` and keeps `index.html` free of version literals.
_Avoid_: bundling, vendored dependency, CDN fallback

**Pinned Toolchain**:
The versions declared in `scripts/toolchain.mjs` (Node, WABT, runner image) and the tools installed from them. `npm run toolchain` prints each pin against the resolved version; drift is fatal in CI and reported locally.
_Avoid_: tool versions, requirements, dependencies

**Live Probe**:
A check against deployed or external systems, declared as a `live`-class manifest entry (or flagged `live`). Probes are validated by the manifest but excluded from the required classes, so live traffic can never gate a pull request; generation probes are opt-in and budgeted in `scripts/live-health.mjs`.
_Avoid_: smoke test, e2e test, monitoring

**Sanitized Rendering**:
The one path an answer reaches the DOM through: `renderMarkdown` in `js/markdown.js` parses with the vendored marked and sanitizes with the vendored DOMPurify. Streamed model output and text fetched from arbitrary pages are untrusted, so the configuration is part of the security boundary, not a formatting detail: `FORBID_TAGS: ['style']` keeps a hostile answer from fetching a remote stylesheet (`@import`) or restyling the app around itself. Remote `img`/`video`/`audio` sources and the inline `style` attribute are deliberately still allowed — see the residual noted in the campaign report.
_Avoid_: markdown rendering, HTML sanitizing, cleanup, escaping
