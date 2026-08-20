# Baseline Search Benchmark — 2026-08-20

**Summary (one paragraph):** Live fan-out of `js/search.js` `webSearch` (5 keyless + 3 keyed skipped) was measured from Node `v26.7.0` (no CORS) over 20 mixed queries (tech/science/code — e.g. "WebAssembly SIMD", "CRISPR prime editing", "fusion tokamak ITER"; full list in `test/fixtures/baseline-search.json`) through the identical `timed`/`jfetch`/`fmt` pipeline with 8 s abort, dedup by normalized first-URL, and 12 k slice, driven by `test/baseline-search.mjs` at ~600 ms inter-query spacing. Aggregate wall time p50 260 ms / p95 815 ms (avg 321 ms); average 2.5 contributing sources per query and 1,873 bytes pre-slice (max 8,060, zero queries truncated), dedup hit 0.05/query. The run exposes the baseline's dominant risk: unauthenticated rate limits collapse throughput mid-burst — Wikipedia returned 429 for the last 11/20 queries and GitHub 403 for the last 10/20 (both healthy for the first ~10), so their 20-query success rates are 45 % and 50 % respectively, while HN, StackExchange and DDG stayed at 100 %; DDG was almost always empty (95 % empty, only one abstract hit), StackExchange 35 % empty, HN the only fully reliable source. Without burst throttling or keyed fallbacks, half the fan-out is unavailable under realistic usage and average markdown is thin (~1.9 k), making SLO and ranking work dependent on mitigating rate limits and replacing DDG's low yield.

**Replication (run 2, 2026-08-20T20:40Z, same harness/machine ~1 h later):** the run was repeated to separate stable properties from single-sample noise. Two results are deterministic and two are not. **GitHub's collapse is exactly reproducible** — 10 successes then `403` from query 11 onward in *both* runs, which identifies the cause precisely: the unauthenticated Search API cap of 10 requests/minute, and the harness's own 600 ms spacing packs all 20 queries into ~17 s, i.e. one quota window. **Wikipedia's is not** — 45 % (first `429` at query 10) in run 1 versus 90 % (first `429` at query 19) in run 2, so the anon Wikipedia limit depends on residual quota at start-of-run and the "45 %" figure below is one sample, not a rate. Everything else replicated exactly: HN 100 %, DDG 100 %/95 % empty (same single abstract hit), StackExchange 100 %/35 % empty (same 7 queries), dedup 1 hit total, 0/20 truncated, and identical per-source median bytes. Conclusion for downstream work: **treat the GitHub cap as a hard, predictable ceiling to design around, and Wikipedia's failure rate as a variable to measure again under real traffic — not as 45 %.**

## Per-source table (20 queries, 2026-08-20T19:42Z, Node direct)

| Source | Keyless? | Attempted | Skipped | Success | Empty (ok but 0 hits) | p50 (ok) | p95 (ok) | avg (all) | p50 bytes | p95 bytes | avg bytes | min–max bytes | Failures (sample) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| **wikipedia** | yes | 20 | 0 | 45 % (9/20) | 0 % | 273 ms | 815 ms | 180 ms | 736 B | 772 B | 728 B | 685–772 B | `429` ×11 (after query 10) |
| **hn** (HN Algolia) | yes | 20 | 0 | **100 %** (20/20) | 5 % (1/20) | 236 ms | 324 ms | 245 ms | 588 B | 818 B | 613 B | 490–818 B | — |
| **ddg** (DuckDuckGo Instant) | yes | 20 | 0 | 100 % (20/20) * | **95 %** empty | 71 ms | 171 ms | 85 ms | 1827 B† | 1827 B | 1827 B | 1827 B | — (*empty ≠ fail) |
| **stackexchange** | yes | 20 | 0 | 100 % (20/20) | 35 % (7/20) | 118 ms | 251 ms | 131 ms | 612 B | 927 B | 509 B | 165–927 B | — |
| **github** | yes | 20 | 0 | 50 % (10/20) | 5 % (1/10 ok) | 290 ms | 406 ms | 151 ms | 740 B | 6749 B‡ | 1440 B | 652–6749 B | `403` ×10 (rate limit after query 10) |
| **tavily** | no | 0 | 20 | — (skipped, no key) | — | — | — | — | — | — | — | — | skipped |
| **brave** | no | 0 | 20 | — (skipped, no key) | — | — | — | — | — | — | — | — | skipped |
| **jina** | no | 0 | 20 | — (skipped, no key) | — | — | — | — | — | — | — | — | skipped |

