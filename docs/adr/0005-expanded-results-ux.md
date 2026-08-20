# Expanded multi-source UX

Grilling #7 asked how `js/search.js` `webSearch` results should be presented when fanning out to 13 keyless Sources (vs today 5+3 keyed), how failures and dedup surface, how Tool Rounds accumulate within the 5-round Search Budget, and whether settings expose per-Source toggles — all on the amber CRT static layout (`js/main.js:339` Tool Card, `styles.css` `tool-card`/`tool-src`, failure-tolerant `timed()` + `Promise.allSettled`).

## Considered Options

- Card layout: grouped-by-Source-weight (current `webSearch` job order) with per-Source collapsible headers vs interleaved relevance-sorted flat list vs separate chip-per-Source. Chosen: grouped-by-Source-weight inside one Tool Card per Tool Call. Ranking is grouped by design (ADR 0004: `deduped.join('').slice(0,12000)`, chat model synthesizes relevance), so UI must preserve Source weight ordering. One card per call keeps Tool Round identity (`onToolStart`/`onToolDone` per call) and bounds height when 13 Sources return.
- Attribution & dedup: show `tag + url + snippet(220)` per block with silent `norm(url)` first-win vs show dedup count/merged attribution. Chosen: silent dedup, first Source wins, no counter. Dedup fires 0.05/query today (baseline) and will grow with overlapping P0 (Wikidata/OpenAlex/Crossref), but surfacing it ties UI to `norm()` internals and adds noise for a rare case.
- Failure visibility: inline `· MISSED: name,…` in `.tool-status` vs promoted amber banner/chip vs hidden unless total failure. Chosen: inline `MISSED:` remains; partial failures get a non-blocking amber chip (`FAILED:` only when `sources==0`). Matches ADR 0004 retry-once semantics (`failures[]` never blocks other Sources) and baseline (Wikipedia 45%, GitHub 50% after burst → partial failure is normal, not exceptional).
- Tool Rounds / Search Budget accumulation: stack verbatim (current `onRoundStart` → new `AGENT ▸` bubble + `toolCards=[]`) vs collapse prior rounds into one accordion vs single merged card. Chosen: stack verbatim, auto-collapse older `tool-card.collapsed`. Preserves Budget accounting (5 hops, Sweep Tiers L3/L4 per-round), keeps WAT `Tool Call Table` ↔ UI parity, and matches multi-card parallel-call expectation (`878ec46`).
- Settings per-Source toggles: 13 toggles in `asm.settings` modal vs always-on keyless vs hidden Advanced. Chosen: always-on keyless in v1; reserve a single hidden `Advanced → Sources` collapsible for future if latency/429 warrants opt-out. 13 toggles bloat SET, contradict "100% works on GH Pages without config" (ADR 0004), and cap is not firm (drop only if `TIMEOUT 8s` SLO breaks).

## Consequences

- Implementation for #7 is UX-only (no `js/search.js` data path change): `js/main.js:339` `addToolCard` renders per-Source headers `TAG · n hits · ms` with collapsible `tool-src` groups, sorts groups by `webSearch` job order, keeps `.tool-status` inline `MISSED:` and adds banner only on full failure; `styles.css` gains per-Source header affordance but keeps `tool-card` border model. #8 Prototype can wireframe directly from this without new Sources.
- Content contract unchanged: `markdown` remains grouped `fmt` blocks, `sources: deduped.length`, `failures: []`; no scoring or ranking logic moves into `webSearch`.
- CONTEXT.md gains `Tool Card`; Map #1 gains #7 entry and #8 unblocked.

## Wireframe (for #8 prototype)

One Tool Round with 2 parallel calls → two stacked Tool Cards:

```
[AGENT ▸ answer bubble]
┌─ ▶ web_search("WASM SIMD") · 8 SOURCES · MISSED: wikidata ─────────┐
│  ▼ WIKIPEDIA · 3 hits · 212ms                                      │
│    [WIKIPEDIA] WebAssembly SIMD — https://en.wikipedia.org/wiki/…   │
│    snippet 220 chars…                                               │
│  ▶ OPENALEX · 3 hits · 180ms                                       │
│  ▶ CROSSREF · 1 hit  · 310ms  (collapsed)                           │
│  ▶ GITHUB · 4 hits · 290ms                                          │
│  … (up to 13, collapsed headers keep card < 60vh; card itself      │
│      collapsed after done → click header to expand)                 │
└────────────────────────────────────────────────────────────────────┘
┌─ ▶ web_search("CRISPR") · 7 SOURCES ────────────────────────────────┐
│  (second parallel call, same round)                                 │
└────────────────────────────────────────────────────────────────────┘
```

Prior rounds stay in DOM but `collapsed`. Failure chip: inline `· MISSED:` inside header status; full `FAILED: timeout, 429` replaces `n SOURCES` when `sources==0`. No per-Source settings surface in v1.
