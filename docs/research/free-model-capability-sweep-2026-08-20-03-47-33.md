# Free Model Capability Sweep — 2026-08-20-03-47-33

Run: `.scratch/sweep/smoke2` · Search Budget: 5 · Preset: `BASIC AGENT` · path: Proxy on the Operator Key

Canned search results, so the model is the only variable. A 429 marks a case **not tested**, never failed.

| Free Model | declares tools | Tier | L0 | L1 | L2 | L3 | L4 | T1 | T2 no-search | non-empty | not fallback | cites result | no loop | worst HTTP | not tested |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `nvidia/nemotron-3.5-content-safety:free` | no | ? | NO | NO | n/a | n/a | n/a | 0/3 | yes | n/a | n/a | n/a | n/a | 404 | — |
| `z-ai/glm-5.2:free` | yes | ? | n/a | n/a | n/a | n/a | n/a | 0/0 | n/a | n/a | n/a | n/a | n/a | 429 | T1.0 T1.1 T1.2 T2.0 T3.0 T4.0 |
| `liquid/lfm-2.5-2.6b:free` | yes | L2 | NO | yes | yes | NO | n/a | 0/3 | NO | yes | yes | n/a | yes | 400 | — |
| `cohere/north-mini-code:free` | yes | L3 | yes | yes | yes | yes | n/a | 3/3 | yes | yes | yes | NO | yes | 200 | — |
| `google/gemma-4-26b-a4b-it:free` | yes | L3 | yes | yes | yes | yes | n/a | 3/3 | yes | yes | yes | NO | yes | 200 | — |
| `google/gemma-4-31b-it:free` | yes | L3 | yes | yes | yes | yes | n/a | 3/3 | yes | yes | yes | yes | yes | 200 | — |
| `nvidia/nemotron-3-nano-30b-a3b:free` | yes | L3 | yes | yes | yes | yes | n/a | 3/3 | yes | yes | yes | NO | yes | 200 | — |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | yes | L3 | yes | yes | yes | yes | n/a | 3/3 | yes | yes | yes | NO | yes | 200 | T3.0 |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | yes | L3 | yes | yes | yes | yes | n/a | 3/3 | yes | yes | yes | NO | yes | 200 | T4.0 |
| `nvidia/nemotron-nano-12b-v2-vl:free` | yes | L3 | yes | yes | yes | yes | n/a | 1/1 | yes | yes | yes | yes | yes | 400 | T1.0 T1.2 |
| `nvidia/nemotron-nano-9b-v2:free` | yes | L3 | yes | yes | yes | yes | n/a | 3/3 | yes | yes | yes | yes | yes | 200 | — |
| `poolside/laguna-s-2.1:free` | yes | L3 | yes | yes | yes | yes | n/a | 2/2 | n/a | yes | yes | yes | yes | 429 | T1.0 T2.0 T3.0 T4.0 |
| `poolside/laguna-xs-2.1:free` | yes | L3 | yes | yes | yes | yes | n/a | 3/3 | yes | yes | yes | NO | yes | 429 | T3.0 |
| `dots-studio/dots-3-note-preview:free` | yes | L4 | yes | yes | yes | yes | yes | 3/3 | yes | yes | yes | yes | yes | 400 | — |
| `nvidia/nemotron-3.5-lightning:free` | yes | L4 | yes | yes | yes | yes | yes | 3/3 | yes | yes | yes | NO | yes | 200 | — |
| `nvidia/nemotron-3-super-120b-a12b:free` | yes | L4 | yes | yes | yes | yes | yes | 3/3 | yes | yes | yes | NO | yes | 200 | — |
| `openai/gpt-oss-20b:free` | yes | L4 | yes | yes | n/a | n/a | yes | 0/0 | n/a | yes | yes | n/a | yes | 429 | T1.0 T1.1 T1.2 T2.0 T3.0 |

## Failures

### `nvidia/nemotron-3.5-content-safety:free`

- **T1.0** — statuses `404`, 0 tool call(s), finish `none`, 0 chars out, error: No endpoints found that support tool use. Try disabling "web_search". To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection
  - raw: `.scratch/sweep/smoke2/raw/nvidia_nemotron_3_5_content_safety_free/T1.0.sse`
