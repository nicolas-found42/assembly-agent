# Free Model Capability Sweep

Every existing test is offline, so nothing told us whether a real Free Model can drive the tool loop — and OpenRouter cannot tell us either, because its Tool Call Error Rate counts only requests that already ended in a Tool Call, so a model that answers in prose instead of calling the tool never enters the denominator (see `docs/research/openrouter-free-tool-support.md`). We add `scripts/sweep-free-models.mjs`: a live Sweep that drives the real `dist/agent.wasm` and real `js/bridge.js` over the Proxy against every Free Model, with canned search results, and assigns each a Capability Tier. The catalog is not gated on the result — the Sweep exists to find faults in our own Scanner and to record where each model's floor is.

## Considered Options

- Gate the catalog automatically on Sweep results (rejected: a live Sweep varies day to day; curation stays manual)
- Standalone script that builds its own request and reads raw SSE (rejected: tests a different program than we ship; the Scanner is the fragile part and must be in the loop)
- Live six-source `webSearch` during the Sweep (rejected: a slow Wikipedia changes the tool text, and a search failure reads as a model failure; canned results keep the model the only variable)
- Direct to OpenRouter on a BYO key instead of the Proxy (rejected: the Proxy on the Operator Key is what an Anonymous User actually gets; free-tier limits are per account, not per key, so a separate key on the same account would not have isolated quota anyway)
- Pin `temperature: 0` for reproducibility (rejected: the product sends no temperature, so it would measure a model no user meets; three repeats of T1 measure real consistency instead)
- LLM-as-judge for answer quality (rejected: a second project; judge noise on weak-model output is comparable to the signal)
- Raise or remove the Search Budget first (rejected: it is one of the things the Sweep measures, and the weakest model is capped by completion tokens plus forced reasoning inside round 1, which more rounds cannot help)
- Delete `RESEARCH ANALYST` when adding `BASIC AGENT` (rejected: destructive, no benefit; saved sessions keep their own stored text either way)

## Consequences

- New Preset `BASIC AGENT` is first in `PRESETS` and the new default, changing `js/sessions.js` (`newSession` default) and `js/main.js` (empty-textarea fallback); it names one tool, permits more than one search, gives a reason to stop rather than a count, carries a "results did not answer" instruction for the `BUDGET_NUDGE` path, and contains no example text a small model could imitate as prose
- The Sweep measures **model plus Preset** as a pair — with one prompt for every model it can no longer attribute a pass to the model alone, traded for equal terms across the table
- Capability Tier L0–L4 per Free Model, not pass/fail: L1 faults are ours to fix, L3 faults are the model's floor to record, L4 faults are ours again because the fallback text is our code
- Task battery of four: T1 one search (repeated 3x), T2 no search needed, T3 two searches, T4 well-formed but irrelevant results to force Search Budget exhaustion — T4 must not return empty, because empty markdown makes `tool_result_flush` skip the `role:"tool"` entry
- L4 is only reachable when a model fails L3, so T4 exists solely to provoke it
- Four mechanical quality checks: non-empty final, not the "Search budget spent" fallback, cites a URL present in the canned search text, no repeated 40+ char sentence
- Every request's HTTP status is recorded; a 429 marks the case **not tested**, never failed
- Also recorded per case: Tool Rounds used, `finish_reason`, and streamed content length (true `usage` needs `stream_options.include_usage`, which the product does not send and we are not adding)
- Roughly 270 requests per full Sweep against a 1000/day account limit shared with live Proxy traffic; sequential, paced under 20 RPM, progress saved per model so a 429 pauses rather than destroys a run
- `test/` stays offline with no exceptions; the Sweep lives in `scripts/`, raw streams in gitignored `.scratch/sweep/<date>/`, report in `docs/research/`
- A raw stream that exposes a Scanner fault graduates to `test/fixtures/` as an offline canned-SSE regression — the path from Sweep to the existing test style
- Tool support is a (model, endpoint) property; model-level `supported_parameters` is a union across endpoints, so the catalog `TOOLS` mask is trustworthy only while a Free Model has one endpoint (16 of 17 today)
- **Amended:** the "parse faults only" boundary above was deliberately widened to
  support parallel tool calls properly — see `0003-parallel-tool-calls.md`
