# ASM Agent

Static amber CRT chat that talks to OpenRouter through a WAT engine. The context covers chat, model catalog, and free-tier access.

## Language

**Free Model**:
A model whose OpenRouter id ends with `:free` and is available at zero cost on the free tier.
_Avoid_: free-tier model, zero-cost model

**Operator Key**:
The single `sk-or-...` key owned by the operator and held only on the server to authorize free-model requests.
_Avoid_: shared key, public key, embedded key

**Anonymous User**:
A visitor who uses the agent without supplying an API key.
_Avoid_: guest, unauthenticated user

**BYO User**:
A visitor who supplies their own OpenRouter key via SET.
_Avoid_: logged-in user, paid user

**Proxy**:
The server edge that receives `POST /api/chat` (and optionally `GET /api/search?url=` / `/api/arxiv?q=` for a CORS-blocked free Source) from the browser and forwards it — chat to OpenRouter with the Operator Key, search to the upstream open API with `access-control-allow-origin: *`.
_Avoid_: backend, gateway, middleware

**Rate Limit**:
The per-IP quota the Proxy can enforce on Anonymous Users to protect the Operator Key. Currently not enforced — Anonymous Users rely on the Operator Key's OpenRouter limit (429); enforcement is deferred until abuse is observed.
_Avoid_: throttling, quota

**Preset**:
A named system prompt the drawer offers. `BASIC AGENT` is the default; `RESEARCH ANALYST`, `ASSEMBLY GURU` and `TERSE CODER` remain available.
_Avoid_: template, persona, profile

**Tool Call**:
The structured request a model streams back to run `web_search`, carrying a name and a JSON `arguments` string.
_Avoid_: function call, tool invocation

**Tool Round**:
One request to the model plus one `web_search` run whose result is fed back as a `role:"tool"` message.
_Avoid_: iteration, turn, hop

**Search Budget**:
The largest number of Tool Rounds one turn may spend (`MAX_TOOL_ROUNDS`, currently 5). The only guaranteed stop in the tool loop: when it runs out, a final tools-removed pass nudged by `BUDGET_NUDGE` forces an answer.
_Avoid_: tool limit, max rounds, retry limit

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
How far one Free Model gets through a Tool Round, L0 to L4. L0 accepts tools; L1 emits a Tool Call the Scanner reads; L2 the query fits the question; L3 it stops searching and answers by itself; L4 it obeys `BUDGET_NUDGE` when the Search Budget is spent. L3 and L4 are two exits, not two steps.
_Avoid_: score, grade, rating, level

**Source**:
A single origin `webSearch` fans out to via `timed()` + `jfetch` + `fmt()` (e.g., `WIKIPEDIA`, `OPENALEX`). Each Source has a tag, a URL builder, and a `norm(url)` dedup key. All default Sources are keyless, CORS `*`, and work on the GH Pages deployment.
_Avoid_: provider, endpoint, engine

**Candidate Source**:
A Source evaluated in research harvest but not yet in the `webSearch` fan-out. Filtered by the Inclusion Checklist before it ships.
_Avoid_: candidate, potential source

**Inclusion Checklist**:
The gates a Candidate Source must clear to ship: license OSI/CC0/ODbL, CORS `*` (or `origin=*`), keyless Auth=No, ToS allows anonymous client fan-out, live `curl -I` shows `access-control-allow-origin: *`, relevance High for code/tech/science, p50 <800ms and fits 8s `TIMEOUT`. Conditional `*` via Worker generic proxy is allowed only if free and GH Pages–compatible.
_Avoid_: criteria, filter

**Fan-out**:
The parallel `Promise.allSettled(jobs)` batch inside one `webSearch` call. Each job is a `timed(name, fn, failures)` Source. Default is up to 13 keyless Sources; no key-gated Sources ship by default.
_Avoid_: batch, fanout

**Ranking**:
Ordering of deduped `fmt` blocks before the 12k `markdown.slice`. Grouped by Source weight (job order) — chat model does relevance ranking when it synthesizes the answer, not `webSearch` itself.
_Avoid_: scoring, sorting, ordering

**Search Proxy**:
Optional Worker route `GET /api/search?url=` (and `/api/arxiv?q=`) that forwards a CORS-blocked open source (e.g., arXiv Atom) through the same Worker that holds the Operator Key, adds `access-control-allow-origin: *`, and translates to JSON. Free, no key, only for sources that already pass the rest of the Inclusion Checklist.
_Avoid_: cors proxy, gateway
