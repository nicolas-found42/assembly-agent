# Turn loop: one event interface in the Bridge

The 2026-08-23 architecture review found the Turn loop split across `bridge.js` `send()` and `main.js` `doSend()` — one module fused by an eight-callback bag, with presentation (raf paint, empty-bubble drop, Tool Cards, sfx, announcements) welded into the callbacks, session persistence called at three hidden points inside the engine loop, the paid-model gate duplicated, and dead `window.__toolCard` globals as the only test reach. We deepen it in place: `runTurn(text, { key, model, on, persist?, search? })` becomes the sole entry point, emitting eight tagged event records (`round-started`, `delta`, `tool-started`, `tool-finished`, `round-final`, `aborted`, `errored`, `done`) and resolving to a `TurnSummary`; `checkAccess(model, key)` becomes the single shared gate policy. All three drivers (`main.js`, `test/tool-loop.mjs`, `scripts/sweep-free-models.mjs`) cut over in one change — two interfaces at one seam is worse than either endpoint. The domain term **Turn** enters `CONTEXT.md`.

## Considered Options

- Extract a new `js/turn.js` module now (rejected: `runRound` needs `sse_feed`-level engine internals, so the Bridge's exported interface must widen first — re-creating the leak the deepening removes; extraction stays cheap later once candidate 1's typed accessors shrink that interface)
- Keep eight named callbacks with structured payloads (rejected: the named-callback bag is how the split happened; one method records trivially in tests as `events.filter(e => e.type === …)`)
- `AsyncIterable<TurnEvent>` (rejected: pull-based iteration fights the high-frequency delta stream and adds buffering ceremony a zero-dependency codebase doesn't recoup)
- Move persistence wholly to the driver, saving on done/errored only (rejected: loses mid-turn saves — a tab closed during a long search drops the Turn from the sidebar)
- Delete the UI-side access check and rely on an `errored` event (rejected: the composer is already cleared by then — worse feedback for a misconfigured key)
- Fix the hardcoded `'webassembly'` empty-query fallback in the same change (rejected: mixes a semantics change into a structural refactor; the Sweep must attribute any Capability Tier delta to the refactor alone)
- Ship `runTurn` beside `send()` and migrate gradually (rejected: see clean cutover above)

## Consequences

- `tool-finished` carries the structured result `webSearch` already returns (`{ markdown, sources, failures, perSource }`), so `addToolCard` renders data instead of regex-splitting the `fmt` markdown — the block shape stops being accidental interface
- The `persist` hook fires at exactly today's three points (after user append, after budget-final pass, at end); error paths keep today's no-save behaviour
- `search?` is the same adapter seam ADR 0002 declares for tests; the Sweep keeps its `{ transport }` seam at `webSearch()` — both move with the rename, semantics unchanged
- Search Budget, `BUDGET_NUDGE`, parallel dispatch, role-4 history entries, and the Tool Call Table layout stay exactly as ADR 0002/0003 fixed them; offline tests keep driving real Scanner bytes
- `window.__toolCard(s)` (written today, read by nobody) are deleted; the duplicate `window.__asm.search` assignment collapses to one place
