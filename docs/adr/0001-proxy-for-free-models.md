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
