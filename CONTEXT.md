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
The server edge that receives `POST /api/chat` from the browser and forwards it to OpenRouter with the Operator Key.
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
The WAT code that reads the SSE stream and stages a pending Tool Call in the control block. Takes the first `function.name` it sees and concatenates every `arguments` fragment.
_Avoid_: parser, SSE reader, tokenizer

**Sweep**:
One run of `scripts/sweep-free-models.mjs`: the same task battery sent to every Free Model in turn, over the Proxy, with canned search results and every raw stream saved.
_Avoid_: benchmark, eval, test matrix

**Capability Tier**:
How far one Free Model gets through a Tool Round, L0 to L4. L0 accepts tools; L1 emits a Tool Call the Scanner reads; L2 the query fits the question; L3 it stops searching and answers by itself; L4 it obeys `BUDGET_NUDGE` when the Search Budget is spent. L3 and L4 are two exits, not two steps.
_Avoid_: score, grade, rating, level