- **T1.1** — statuses `404`, 0 tool call(s), finish `none`, 0 chars out, error: No endpoints found that support tool use. Try disabling "web_search". To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection
  - raw: `.scratch/sweep/smoke2/raw/nvidia_nemotron_3_5_content_safety_free/T1.1.sse`
- **T1.2** — statuses `404`, 0 tool call(s), finish `none`, 0 chars out, error: No endpoints found that support tool use. Try disabling "web_search". To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection
  - raw: `.scratch/sweep/smoke2/raw/nvidia_nemotron_3_5_content_safety_free/T1.2.sse`
- **T2.0** — statuses `404`, 0 tool call(s), finish `none`, 0 chars out, error: No endpoints found that support tool use. Try disabling "web_search". To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection
  - raw: `.scratch/sweep/smoke2/raw/nvidia_nemotron_3_5_content_safety_free/T2.0.sse`
- **T3.0** — statuses `404`, 0 tool call(s), finish `none`, 0 chars out, error: No endpoints found that support tool use. Try disabling "web_search". To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection
  - raw: `.scratch/sweep/smoke2/raw/nvidia_nemotron_3_5_content_safety_free/T3.0.sse`
- **T4.0** — statuses `404`, 0 tool call(s), finish `none`, 0 chars out, error: No endpoints found that support tool use. Try disabling "web_search". To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection
  - raw: `.scratch/sweep/smoke2/raw/nvidia_nemotron_3_5_content_safety_free/T4.0.sse`

### `liquid/lfm-2.5-2.6b:free`

- **T1.0** — statuses `200,200,400`, 2 tool call(s), finish `tool_calls,tool_calls,tool_calls,tool_calls`, 0 chars out, error: Provider returned error
  - raw: `.scratch/sweep/smoke2/raw/liquid_lfm_2_5_2_6b_free/T1.0.sse`
- **T1.1** — statuses `200,200,400`, 2 tool call(s), finish `tool_calls,tool_calls,tool_calls,tool_calls`, 0 chars out, error: Provider returned error
  - raw: `.scratch/sweep/smoke2/raw/liquid_lfm_2_5_2_6b_free/T1.1.sse`
- **T1.2** — statuses `200,400`, 1 tool call(s), finish `tool_calls,tool_calls`, 0 chars out, error: Provider returned error
  - raw: `.scratch/sweep/smoke2/raw/liquid_lfm_2_5_2_6b_free/T1.2.sse`
- **T3.0** — statuses `200,400`, 1 tool call(s), finish `tool_calls,tool_calls`, 0 chars out, error: Provider returned error
  - raw: `.scratch/sweep/smoke2/raw/liquid_lfm_2_5_2_6b_free/T3.0.sse`
- **T4.0** — statuses `200,200,400`, 2 tool call(s), finish `tool_calls,tool_calls,tool_calls,tool_calls`, 0 chars out, error: Provider returned error
  - raw: `.scratch/sweep/smoke2/raw/liquid_lfm_2_5_2_6b_free/T4.0.sse`

### `nvidia/nemotron-3-nano-30b-a3b:free`

- **T4.0** — statuses `200,200,200,200`, 3 tool call(s), finish `tool_calls,tool_calls,tool_calls,tool_calls,tool_calls,tool_calls,tool_calls,tool_calls`, 0 chars out, error: STREAM ERROR
  - raw: `.scratch/sweep/smoke2/raw/nvidia_nemotron_3_nano_30b_a3b_free/T4.0.sse`

### `nvidia/nemotron-nano-12b-v2-vl:free`

- **T3.0** — statuses `200,400`, 1 tool call(s), finish `tool_calls,tool_calls`, 0 chars out, error: Provider returned error
  - raw: `.scratch/sweep/smoke2/raw/nvidia_nemotron_nano_12b_v2_vl_free/T3.0.sse`

### `dots-studio/dots-3-note-preview:free`

- **T3.0** — statuses `200,400`, 1 tool call(s), finish `tool_calls,tool_calls`, 4 chars out, error: Provider returned error
  - raw: `.scratch/sweep/smoke2/raw/dots_studio_dots_3_note_preview_free/T3.0.sse`

