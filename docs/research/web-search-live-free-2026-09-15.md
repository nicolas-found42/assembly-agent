# Live provider verification — keyless search and page reading on this date

**Date:** 2026-09-15 · **Probed from:** the developer machine (macOS, Node 26), `curl -s -D -` with `Origin: https://nicolas-found42.github.io` for every header read, and one browser-origin live turn (`node scripts/live-smoke.mjs`) against the staged site at `http://127.0.0.1:58861/assembly-agent/`.
**Purpose:** the verification record ADR 0015 requires — what the keyless providers actually did today, what limits are real, and what remains unverified. No endpoint described here is guaranteed free or available forever; re-verify before relying on any of it. A re-verification pass at 16:42 EDT confirmed the fixes that landed today: the MWMBl drawer entries carry title/url only (an object in the live `extract` fields no longer renders as `[object Object]`), and Openverse image results with no title fall back to a human-readable label instead of an empty one. Two of five live attempts in this session never delivered the typed send (no request left the page); the three completed turns and the fixture browser suite exercise the same send path, so this reads as a session-environment transient rather than a product defect — flagged here for honesty.
## Reader (r.jina.ai) — the page-read path

| Probe | Result (verbatim) |
|---|---|
| `r.jina.ai/https://example.com` (no Origin) | `HTTP/2 200`, **no `access-control-allow-origin`** — the header is origin-echo, so a plain curl shows none |
| Same URL, `Origin: https://nicolas-found42.github.io` | `HTTP/2 200` · `access-control-allow-origin: https://nicolas-found42.github.io` · `access-control-allow-credentials: true` · `access-control-max-age: 25200` · `x-ratelimit-limit: 20, 20;w=60` · `x-ratelimit-remaining: 19` |
| `r.jina.ai/https://lite.duckduckgo.com/lite/?q=who+has+the+most+points+in+nba+history` | `200` with the origin-echo ACAO; body: `Title: …` / `URL Source: …` / `Markdown Content:` + numbered results behind `https://duckduckgo.com/l/?uddg=<percent-encoded destination>&rut=<hex>` |
| `r.jina.ai` reader of `www.basketball-reference.com/leaders/pts_career.html` | `HTTP/2 403` JSON: `{"code":40305,"name":"AbuseAlleviationError","message":"Anonymous access to domain www.basketball-reference.com blocked until Tue Sep 15 2026 19:21:27 GMT… DDoS attack suspected"}` — still carries the origin-echo ACAO |

Findings: (1) the reader is browser-readable (origin echo, not a literal `*` — ADR 0009's wording was stale but the access rule holds); (2) the 20 req/min/IP limit is real and matches `createLimiter(20)`; (3) per-domain abuse blocks exist and time out on their own — the app must treat 403 as a retrieval outcome, not evidence, and try another candidate.

## Direct page reads vs the reader

`curl -s -D - -H 'Origin: https://nicolas-found42.github.io' https://www.basketball-reference.com/leaders/pts_career.html` → `HTTP/2 200` with **no `access-control-allow-origin`** — direct cross-origin reads are CORS-blocked in a browser. Decision unchanged: try the direct GET, fall back to the reader; never `no-cors`.

## Other keyless hosts (re-probed 2026-09-15)

- `site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard` → `200`, `access-control-allow-origin: *` (score questions keep their scoreboard Source).
- `api.mwmbl.org/search/?s=test` → `200`, `access-control-allow-origin: *`.
- `lite.duckduckgo.com/lite/?q=…` direct → `HTTP 202`, no ACAO — irrelevant to the browser because it is only ever reached *through* the reader, which fetches server-side.

## Browser-origin live turns (2026-09-15, chromium via `npm run serve` + `scripts/live-smoke.mjs`)

Three factual questions end-to-end on the real deployment path (anonymous free model `inclusionai/ling-3.0-flash-vl:free` through the Operator-Key proxy):

1. `who has the most points in nba history? how many points od they have?` — planned query `NBA all-time career points leaders regular season` (typo preserved in the question, corrected intent in the plan); **no ESPN scoreboard request**; direct CORS-blocked reads fell back to the reader; `landofbasketball.com` read succeeded and carried the data-through note "stats updated June 14, 2026"; `basketball-reference.com` was blocked by the reader's abuse alleviation (403) and surfaced as the honest footer note "Some sources were unreachable."; answer: LeBron James, 43,440 regular-season points, top-5 table, source named. Outbound request carried the sampled clock line.
2. `what is the capital of Australia` — fan-out + two reader reads; answer verified across several sources (Wikipedia, Britannica, Mappr); unrelated material (capital-punishment statistics) was explicitly reported as not part of the answer; drawer `Sources (25)`.
3. `who won the 2018 world cup` — historical planning; reader reads of the 2018 final pages; answer France 4–2 Croatia, July 15 2018, Luzhniki; wording check ran ("checked wording"); drawer `Sources (12)`.

One date-observation worth keeping: the DuckDuckGo lite snippet for the NBA question showed 42,184 points while the page the application actually read states 43,440 (updated 2026-06-14) — exactly why the pipeline reads the selected answer pages instead of trusting a search snippet, and why `fetchedAt` is never turned into a publication or data-through date.

## Limits and what is not verified

- The reader's anonymous access rules change (abuse blocks, rate limits, per-domain blocklists); nothing here is a promise of availability.
- The browser turn verifies CORS behavior for the origins those three questions touched; origins reached only by other intents (arXiv via the optional Worker, academic APIs under an academic plan) were not live-probed today.
- Live model answers vary run to run; the fixed regression coverage remains the offline suites and the fixture journeys, never the live answers.
