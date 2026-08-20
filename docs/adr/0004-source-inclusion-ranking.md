# Source inclusion, fan-out, and ranking

Grilling #6 asked what decides a Candidate Source ships in `js/search.js` `webSearch`, how many Sources fan out at once, how blocks are ranked within the 12k `markdown.slice`, and how failures are handled — all under GH Pages static: no keys, CORS `*`, failure-tolerant `timed()` + `Promise.allSettled`.

## Considered Options

- Inclusion: strict keyless CORS `*` only vs pragmatic gated (CORS-conditional behind detector) vs generic Worker proxy for CORS-blocked opens. Chosen: strict as default (`License ∈ OSI/CC0/ODbL`, `CORS *` or `origin=*`, `Auth=No`, ToS allows anon fan-out, live `curl -I` ACAC `*`, relevance High, p50 <800ms) plus one free generic Worker route `GET /api/search?url=` / `/api/arxiv?q=` only for otherwise-qualifying sources (e.g., arXiv Atom) that are free and GH Pages–compatible. Reject paid or non-working.
- Fan-out cap: keep 8 vs cap 10 vs allow 13 if all work. Chosen: 13 is fine (4 existing Wikipedia/HN/GitHub/StackExchange + 9 P0 Wikidata/OpenAlex/Crossref/Semantic Scholar/DOAJ/Open Library/DBpedia/GDELT/Lobste.rs) — all keyless, no Tavily/Brave/Jina. Cap not firm; drop only if latency or rate breaks 8s `TIMEOUT`. No key-gated Sources ship by default.
- Ranking within 12k: grouped by Source weight (job order) then slice vs interleaved scorer vs round-robin. Chosen: grouped by Source weight, dedup `norm(url)` first-win, `deduped.join('').slice(0,12000)`. Do not call LLM inside `webSearch`; ranking is left to the chat model that synthesizes the Tool Round answer. Keeps `webSearch` fast (<1s p50, <2s p95) and avoids extra proxy/429 cost.
- Failure tolerance: no retry vs one retry after 1s for Timeout/429 vs manual banner retry. Chosen: one retry after ~1s for `AbortError` (8s timeout) and `429` only; other errors push to `failures[]` immediately. Still `failure-tolerant` — final `failures[]` surfaces as chip/banner but never blocks other Sources.

## Consequences

- Default fan-out is 100% keyless OSI/CC0/ODbL and works on GH Pages deployment without extra config. `DDG` dropped (95% empty baseline), keyed providers removed.
- Generic search proxy is optional and strictly for free, open, CORS-blocked Sources; it must add `access-control-allow-origin: *`, translate Atom/XML→JSON, and be rate-limited to avoid upstream abuse. It reuses the existing `asm-agent-proxy` Worker, not a new backend.
- `timed()` gains retry-once branch for Timeout/429; `failures[]` semantics unchanged. Wall-clock grows to ~9s p95 worst case but parallel batch still dominated by slowest Source.
- `js/search.js` `webSearch` stays grouped ranking; no scorer to maintain. Implementation for #6 is: add P0 Sources with `timed()` + `jfetch` + `fmt()`, wire retry, wire generic proxy route if arXiv ships, cap at 13.
