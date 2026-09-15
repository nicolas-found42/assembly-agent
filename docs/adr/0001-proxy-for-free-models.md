# Proxy Operator Key for Free Models

Static GH Pages site required a BYO OpenRouter key for all models; we add a Cloudflare Worker sidecar that holds the single Operator Key server-side and proxies `POST /api/chat` only for Free Models (`id.endsWith(':free')`), keeping `GET /api/v1/models` direct and leaving GH Pages deploy unchanged.

## Considered Options

- Embed shared key in client (rejected: leaks in DevTools, quota theft)
- Migrate all to Cloudflare Pages Functions (rejected: larger migration)
- Per-IP Rate Limit now (deferred: keep Proxy stateless, rely on OpenRouter per-key 429 with BYO escape hatch, add limit only if abuse observed)

## Consequences

- Two deploy targets: GH Pages (frontend+WAT) + Worker (`wrangler.toml`, secret `OPENROUTER_KEY`)
- Worker must stream SSE verbatim (60 KiB chunks into `E.sse_feed`) and forward `HTTP-Referer`/`X-Title: ASM::AGENT`; CORS allow Pages origin only
- BYO User path stays direct to `openrouter.ai`; Anonymous User path filtered to `:free` models only, paid rejected 403 at both client and Proxy; optional key in SET with 429 helper "add your own key to bypass"

_Update (2026-09-15): the `:free` suffix alone did not describe what the Operator Key could be billed for, so the free-only boundary now covers request routing and the forwarded body (regression tests in `test/worker/chat.test.mjs`):_

- _`route` is refused outright — it selects a model by mechanism, so the suffix check cannot cover it;_
- _a `models` fallback list is forwarded only when every entry is `:free` (OpenRouter tries them in order and bills the model that finally answers), and a malformed or non-array list is refused;_
- _the upstream body is built from a reviewed allowlist — `model`, `messages`, `stream`, `tools` and the all-free `models` — instead of forwarding the client's body verbatim. OpenRouter bills request-shaping fields (the `web` plugin is $4 per 1,000 results), so a field this repository has not reviewed must not ride along on the Operator Key._
- _an upstream fetch that fails before any response headers is answered with one stable message — the provider's exception text no longer appears in the 502 body (it stays in the Worker's `upstream_fetch_error` log line, truncated), so a transport error cannot echo upstream internals to the client._
