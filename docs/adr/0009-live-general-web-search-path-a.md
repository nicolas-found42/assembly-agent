# Pure-static live general-web search (Path A) with 4 keyless Sources

GH Pages is static and holds no secrets. Fan-out had 25 keyless Sources (12 code/science + 13 general) via Promise.allSettled + timed() with 8s TIMEOUT and p50 <800ms. We add 4 general-web Sources that pass the Inclusion Checklist unconditionally via ACAO * and stay $0 forever: DDG IA (api.duckduckgo.com), WIKI OPENSEARCH + REST Summary (w/api.php?origin=*), OPENVERSE (api.openverse.org with Origin), and MWMBl (api.mwmbl.org/search/?s= — s not q). Fan-out goes 25 → 29, still parallel, p95 ~495ms, no Search Proxy change. Worker-assisted SearXNG (B) stays deferred.

## Considered Options

- B) Self-hosted SearXNG on Fly 256MB auto_stop via GET /api/search?url= allowlist + Common Crawl + Jina — rejected as default: Fly free allowances ended 2025-07-02, now trial credit then ~$1.94/mo, not $0 forever; adds one Proxy route and cold-start cost; keep as opt-in later.
- A+B) Ship 29 + SearXNG together via same allowlisted Proxy — rejected now for same cost reason; share route if B later opts in.
- 3-source slice (DDG IA + WIKI OPENSEARCH + OPENVERSE only, 28) — considered; mwmbl adds AGPL-3.0 crawl 42KB for same cost and is direct * via correct ?s= (late probe 2026-08-24), so we ship 4.

## Decision

Ship pure-static Path A with 4 Sources, all keyless CORS * and GH Pages–compatible:

- DDG IA `https://api.duckduckgo.com/?q=&format=json&pretty=0&no_html=1&skip_disambig=1` — fires when q 3–200 chars; returns '' if AbstractText+Answer+RelatedTopics empty; via cachedJson + hashUrl 10-min sessionStorage cache.
- WIKI OPENSEARCH `w/api.php?action=opensearch&search=&limit=3&origin=*` + 2× `api/rest_v1/page/summary/` parallel — fires when q ≥3, skip ^who is|^define (those route to WIKIDATA SPARQL/DICTIONARY); capped via applyWikiCaps WIKI OPENSEARCH ≤2.
- OPENVERSE `api.openverse.org/v1/images/?q=&page_size=3` — fires when visual intent \b(image|photo|picture|logo|cover|artwork|painting|diagram|icon)\b or q ≥2 tokens; behind anonLimiter = createLimiter(15) + cachedJson 10-min TTL; attribution `— via Openverse` required; anon burst 20/min.
- MWMBl `api.mwmbl.org/search/?s=&page_size=3` — fires when q ≥3; note param s not q (q → 422 per live probe); direct ACAO * 42KB; via cachedJson 10-min TTL.

Heuristic miss is legal (return ''). TAG adds DDG IA, WIKI OPENSEARCH, OPENVERSE, MWMBl. Ranking keeps applyWikiCaps (now also WIKI OPENSEARCH ≤2) → smartSlice 12k.

Live ACAO * verified 2026-08-24 curl -I: api.duckduckgo.com → ACAO * 76ms, w/api.php?origin=* → ACAO *, index.commoncrawl.org → ACAO * (for later B), r.jina.ai → ACAO *, api.mwmbl.org/search/?s=test → ACAO * (probe §19; ?q= 422), searx.be → no ACAO, Brave → 422 token, corsproxy.io → 403 keyless_legacy_url.

Latency: all p50 76–320ms (mwmbl 495ms max), wall max 495ms → p95 <800ms per Source, <8s TIMEOUT safe. No sequential Common Crawl + Jina chain in A. Each job via timed() retry once only on AbortError/429.

## Consequences

- GH Pages deploy stays $0 with no Proxy change; no Fly VM, no Search Proxy allowlist yet.
- Fan-out grows 25 → 29 default; Tool Card shows 29 SOURCES · MISSED: … failures never block other Sources.
- Jina limiter 20/min and anonLimiter 15/min stay per-Turn module-scoped with sessionStorage cache, so bursts surface as MISSED not FAILED.
- If Fly SearXNG later ships as opt-in, reuse single GET /api/search?url= allowlisted route (asm-searxng.fly.dev, index.commoncrawl.org, export.arxiv.org) with same timed()+jfetch pattern.
- To reproduce: curl -I "https://api.duckduckgo.com/?q=test&format=json", curl -I "https://en.wikipedia.org/w/api.php?action=opensearch&search=test&limit=3&format=json&origin=*", curl -I -H "Origin: https://example.com" "https://api.openverse.org/v1/images/?q=cat", curl -D - "https://api.mwmbl.org/search/?s=test" — all 200 ACAO *.