† DDG only returned `AbstractText` for 1/20 queries ("black hole information paradox" → 1,827 B); all other hits were empty strings counted as success but produced no `fmt` block. StackExchange/GitHub bytes are `fmt` blocks (title+url+snippet), not raw JSON.
‡ GitHub max 6,749 B is "mRNA vaccine stability" (long descriptions); median is 740 B.

**Totals across 20 queries:**
- Wall time: p50 260 ms, p95 815 ms, avg 321 ms (per-query `Promise.allSettled` fan-out).
- Sources contributing per query: avg 2.5, max 4, min 1 (post-rate-limit tail avg 1.4).
- Total markdown before 12 k slice: avg 1,873 bytes, max 8,060, **0/20 truncated** (12 k headroom ample today; will tighten if richer sources added).
- Dedup hits: 1 total across 20 queries (0.05/query) — URL-norm dedup almost never fires at this query diversity.
- Failure counts: `wikipedia:11, hn:0, ddg:0, stackexchange:0, github:10` (keyed 0/0/0 skipped).

## How it was run

- Harness: `test/baseline-search.mjs` — mirrors `js/search.js` (`TIMEOUT=8000`, `timed`+`AbortController`, `jfetch`, `fmt`, URL-norm `dedup`, `slice(0,12000)`). Per-source `ms`/`bytes`/`error` captured via `performance.now()` + `Buffer.byteLength`. 600 ms delay between queries to avoid intentional burst; sequential queries, parallel sources per query. Keys read from `TAVILY_KEY`/`BRAVE_KEY`/`JINA_KEY` (absent → skipped, as in prod).
- Raw data: `test/fixtures/baseline-search.json` (per-query `perSource`, `totalMs`, `totalBeforeSlice`, `failures`, `dedup`, plus aggregates). Re-run with `node test/baseline-search.mjs`.
- Fixture mode: `test/tool-loop.mjs` harness pattern was consulted; live network used here (not stubbed) because the ticket asks for real latency distribution.

## Browser CORS vs Worker differences

| Dimension | Browser (`fetch` from GH Pages / `localhost`) | Cloudflare Worker (`worker/api-chat.js` proxy) | Baseline run (Node direct) |
|---|---|---|---|
| **CORS enforcement** | Enforced — needs `Access-Control-Allow-Origin`. All 5 keyless currently send `*` (Wikipedia `origin=*` param, HN `*`, DDG `*`, SE `*`, GitHub `*`) so browser succeeds, but any new source lacking CORS would fail in browser and require Worker proxying. | Not enforced — Worker can fetch any origin. | Not enforced (same as Worker). So Node numbers are optimistic for browser if a future source drops CORS. |
| **Origin / IP for rate limits** | Client IP (diverse, per-user quota). GitHub 10 req/min per IP is per visitor, so burst is less visible in single-user testing. Wikipedia anon limit is per-IP + `origin=*` pool. | Worker egress IP (shared, Cloudflare pool) — far tighter: all Anonymous Users share the Worker's GitHub/Wikipedia quota, so rate-limit collapse seen at query 10 would happen globally in production, not just in this harness. | Single test-machine IP — closest to "one browser user bursting". Demonstrates the per-IP ceiling but undercounts Worker-shared contention. |
| **Headers / auth** | Cannot safely hold keyed tokens (exposed). Keyed sources (tavily/brave/jina) must be proxied via Worker secrets (current `js/search.js` reads keys from `localStorage`, which is browser-only and only suitable for BYO keys). | Can hold Operator Key, enforce per-IP `Rate Limit`. Proper place for keyed fan-out. | Env keys via `process.env` — simulates BYO, not Operator path. |
| **Timeout observable** | `AbortController` + 8 s abort identical; browser may add extra CORS preflight latency. | Same 8 s abort; no preflight. | Same 8 s abort; no preflight — latencies slightly low vs browser. |
| **Practical takeaway** | Baseline's `429`/`403` after 10 queries is a preview of Worker behavior under load. For expansion, new sources should be chosen CORS-friendly if they must run client-side, or moved to Worker if they need keys / lack CORS. Any latency SLO must budget for 95th of ~800 ms (Wikipedia tail) and for mid-burst failures. | | |

## Reading the numbers

