# Baseline Search Benchmark — 2026-08-20

**Summary (one paragraph):** Live fan-out of `js/search.js` `webSearch` (5 keyless + 3 keyed skipped) was measured from Node `v26.7.0` (no CORS) over 20 mixed queries (tech/science/code — e.g. "WebAssembly SIMD", "CRISPR prime editing", "fusion tokamak ITER"; full list in `test/fixtures/baseline-search.json`) through the identical `timed`/`jfetch`/`fmt` pipeline with 8 s abort, dedup by normalized first-URL, and 12 k slice, driven by `test/baseline-search.mjs` at ~600 ms inter-query spacing. Aggregate wall time p50 260 ms / p95 815 ms (avg 321 ms); average 2.5 contributing sources per query and 1,873 bytes pre-slice (max 8,060, zero queries truncated), dedup hit 0.05/query. The run exposes the baseline's dominant risk: unauthenticated rate limits collapse throughput mid-burst — Wikipedia returned 429 for the last 11/20 queries and GitHub 403 for the last 10/20 (both healthy for the first ~10), so their 20-query success rates are 45 % and 50 % respectively, while HN, StackExchange and DDG stayed at 100 %; DDG was almost always empty (95 % empty, only one abstract hit), StackExchange 35 % empty, HN the only fully reliable source. Without burst throttling or keyed fallbacks, half the fan-out is unavailable under realistic usage and average markdown is thin (~1.9 k), making SLO and ranking work dependent on mitigating rate limits and replacing DDG's low yield.

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
