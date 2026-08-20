# Parallel Tool Calls

The Sweep found `liquid/lfm-2.5-2.6b:free` streaming two tool calls in one response (`"index":0` and `"index":1`, each with its own `id`); the Scanner appends every `arguments` fragment it sees, so both objects concatenated into `{...}{...}`, `JSON.parse` failed in `pendingToolCall()`, we sent `arguments: ""` and earned a 400 on every affected turn. ADR 0002 scoped this work to parse faults only, which would have meant taking the first call and dropping the rest; that boundary was deliberately widened to support parallel calls properly instead. The Scanner gains a per-turn tool call table, and an assistant turn carrying N calls is stored as one role-2 entry plus N-1 role-4 entries that `buildMessages()` coalesces back into a single assistant message with an N-element `tool_calls` array.

## Considered Options

- Take the first tool call, ignore the rest (rejected by decision: the model re-requests the dropped search next round, costing a Tool Round, and the loop silently discards model intent)
- Discourage parallel calls in the `BASIC AGENT` text (rejected: a request, not a guarantee; the 400 returns whenever a model ignores it)
- Widen the history entry to hold N tool calls and extend the 36-byte `history_get` struct (rejected: changes a format `js/bridge.js` and `test/smoke.mjs` both read, for no gain over a sibling-entry role)
- Store the whole `tool_calls` array as JSON in the existing `args` field (rejected: moves JSON assembly into the WAT/JS seam and makes the field mean two different things)
- Discriminate calls by parsing the provider's `"index"` integer (rejected: needs an int parser in WAT; a `"id":"` occurrence already marks the start of each call in every observed stream and in the OpenAI streaming contract)

## Consequences

- New role 4: "additional tool call belonging to the preceding assistant entry". Content is empty; it carries only tcid/name/args. Unknown roles were previously impossible, so `js/sessions.js` export and any history reader must tolerate it
- The 36-byte `history_get` struct, the entry layout, and every existing export keep their meaning; a role-2 entry still describes the first tool call, so a reader that ignores role 4 degrades to first-call-only rather than breaking
- Scanner gains a tool call table at 0x6800 (8 slots x 256B) inside the currently unused 0x6080-0x7FFF gap; `gTcid`/`gTcName` at 0x6000/0x6040 stay as slot 0's storage so existing reads keep working
- Slot boundary is an `"id":"` occurrence inside the `tool_calls` region of a line; the scan walks a line left to right handling `"id":"`, `"name":"` and `"arguments":"` in the order they appear, so a provider that packs several complete calls onto one line works the same as one that streams a fragment per line
- Calls beyond slot 8 are dropped rather than corrupting the accumulator; `sse_feed` records the overflow so the Sweep can see it happened
- `tool_pending` becomes count-based and a `tc_count` export is added; `tool_result_append`/`tool_result_flush` stay for the single-call path, and the parallel path writes role-3 entries straight through the existing `history_append` export, one per call id
- `send()` runs the round's searches together and appends one role-3 entry per call before the next round; a Tool Round is still one request, so the Search Budget keeps its meaning
- `main.js` fires `onToolStart`/`onToolDone` once per call, so a single round can show several searches