- **If you see 45 %/50 % and think the APIs are broken:** they're not — it's the unauthenticated tier. Adding a token (GitHub `Authorization: Bearer …` raises to 5 k req/hr) or spacing queries >6 s would restore success to ~100 %. The harness intentionally did not.
- **DDG is keyless but low-value:** 95 % empty means it contributes almost no markdown today; candidates that replace it need measured abstract/full-text yield, not just uptime.
- **Headroom:** 12 k slice was never hit (max 8 k with GitHub's outlier). Adding richer sources (e.g., Jina 4 k, Tavily 5 results) will push median above 4 k — re-measure before tightening slice.

## Reproduce

```bash
node test/baseline-search.mjs   # writes test/fixtures/baseline-search.json
# with keys:
TAVILY_KEY=… BRAVE_KEY=… JINA_KEY=… node test/baseline-search.mjs
```

## Replication — run 2 (2026-08-20T20:40Z)

Same harness, same 20 queries, same machine, no keys. Raw data: `test/fixtures/baseline-search-run2.json`.

| Metric | Run 1 (19:42Z) | Run 2 (20:40Z) | Stable? |
|---|---:|---:|---|
| Wall p50 | 260 ms | 307 ms | ~ (run-to-run jitter) |
| Wall p95 (interpolated) | 558 ms | 377 ms | ~ |
| Wall avg | 321 ms | 297 ms | yes |
| Sources contributing / query | 2.50 | 2.95 | tracks Wikipedia's success rate |
| Bytes before slice (avg / max) | 1,873 / 8,060 | 2,198 / 8,038 | yes |
| Queries truncated at 12 k | 0/20 | 0/20 | **yes** |
| Dedup hits (total) | 1 | 1 | **yes** |
| wikipedia success | 45 % (first fail q10) | **90 %** (first fail q19) | **no — variable** |
| hn success | 100 % | 100 % | **yes** |
| ddg success / empty | 100 % / 95 % | 100 % / 95 % | **yes** |
| stackexchange success / empty | 100 % / 35 % | 100 % / 35 % | **yes** |
| github success | 50 % (first fail q11) | 50 % (first fail q11) | **yes — deterministic cap** |

Run-2 per-source latency (ok only): wikipedia p50 278 ms / p95ᵢ 380 ms · hn 278 / 375 · ddg 108 / 189 · stackexchange 143 / 217 · github 262 / 306. Total run wall clock 17.4 s for 20 queries.

**The GitHub number is the actionable one.** 10-then-403, twice, at the same query index, is the documented unauthenticated `search/repositories` limit of 10 req/min. It is not flakiness and it will not improve with retries: any burst above 10 searches/minute from one egress IP loses GitHub entirely. Per the Worker column above, a Cloudflare Worker shares one egress IP across *all* users, so in the deployed topology this ceiling is global, not per-visitor — roughly 10 searches per minute for the entire deployment before GitHub drops out of every user's results.

## Correction to run-1 reporting — the "p95" column

The harness computes `p95` as `sorted[Math.floor(n * 0.95)]`. For n ≤ 20 that index is `n − 1`, so **the reported p95 is simply the maximum observation**, not a 95th percentile. This affects only presentation, not the raw data (`results[]` in both fixtures holds every per-source measurement).

Corrected wall-time figures using linear interpolation:

| | Run 1 | Run 2 |
|---|---:|---:|
| p95 as reported (= max) | 815 ms | 404 ms |
| p95 interpolated | **558 ms** | **377 ms** |

Per-source interpolated p95 (ok only), run 1: wikipedia 706 ms, hn 306 ms, ddg 161 ms, stackexchange 225 ms, github 370 ms. **Any latency SLO should be set against ~560 ms, not 815 ms** — but note that at n=20 neither estimate is well-resolved in the tail; a burst-realistic SLO wants a run with more queries and production-like spacing.

## Verification of this report

Both fixtures were re-derived independently of the harness's own aggregate block: every headline number in the run-1 summary above (wall p50 260 / avg 321, 2.50 sources/query, 1,873 avg bytes, max 8,060, 0 truncated, 1 dedup hit, failure counts `wikipedia:11 github:10`, and all five per-source success/empty rates) recomputes exactly from `results[]`. The two items flagged for correction — the p95 estimator and Wikipedia's variability — are the only discrepancies found.

## Reproduce (run 2)

```bash
node test/baseline-search.mjs   # overwrites test/fixtures/baseline-search.json
# run from a scratch cwd to keep committed fixtures intact, then move the output alongside:
#   test/fixtures/baseline-search.json       (run 1)
#   test/fixtures/baseline-search-run2.json  (run 2)
```
