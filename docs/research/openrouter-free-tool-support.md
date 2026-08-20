# OpenRouter `:free` models and tool-calling support

**Purpose:** establish the real capability floor before we point a live stress test of the agent's
tool-calling loop at the weakest free models.

**Snapshot taken:** `2026-08-20T02:12:54Z` (UTC), via an unauthenticated
`GET https://openrouter.ai/api/v1/models` (414 models total, 17 with an id ending in `:free`).
Endpoint-level data was taken in the same session from
`GET https://openrouter.ai/api/v1/models/{id}/endpoints`.

> **This is a snapshot, not a standing list.** OpenRouter's own docs warn that "Free model
> availability changes frequently" ([Free Models Router](https://openrouter.ai/docs/guides/routing/routers/free-router)).
> Re-run the queries in the [Reproducing this snapshot](#reproducing-this-snapshot) section before
> trusting the table.

**On this file's location:** this repo had no research-notes convention — `docs/` previously held only
`docs/adr/` and the demo media (`docs/demo.mp4`, `docs/demo.gif`). I established `docs/research/` for
primary-source research notes as part of writing this file. Nothing else in the repo was modified.

**Method / trust notes.**
- No authenticated or billable API call was made. Only the public, unauthenticated models and
  endpoints endpoints were queried. The repo's `.env` was not read or used.
- Docs claims are quoted from `openrouter.ai/docs` pages (fetched as their `.md` source where
  available). Anything from a secondary source is explicitly labelled **[secondary]**.
- Where docs and API disagree, the API wins, and the disagreement is called out.

---

## 1. Every `:free` model id currently returned by the models API

Columns come straight from the API: `context_length`, `top_provider.max_completion_tokens`, and
membership tests on `supported_parameters`. "Reasoning" is derived from the `reasoning` object
(`mandatory` / `default_enabled`).

| model id | ctx | max completion tokens | `tools` | `tool_choice` | `structured_outputs` | `response_format` | reasoning | modality |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cohere/north-mini-code:free` | 256000 | 64000 | yes | yes | - | - | opt-in | text->text |
| `dots-studio/dots-3-note-preview:free` | 512000 | 512000 | yes | yes | yes | yes | opt-in | text+image->text |
| `google/gemma-4-26b-a4b-it:free` | 262144 | 32768 | yes | yes | yes | yes | opt-in | text+image+video->text |
| `google/gemma-4-31b-it:free` | 262144 | 32768 | yes | yes | - | yes | opt-in | text+image+video->text |
| `liquid/lfm-2.5-2.6b:free` | 128000 | 8192 | yes | yes | yes | yes | **forced** | text->text |
| `nvidia/nemotron-3-nano-30b-a3b:free` | 256000 | n/a | yes | yes | - | - | opt-in | text->text |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 256000 | 65536 | yes | yes | - | - | on by default | text+image+audio+video->text |
| `nvidia/nemotron-3-super-120b-a12b:free` | 262144 | 262144 | yes | yes | yes | yes | on by default | text->text |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1000000 | 65536 | yes | yes | - | - | on by default | text->text |
| `nvidia/nemotron-3.5-content-safety:free` | 128000 | 8192 | **-** | **-** | - | - | on by default | text+image->text |
| `nvidia/nemotron-3.5-lightning:free` | 1000000 | 65536 | yes | yes | - | - | opt-in | text->text |
| `nvidia/nemotron-nano-12b-v2-vl:free` | 128000 | 128000 | yes | yes | - | - | opt-in | text+image+video->text |
| `nvidia/nemotron-nano-9b-v2:free` | 128000 | n/a | yes | yes | yes | yes | opt-in | text->text |
| `openai/gpt-oss-20b:free` | 131072 | 32768 | yes | yes | yes | yes | **forced** | text->text |
| `poolside/laguna-s-2.1:free` | 262144 | 32768 | yes | yes | - | - | on by default | text->text |
| `poolside/laguna-xs-2.1:free` | 262144 | 32768 | yes | yes | - | - | on by default | text->text |
| `z-ai/glm-5.2:free` | 256000 | 256000 | yes | yes | yes | yes | on by default | text->text |

Notes on individual cells:

- `n/a` for max completion tokens means the API returned `top_provider.max_completion_tokens: null`
  (`nvidia/nemotron-3-nano-30b-a3b:free`, `nvidia/nemotron-nano-9b-v2:free`). Unbounded-per-the-API is
  **not** the same as unbounded-in-practice; treat it as unknown.
- `z-ai/glm-5.2:free` reports `context_length: 256000` at the model level, and its single free
  endpoint (Decart) agrees: 256000 context / 256000 max completion tokens.
- Reasoning column: **forced** = `reasoning.mandatory: true` (you cannot turn thinking off) —
  `liquid/lfm-2.5-2.6b:free` and `openai/gpt-oss-20b:free`. "on by default" = `default_enabled: true`.
  "opt-in" = present but not defaulted on. This matters for a tool-calling sweep because reasoning
  tokens compete with the (sometimes small) completion budget, and because reasoning-mandatory models
  are the ones most likely to narrate a tool call instead of emitting one.
- Additional relevant `supported_parameters` observed on the tool-capable set: `reasoning_effort`
  (only `glm-5.2`, `gpt-oss-20b`, `nemotron-3-super`, `nemotron-3-ultra`), `seed` (most NVIDIA
  models, Gemma 4, LFM, gpt-oss), `stop` (only `north-mini-code`, `lfm-2.5-2.6b`, `gpt-oss-20b`,
  `glm-5.2`). Notably `poolside/laguna-*:free` support only six parameters total
  (`include_reasoning, max_tokens, reasoning, temperature, tool_choice, tools`) — **no `seed`, no
  `stop`, no `response_format`**, which limits how reproducible a sweep against them can be.
- `openrouter/free` ("Free Models Router") is priced at `0/0` but its id does **not** end in `:free`,
  so it is excluded from the table. See §4 — it is a trap for a capability sweep.
- Two other zero-priced non-`:free` ids exist (`google/lyria-3-pro-preview`,
  `google/lyria-3-clip-preview`); both are audio/music models, irrelevant here.

### Provider endpoints backing each `:free` variant

Also from the API. This is the layer that actually decides whether tools work (see §4/§5).
`status` is an undocumented field; observed values were `0` for healthy endpoints and negative values
on two degraded ones.

| model id | # free endpoints | provider(s) | endpoint `tools` | `status` | uptime (last 30m) |
| --- | --- | --- | --- | --- | --- |
| `cohere/north-mini-code:free` | 1 | Cohere | yes | 0 | 98% |
| `dots-studio/dots-3-note-preview:free` | 1 | AtlasCloud | yes | 0 | 99% |
| `google/gemma-4-26b-a4b-it:free` | **2** | Google AI Studio, Darkbloom | yes / yes | 0 / 0 | `null` / 97% |
| `google/gemma-4-31b-it:free` | 1 | Google AI Studio | yes | 0 | `null` (no data) |
| `liquid/lfm-2.5-2.6b:free` | 1 | Liquid | yes | **-2** | 93% |
| `nvidia/nemotron-3-nano-30b-a3b:free` | 1 | Nvidia | yes | 0 | 99% |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 1 | Nvidia | yes | 0 | 97% |
| `nvidia/nemotron-3-super-120b-a12b:free` | 1 | Nvidia | yes | 0 | 99% |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 1 | Nvidia | yes | 0 | 99% |
| `nvidia/nemotron-3.5-content-safety:free` | 1 | Nvidia | **no** | 0 | 97% |
| `nvidia/nemotron-3.5-lightning:free` | 1 | Nvidia | yes | 0 | 99% |
| `nvidia/nemotron-nano-12b-v2-vl:free` | 1 | Nvidia | yes | **-5** | **77%** |
| `nvidia/nemotron-nano-9b-v2:free` | 1 | Nvidia | yes | 0 | 98% |
| `openai/gpt-oss-20b:free` | 1 | Darkbloom | yes | 0 | 97% |
| `poolside/laguna-s-2.1:free` | 1 | Poolside | yes | 0 | 99% |
| `poolside/laguna-xs-2.1:free` | 1 | Poolside | yes | 0 | 99% |
| `z-ai/glm-5.2:free` | 1 | Decart | yes | 0 | 99% |

**Key structural finding:** at this snapshot, 16 of the 17 `:free` variants are served by exactly
**one** provider endpoint. Only `google/gemma-4-26b-a4b-it:free` has two. So for almost every `:free`
model, model-level `supported_parameters` and endpoint-level `supported_parameters` are the same set,
and there is no cross-provider fallback to worry about *within* the `:free` variant. This is very
different from the paid variants — see §4 for the contrast, which is the single most important
routing caveat in this document.

---

## 2. The split: declares `tools` vs does not

Source: `supported_parameters` on the models API, snapshot above.

**Declares `tools` — 16 of 17.** Every `:free` model except one. All 16 also declare `tool_choice`
(the two flags are perfectly correlated across this set — no model declares one without the other).

`cohere/north-mini-code:free`, `dots-studio/dots-3-note-preview:free`,
`google/gemma-4-26b-a4b-it:free`, `google/gemma-4-31b-it:free`, `liquid/lfm-2.5-2.6b:free`,
`nvidia/nemotron-3-nano-30b-a3b:free`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`,
`nvidia/nemotron-3-super-120b-a12b:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`,
`nvidia/nemotron-3.5-lightning:free`, `nvidia/nemotron-nano-12b-v2-vl:free`,
`nvidia/nemotron-nano-9b-v2:free`, `openai/gpt-oss-20b:free`, `poolside/laguna-s-2.1:free`,
`poolside/laguna-xs-2.1:free`, `z-ai/glm-5.2:free`.

**Does not declare `tools` — 1 of 17.**

`nvidia/nemotron-3.5-content-safety:free` — a content-safety classifier, not a chat/agent model. It
declares neither `tools` nor `tool_choice`. Exclude it from the sweep, or use it as the negative
control to confirm the harness correctly detects "no tool support".

**Of the 16 tool-declaring models, 7 also declare `structured_outputs`** (`dots-3-note-preview`,
`gemma-4-26b-a4b-it`, `lfm-2.5-2.6b`, `nemotron-3-super-120b-a12b`, `nemotron-nano-9b-v2`,
`gpt-oss-20b`, `glm-5.2`), and 8 declare `response_format` (the same 7 plus `gemma-4-31b-it`). If a
model fails native tool calling, a `response_format`/`structured_outputs` fallback path is only
available for those 8.

Cross-check against the repo: `js/models.js:51` already derives its tool flag as
`params.includes('tools')`, i.e. from exactly the model-level field tabulated here — so the client's
current notion of "supports tools" inherits every caveat in §4 and §5.

---

## 3. Weakest candidates shortlist

**Caveat, stated up front and loudly: a parameter count in a model *name* is a proxy, not a
measurement.** The models API exposes no parameter count, no benchmark score, and no quality metric.
What it exposes is `hugging_face_id`, whose slugs happen to encode sizes for most of this set
(e.g. `LiquidAI/LFM2.5-2.6B`, `nvidia/NVIDIA-Nemotron-Nano-9B-v2`). The ranking below is built from:

1. **Total / active parameters inferred from the HF slug or model name.** Unverified by measurement.
2. **Mixture-of-experts active-parameter counts where the slug exposes them** (`A4B` = ~4B active,
   `A3B` = ~3B active). Active params are usually a better weakness proxy than total params — which
   means `gemma-4-26b-a4b` (4B active) may well behave *weaker* than the 9B and 12B dense Nemotrons
   despite a bigger headline number. This is the main reason the ordering below is "roughly", not
   exact.
3. **Completion budget and parameter surface from the API** (a model capped at 8192 completion tokens
   with mandatory reasoning has very little room left for a multi-round tool loop).
4. **Endpoint health from the API** (`status`, `uptime_last_30m`) — a weak model on a degraded
   endpoint is a harsher test, but also a noisier one.

Nothing here is a capability measurement. That is exactly what the live sweep is for.

**Weakest-first (tool-declaring `:free` models only):**

| # | model id | inferred size | why it's on the list | sweep hazards |
| --- | --- | --- | --- | --- |
| 1 | `liquid/lfm-2.5-2.6b:free` | ~2.6B dense (`LiquidAI/LFM2.5-2.6B`) | Smallest by an order of magnitude. The clear capability floor. | Only **8192** max completion tokens *and* `reasoning.mandatory: true` — reasoning tokens eat the budget before tool calls land. Endpoint `status: -2`, 93% uptime. |
| 2 | `nvidia/nemotron-nano-9b-v2:free` | ~9B dense | Smallest dense model after LFM. | `max_completion_tokens: null` (unknown, not unlimited). |
| 3 | `google/gemma-4-26b-a4b-it:free` | 26B total / **~4B active** | Lowest active-param count in the set apart from LFM; MoE routing often degrades tool-schema adherence more than the total suggests. | The **only** `:free` model with 2 endpoints, so it is the one place provider fallback can change behaviour mid-sweep. Google AI Studio endpoint reported `null` (no data) for 30m uptime. |
| 4 | `nvidia/nemotron-nano-12b-v2-vl:free` | ~12B dense (VL) | Small dense, and vision-tuned models often regress on tool JSON. | Worst health in the set: `status: -5`, **77%** uptime. Failures will be ambiguous between "can't tool-call" and "endpoint down". |
| 5 | `openai/gpt-oss-20b:free` | 20B total, MoE (~3.6B active per the public model card — **[secondary]**, not in the API) | Small active footprint; forced reasoning; widely used as a "does the agent loop hold" baseline. | `reasoning.mandatory: true`. Served by **Darkbloom**, not by OpenAI — a third-party host of an open-weights model. |
| 6 | `nvidia/nemotron-3-nano-30b-a3b:free` | 30B total / ~3B active | Very low active params behind a 30B label. | `max_completion_tokens: null`. |
| 7 | `nvidia/nemotron-3.5-lightning:free` | ~30B / ~3B active (HF slug: `NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16`) | Same active footprint as #6; the name hides the size entirely — only the HF slug reveals it. | 1M declared context but only 65536 completion tokens. |
| 8 | `poolside/laguna-xs-2.1:free` | unknown; **"XS"** is the only signal | Smallest in its family by naming convention. | Tiny parameter surface — no `seed`, no `stop`, no `response_format`. Least controllable sweep target. |
| 9 | `google/gemma-4-31b-it:free` | ~31B dense | Small-ish dense. | Google AI Studio endpoint reported `null` (no data) for 30m uptime at snapshot. |
| 10 | `poolside/laguna-s-2.1:free` | unknown; **"S"** | Next up from XS. | Same tiny parameter surface as #8. |
| 11 | `cohere/north-mini-code:free` | unknown; **"mini"** | "mini" is the only size signal; code-tuned, so possibly better at tool JSON than its label implies. | `is_moderated: true` — the **only** moderated `:free` model, so refusals can masquerade as tool-call failures. |

Not shortlisted (clearly not the floor): `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`
(30B/A3B but omni-modal, an odd variable to introduce), `dots-studio/dots-3-note-preview:free`
(512k context, preview), `z-ai/glm-5.2:free`, `nvidia/nemotron-3-super-120b-a12b:free`,
`nvidia/nemotron-3-ultra-550b-a55b:free` (550B/A55B — the strongest `:free` model here, useful as the
sweep's *ceiling* control).

**Recommended sweep shape:** run the full 16, but read results with the ceiling
(`nemotron-3-ultra-550b-a55b:free`) and the no-tools negative control
(`nemotron-3.5-content-safety:free`) alongside, so a harness bug is distinguishable from a model
limitation. If budget forces a subset, take #1–#6 plus the ceiling.

---

## 4. Documented free-tier limits and routing caveats that affect a live sweep

### Per-key / per-account rate limits

From [Limits](https://openrouter.ai/docs/api_reference/limits) (values are constants in the doc
source: `FREE_MODEL_RATE_LIMIT_RPM = 20`, `FREE_MODEL_NO_CREDITS_RPD = 50`,
`FREE_MODEL_HAS_CREDITS_RPD = 1000`, `FREE_MODEL_CREDITS_THRESHOLD = 10`):

> "If you're using a free model variant (with an ID ending in `:free`), the following limits apply"

| Credits purchased (all time) | Requests per minute | Requests per day |
| --- | --- | --- |
| Less than $10 | 20 | 50 |
| At least $10 | 20 | 1000 |

**The limits are global to the account, not per key.** This is the most operationally important
sentence for our Proxy architecture, which funnels all anonymous users through a single Operator Key:

> "Making additional accounts or API keys will not affect your rate limits, as we govern capacity
> globally. We do however have different rate limits for different models, so you can share the load
> that way if you do run into issues."
> — [Limits](https://openrouter.ai/docs/api_reference/limits)

Consequences for the sweep: a 16-model × N-turn tool loop can exhaust a 50/day allowance in a handful
of models, and **the sweep competes for the same global quota as live Proxy traffic**. The doc's
explicit mitigation ("share the load" across different models) is at least aligned with a sweep
design that spreads requests across all 16 ids rather than hammering one.

### Documented 429 behaviour

From [Limits](https://openrouter.ai/docs/api_reference/limits):

- Body shape: `{"error": {"code": 429, "message": "Rate limit exceeded", "metadata": {"error_type": "rate_limit_exceeded"}}}`
- A 429 has **two possible origins**, and they must be told apart: "**OpenRouter**, when you hit one
  of the platform limits above (free-model requests per minute or per day, or DDoS protection)" vs
  "**The upstream provider**, when the provider serving your request is rate limiting or at capacity.
  In this case `error.metadata.provider_code` carries the provider's original error code when
  available".
- Header discipline: "Successful inference responses do not include `X-RateLimit-*` headers. When
  OpenRouter itself returns a 429 error for a platform limit, the error response carries
  `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers describing the limit
  that was hit. When every attempted provider returned a retry hint, the error response also carries
  a `Retry-After` header."
- Guidance: "Retry with exponential backoff. Rate limits are transient; wait and retry rather than
  immediately re-sending. Honor the `Retry-After` header when present."
- **Mid-stream 429s are not HTTP 429s:** "If a rate limit is hit after streaming has started, the
  error arrives as an SSE event with `finish_reason: \"error\"` instead of an HTTP 429, since the 200
  status was already sent." A streaming sweep harness that only inspects HTTP status will silently
  record these as successful-but-empty turns.
- Quota can also fail as **402, not 429**: "If your account has a negative credit balance, you may
  see 402 errors, including for free models."
- Live quota can be checked without spending anything: `GET https://openrouter.ai/api/v1/key` returns
  `usage_daily`, `limit_remaining`, and `is_free_tier`. (Authenticated — deliberately **not** called
  for this note.)

### Are `:free` variants throttled or queued differently?

The docs are close to silent. The whole of
[Free Variant](https://openrouter.ai/docs/guides/routing/model-variants/free) on this point is:

> "Free variants provide access to models without cost, but may have different rate limits or
> availability compared to paid versions."

[Free Models Router](https://openrouter.ai/docs/guides/routing/routers/free-router) adds only soft
statements under "Limitations": "Free models may have lower rate limits than paid models",
"availability can vary; some may be temporarily unavailable", "Free models may have higher latency
during peak usage". No queueing, priority, or deprioritisation mechanism is documented anywhere I
could find. **Treat "free requests are deprioritised" as folklore unless measured.**

### Provider routing and fallback for `:free` variants

This is where the docs and the API have to be read together, because
[Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection) **never mentions the
`:free` suffix at all** — it documents `:nitro` and `:floor` but not `:free`. So the documented
routing rules are written for the general case, and we have to check the `:free` case empirically.

Documented general behaviour:

- Default is price-weighted load balancing: "Prioritize providers that have not seen significant
  outages in the last 30 seconds. For the stable providers, look at the lowest-cost candidates and
  select one weighted by inverse square of the price." Then: "Use the remaining providers as
  fallbacks." Disable with `allow_fallbacks: false`.
- Tool requests get best-effort tool-aware routing: "When you send a request with `tools` or
  `tool_choice`, OpenRouter makes a best effort to route to providers known to support tool use.
  Similarly, if you set a `max_tokens`, then OpenRouter will only route to providers that support a
  response of that length."
- **Unsupported parameters are silently ignored by default:** "With the default routing strategy,
  providers that don't support all the LLM parameters specified in your request can still receive the
  request, but will ignore unknown parameters. When you set `require_parameters` to `true`, the
  request won't even be routed to that provider." `require_parameters` defaults to **`false`**.
- Tool-aware routing is a *soft* preference with an explicit escape hatch (this is the crucial
  sentence — see §5): "Even when `require_parameters` is `false`, a small set of parameters is used as
  a soft preference when choosing between providers of the same model: `tools`, `response_format`
  (including structured outputs), and `verbosity`. If some of a model's providers support one of
  these parameters and others don't, the request is only routed to the supporting providers. **If
  none of a model's providers support the parameter, the request is still routed to that model and the
  parameter is ignored** — this preference never removes a model from your request's candidate list."

**Does OpenRouter silently route a `:free` request to a different provider with different tool
support?** From the API, at this snapshot: **no, because there is almost nowhere for it to go.** 16 of
the 17 `:free` variants expose exactly one endpoint each; only `google/gemma-4-26b-a4b-it:free` has
two (Google AI Studio and Darkbloom), and both of those declare `tools`. So no `:free` model in this
snapshot can fall back onto a non-tool-capable provider. **This is a property of today's roster, not a
guarantee** — the moment a `:free` model gains a second endpoint that lacks `tools`, the soft
preference above is the only thing standing between us and a silently tool-less request.

The paid variants show exactly how bad that can get, and the contrast is worth internalising. For
paid `openai/gpt-oss-20b` the API returns 12 endpoints, and they **disagree** about tool support:

| declares `tools` | does not declare `tools` |
| --- | --- |
| CoreWeave, DeepInfra, Parasail, Amazon Bedrock (×2), Fireworks, Groq | Novita, Phala, SiliconFlow, Together, Google |

Same model id, same weights, opposite capability. **Tool-calling support on OpenRouter is a property
of the (model, provider endpoint) pair, not of the model.** The model-level `supported_parameters`
array is a *union* across endpoints, so `"tools"` at the model level only means "at least one endpoint
supports tools". For `:free` this currently collapses to the same thing (one endpoint), which is
lucky, not designed.

### Tool-call-aware provider ordering (Auto Exacto)

[Auto Exacto](https://openrouter.ai/docs/guides/routing/auto-exacto) is on by default for tool
requests: "Auto Exacto is a routing step that automatically optimizes provider ordering for all
requests that include tools. It runs by default on every tool-calling request, requiring no
configuration." It reorders providers by throughput, tool-calling success rate, and benchmark data,
and "Providers that underperform on these signals are deprioritized."

Two things follow for a sweep. First, **Auto Exacto is a hidden, time-varying variable**: identical
requests days apart can be served by different providers, so a sweep is not reproducible unless the
endpoint is pinned. For `:free` models with a single endpoint this is currently moot, but it will not
stay moot. Second, the docs give a documented way to *pin*: benchmark runs in OpenRouter's own harness
"pin a specific provider endpoint, so every score is attributable to exactly one endpoint with no
fallback" — we should do the same via `provider.only` plus `allow_fallbacks: false`, and record which
endpoint served each result from the response's `provider` field.

Also relevant: "Tool-requiring presets are skipped on endpoints without tool support" — OpenRouter's
own harness does not even attempt tool benchmarks against non-tool endpoints, so their published
scores tell us nothing about the failure mode we care about.

---

## 5. The gap between *declaring* `tools` and *honouring* them

This is the decision-relevant section. Splitting it into what is documented and what is not.

### What IS documented

**1. OpenRouter measures, per endpoint, how often tool calls come back broken.** From
[Tool & Function Calling](https://openrouter.ai/docs/guides/features/tool-calling):

> "OpenRouter tracks how reliably each provider completes tool calls and surfaces this as the **Tool
> Call Error Rate** on the Performance tab of every model page."

[Auto Exacto](https://openrouter.ai/docs/guides/routing/auto-exacto) documents the exact methodology.
Tool-call `arguments` are validated against the caller's `tools[].function.parameters` schema using
`@cfworker/json-schema` pinned to JSON Schema Draft 7. Each tool call is bucketed as:

- **`InvalidJson`** — "`JSON.parse(arguments)` throws."
- **`UnknownName`** — "`function.name` is not present in the request's `tools[]`."
- **`SchemaMismatch`** — "The validator returns `valid: false` against the resolved schema."

Aggregation is request-level: `requests_with_tool_call_errors / requests_where_finish_reason_is_tool_calls`.

So the existence of a *declare-vs-honour* gap is officially acknowledged, quantified, published
per-endpoint, and used to demote providers. That alone should settle the question of whether
`supported_parameters: ["tools", ...]` is a guarantee. **It is not.**

**2. The metric has a blind spot that is exactly our failure mode.** Read the denominator again:
`requests_where_finish_reason_is_tool_calls`. A model that ignores the tools and answers in prose —
or worse, prints `{"name": "get_weather", ...}` into `message.content` as plain text — finishes with
`finish_reason: "stop"`, never enters the denominator, and therefore **cannot register as a tool-call
error at all**. A provider with a 0% Tool Call Error Rate may simply never be emitting tool calls.
This is an inference from the documented formula, not a documented statement, but it follows directly
from the primary source and it is the single strongest argument for running our own live sweep.

**3. Parameters can be silently dropped by design.** Quoted in §4: if no provider for a model
supports `tools`, "the request is still routed to that model and the parameter is ignored." No error,
no warning. The request looks like a normal 200 that just didn't call any tools. Mitigation:
`require_parameters: true`.

**4. Tool-call reliability differs enough between providers to justify a whole routing subsystem.**
Auto Exacto exists, uses "Tool-calling success and reliability from real traffic" as a ranking
signal, deranks endpoints at "baseline minus 2σ" on a rolling 32-day window, and includes
Tau2-Bench Airline (an agentic tool-calling benchmark) in its harness. OpenRouter would not build
this if declared tool support were reliable.

### What is NOT documented — flagging clearly rather than guessing

I read the full markdown source of
[Tool & Function Calling](https://openrouter.ai/docs/guides/features/tool-calling.md) (~27KB) and
[Auto Exacto](https://openrouter.ai/docs/guides/routing/auto-exacto.md), and grepped both for
`emulat`, `plain text`, `prompt-based`, `not support`, `caveat`, `limitation`, `may not`, `json mode`.

**The docs are silent on all of the following. I found no statement either way — I am not inferring
absence of the behaviour, only absence of documentation:**

- **No documented tool-calling emulation.** Nothing says OpenRouter injects tool schemas into the
  prompt, parses tool calls out of prose, or otherwise emulates function calling for models without
  native support. The framing is normalisation of an interface, not emulation of a capability:
  "OpenRouter standardizes the tool calling interface across models and providers." Whether any
  server-side parsing/repair happens is undocumented. **Do not assume a safety net exists.**
- **No documented acknowledgement of the plain-text-tool-call failure mode specifically.** The three
  error buckets cover malformed *tool calls*; none covers "emitted the call as content".
- **No per-model or per-provider tool-quality data in the API.** Tool Call Error Rate and the
  AutoExacto Benchmarks card are described as UI surfaces on model pages. Neither
  `/api/v1/models` nor `/api/v1/models/{id}/endpoints` returns them (the endpoint object exposes only
  `status`, `uptime_last_*`, `latency_last_30m`, `throughput_last_30m`, `quantization`,
  `supports_implicit_caching`, `supports_voice_cloning`). There is no programmatic way to pre-filter
  the sweep by tool reliability.
- **Nothing about whether `:free` endpoints are enrolled in the benchmark harness.** The Exacto docs
  do not say whether `:free` variants get benchmarked or Exacto-ordered.
- **Quantization is exposed and mostly unknown.** Among the free endpoints: `fp4`
  (`z-ai/glm-5.2:free` via Decart), `fp8` (`liquid/lfm-2.5-2.6b:free`, `poolside/laguna-*:free`),
  `bf16` (`nvidia/nemotron-nano-9b-v2:free`), and `unknown` for the rest including
  `openai/gpt-oss-20b:free`. Aggressive quantization is a plausible cause of degraded tool-JSON
  fidelity, and it is a variable we mostly cannot see on the free tier.

---

## 6. Unknowns — what only a live sweep can answer

Everything below is unanswerable from the API or the docs.

1. **Does each of the 16 tool-declaring `:free` models actually emit a well-formed `tool_calls` array?**
   The API tells us the parameter is accepted. Nothing tells us the model uses it.
2. **How often does a tool call arrive as prose in `message.content` instead?** Structurally invisible
   to OpenRouter's own Tool Call Error Rate (§5.2). This is the primary thing to instrument: log
   `finish_reason`, and scan `content` for JSON-looking tool invocations on every `stop` finish.
3. **Multi-round behaviour.** Whether a model, after being handed a `role: "tool"` result, continues
   correctly rather than re-calling the same tool, hallucinating a result, or dropping the loop. The
   `tools` flag says nothing about turn 2+. (Directly relevant to the repo's tool-round budget — see
   commit `8cf8e02`, "force a final answer when the tool-round budget is spent".)
4. **Whether `tool_choice` is honoured**, including `"required"` / a named function, versus being
   accepted and ignored. Declared by all 16; honoured by an unknown subset.
5. **Parallel / multiple tool calls in one turn** — not represented in `supported_parameters` at all.
6. **Behaviour under real completion budgets**, especially `liquid/lfm-2.5-2.6b:free` (8192 cap +
   mandatory reasoning) and the two models reporting `max_completion_tokens: null`. Does the reasoning
   trace consume the budget before any tool call is emitted?
7. **Whether declared context length is usable in practice.** `nemotron-3-ultra-550b-a55b:free` and
   `nemotron-3.5-lightning:free` declare 1M context; nothing says a free endpoint will serve a
   1M-token request.
8. **Real free-tier throughput and latency.** `latency_last_30m` and `throughput_last_30m` were
   `null` on the free endpoints I inspected, so the API gave us nothing here.
9. **Effective 429 pattern in practice** — where the 20 RPM / 50 RPD limit actually bites during a
   burst, and whether provider-side 429s (`error.metadata.provider_code`) dominate over platform 429s
   on the free tier.
10. **Whether failed requests consume the daily allowance.** A secondary source claims they do — "If
    a free model request fails from a rate limit, provider outage, or timeout, it still burns one of
    your 50 or 1,000 daily requests" **[secondary — surfaced by web search over openrouter.ai
    content; I could not locate this sentence in the `docs/api_reference/limits` source I read, so
    treat it as unverified]**. It materially changes sweep budgeting, so measure it: read
    `usage_daily` from `GET /api/v1/key` before and after a deliberately failing request.
11. **The meaning of the endpoint `status` field.** Observed `0`, `-2`, `-5`; no documentation found.
    Negative plausibly means degraded/deranked, but that is a guess.
12. **Roster churn rate.** How fast this 17-model list turns over. If it churns weekly, any pinned
    allowlist in the Proxy will rot, and the sweep needs to be re-runnable rather than one-shot.
13. **Whether `openrouter/free` is a viable sweep target.** It is priced `0/0`, declares `tools`, and
    "intelligently filters for models that support the features your request needs, such as image
    understanding, tool calling, and structured outputs" — but it "automatically selects a free model
    at random", so results are unattributable and it is useless as a capability measurement. Note
    also that its id does **not** end in `:free`, so the Proxy's `isFreeModel()` check
    (`worker/api-chat.js:43`, `id.endsWith(':free')`) would **reject** it today despite it being free.
    Worth a separate decision.

---

## Reproducing this snapshot

All unauthenticated. No billable calls.

```bash
# Full free-model capability table
curl -s https://openrouter.ai/api/v1/models \
| jq -r '[.data[] | select(.id | endswith(":free"))] | sort_by(.id) | .[]
  | [ .id,
      (.context_length|tostring),
      (.top_provider.max_completion_tokens|tostring),
      ((.supported_parameters//[]) | index("tools")       != null | tostring),
      ((.supported_parameters//[]) | index("tool_choice") != null | tostring),
      ((.supported_parameters//[]) | index("structured_outputs") != null | tostring),
      ((.supported_parameters//[]) | index("response_format")    != null | tostring),
      (.reasoning|tostring),
      (.hugging_face_id // "-")
    ] | @tsv'

# Group counts
curl -s https://openrouter.ai/api/v1/models \
| jq '[.data[] | select(.id|endswith(":free"))]
      | group_by(((.supported_parameters//[])|index("tools")) != null)
      | map({tools: (.[0].supported_parameters|index("tools")) != null, count: length})'

# Per-model endpoint / provider capability (run per model id)
curl -s "https://openrouter.ai/api/v1/models/liquid/lfm-2.5-2.6b:free/endpoints" \
| jq -r '.data.endpoints[] | [.provider_name, (.status|tostring),
    ((.supported_parameters//[])|index("tools") != null|tostring),
    (.uptime_last_30m|tostring), .quantization] | @tsv'
```

## Sources

Primary (OpenRouter):

- `GET https://openrouter.ai/api/v1/models` — model list, `supported_parameters`, `context_length`,
  `top_provider`, `reasoning`, `hugging_face_id`. Queried 2026-08-20T02:12:54Z.
- `GET https://openrouter.ai/api/v1/models/{id}/endpoints` — per-endpoint provider, `status`,
  `supported_parameters`, uptime, quantization. Same session.
- [Limits](https://openrouter.ai/docs/api_reference/limits) — free-model RPM/RPD, 429 and 402
  semantics, `X-RateLimit-*`, mid-stream errors, global-capacity statement.
- [Tool & Function Calling](https://openrouter.ai/docs/guides/features/tool-calling) — interface
  standardization, `supported_parameters=tools` filter, Tool Call Error Rate.
- [Auto Exacto](https://openrouter.ai/docs/guides/routing/auto-exacto) — tool-call success-rate
  methodology, error buckets, benchmark harness, endpoint pinning, derank threshold, opt-out.
- [Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection) — price-weighted
  default, `allow_fallbacks`, `require_parameters`, soft `tools` preference and its escape hatch.
- [Free Variant](https://openrouter.ai/docs/guides/routing/model-variants/free) — the whole `:free`
  page (three sentences).
- [Free Models Router](https://openrouter.ai/docs/guides/routing/routers/free-router) — `openrouter/free`
  selection mechanism, capability filtering, limitations, availability warning.
- [Exacto Variant](https://openrouter.ai/docs/guides/routing/model-variants/exacto) — `:exacto`
  quality-first sorting.
- [Docs index](https://openrouter.ai/docs/llms.txt) — used to enumerate candidate doc pages.

Secondary (explicitly labelled above, not relied on):

- gpt-oss-20b active-parameter count (~3.6B) — public model card, not the OpenRouter API.
- "a failed free request still burns a daily request" — web search over openrouter.ai content; not
  located in the `docs/api_reference/limits` source. Unverified.
