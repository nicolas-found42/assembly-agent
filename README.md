# ASM::AGENT — amber CRT chat agent

## What it is

ASM::AGENT is a single-page chat that talks to OpenRouter models through a WAT
engine. Every accepted request gets a fresh web search before the model writes an
answer.

- **One built-in assistant** — ASM::AGENT speaks with a calm, precise computer
  voice. A library holds custom assistants that you can create, edit, duplicate,
  delete, import, and export.
- **Research first** — every request runs a fresh web search before any model
  call, for every assistant. A keyless fan-out of 28 sources feeds the answer.
  Search states are honest: the answer footer says when sources were unreachable
  or when the search was not available.
- **Wording check** — answers from the built-in assistant pass mechanical
  ASD-STE100-style checks. A violation can trigger one corrective rewrite. The
  rewrite must keep every link, code block, number, and quotation. A failed
  rewrite is dropped and the original answer stays.
- **WAT engine** — `src/agent.wat` → `dist/agent.wasm` (zero imports,
  linear-memory I/O) owns streaming, history, and catalog sort/filter. The engine
  is unchanged. Its internals are no longer part of the product surface.
- **Keys are optional for free models** — without a key, free models run through
  the free proxy. Paid models need your OpenRouter key. A new key lasts for the
  browser session by default.

## Quick start

```bash
npm ci                # install the lockfile-pinned dependencies
npm run build         # compile src/agent.wat, stage the immutable _site/ artifact
npm run serve         # serve _site/ at /assembly-agent/; prints the URL to open
```

`npm run serve` prints one `READY http://127.0.0.1:<port>/assembly-agent/` line —
open that URL. It never reuses a port another process holds.

1. The first chat starts with the built-in assistant and the automatic model
   ("Automatic — newest free"). Free models run without a key through the proxy.
2. To use paid models, open **Settings**, paste an OpenRouter key (`sk-or-...`),
   and save it. After that, choose the model from the **Model** dialog.
3. Type a question and press **ENTER**. The assistant searches the web first,
   then writes the answer and shows the sources below it.

The site is static. `_site/` is the only deployment artifact, and
`dist/agent.wasm` (the compiled engine) is the only file the build compiles.
Version pins live in `scripts/toolchain.mjs`; `scripts/install-toolchain.sh`
installs the pinned WABT release with a verified checksum, and a system WABT
(`brew install wabt`) works too.

## Features

- **Chats** — one transcript, a **New chat** button, and a Chats dialog to open,
  rename, export (`.md` or `.json`), and delete chats. Each chat keeps its own
  model choice and a copy of the assistant instructions it started with. A new
  chat always starts with the built-in assistant; choosing a different assistant
  starts a new chat.
- **Assistant library** — create, edit, duplicate, and delete custom assistants.
  The built-in record is protected. Import and export use
  `{format:'asm-agent.assistants',version:1}`. Import never overwrites the
  built-in assistant or an existing name: a clash becomes a copy, and the file
  size is capped at 256 KB. Custom instructions cannot turn the web search off.
- **Fresh research per request** — a deterministic planner (`js/research.js`)
  builds each search query from local code only, before any bytes leave the
  browser. A greeting gets a harmless generic query. "Continue" or "make it
  shorter" derives its topic from earlier user messages. Private writing and
  translation material never reaches a search. Credentials, email addresses, and
  long quoted spans are stripped at every search boundary. The first lookup runs
  before the first model call and bypasses the session caches.
- **Search budget** — at most 5 research rounds per request, including the first
  mandatory one. When the budget is spent, one final tools-disabled pass forces
  an answer from the results already in the conversation.
- **Honest search states** — a failed source does not block the answer. The
  footer shows "Some sources were unreachable." or "Web search was not available
  for this answer." when those states occur.
- **Stop and retry** — Stop cancels the research and the generation. Retry runs
  the research again and does not duplicate your message.
- **Wording check** — after a built-in answer settles, `js/ste.js` checks the
  prose. The implemented checks are: sentence length over 20 words (rule 5.1),
  a paragraph over six sentences (rule 6.6), a passive-voice heuristic (rule
  3.6), a progressive `-ing` heuristic (rules 3.5 and 3.2), a double negative
  (no Issue 9 rule number; mapped from Global English rule 3.12 by TechScribe),
  and more than one command per sentence (rule 5.2). The check is a partial
  approximation. The licensed ASD-STE100 Issue 9 approved-word dictionary is not
  bundled, so dictionary and word-form checks are not implemented. No certified
  STE compliance is claimed.
- **Model catalog** — the full OpenRouter catalog is always listed, newest
  first. Paid models stay visible without a key but locked ("Your API key
  required"). The automatic mode ("Automatic — newest free") resolves the newest
  free text model once, when the chat is created, and pins it. A catalog refresh
  never changes an existing chat. A manual choice persists per chat. There is no
  automatic fallback on error: use Retry or change the model. The catalog never
  selects a paid model when the free pool is empty.
- **Keys** — a new key is session-only (`sessionStorage asm.openrouter.key`).
  "Remember on this device" persists it to `asm.settings.key`. "Remove key"
  clears both copies and stops further paid rounds in the running turn. A search
  query never carries a key.
- **Storage** — chats, assistants, and settings stay in the browser
  (`asm.chats.v2`, `asm.assistants.v2`, `asm.settings`). A one-time migration
  converts older data, writes a backup, and never deletes the legacy keys.
- **CRT** — amber phosphor theme with scanline, curvature, flicker, and sound
  toggles in Settings.

## Project structure

```
index.html          # chat shell: header, transcript, composer, status line
styles.css          # amber phosphor theme, scanlines/vignette/flicker
js/
  main.js           # boot, turn loop, dialogs, transcript rendering
  bridge.js         # WASM instantiate + turn pipeline (research, rounds, wording pass)
  research.js       # deterministic query planning + privacy minimization
  search.js         # parallel keyless source fan-out
  models.js         # catalog fetch + TLV + sort/filter + newest-free query
  store.js          # v2 persistence: assistants, chats, settings, keys, migration
  persona.js        # built-in assistant instructions + policy preamble
  ste.js            # ASD-STE100-style prose checks + rewrite integrity gate
  guard.js          # hedge pass, budget nudge, tool-argument repair
  markdown.js       # marked + DOMPurify + highlight.js
  a11y.js           # status announcements
src/agent.wat       # hand-written engine (SSE scanner, history arena, catalog)
dist/agent.wasm     # build output (wat2wasm)
worker/api-chat.js  # free-model proxy (Cloudflare Worker)
wrangler.toml       # proxy deploy config
scripts/            # build, serve, gate, runner, toolchain, lint, audit, deploy helpers
test/               # suites; membership is declared in test/manifest.json
.github/workflows/  # required gate, scheduled checks, publishers
```

## Develop and test

`npm run verify` is the one required command. It stages the site, runs every
required test class, re-checks the staged artifact, then lints and audits. The
step list lives in `scripts/verify.mjs` — `--list` prints it, and `--only <step>`
runs one step to reproduce a CI failure locally.

| Command | What it does |
| --- | --- |
| `npm run build` | stages the allowlisted production tree into `_site/` and writes `artifacts/site-inventory.json`; the allowlist, budgets and post-stage validation are in `scripts/build-site.sh` |
| `npm run serve` | serves `_site/` at `/assembly-agent/`; prints `READY <url>`, refuses a taken port |
| `npm run verify` | the required gate: build → required classes → artifact identity → lint → audit |
| `npm run test:offline` | required class: the `node --test` files and engine scripts |
| `npm run test:worker` | required class: the Worker suite in real workerd |
| `npm run test:browser` | required class: the Playwright suite over `_site/`, chromium |
| `npm run test:cross-browser` | scheduled class: the same browser suite on firefox + webkit |
| `npm run test:live` | operational probes; never part of the required gate |
| `npm run lint` | pinned actionlint + zizmor, workflow invariants, js/shell/html checks |
| `npm run audit` | vulnerability policy (`scripts/audit-policy.mjs`; exceptions and their owners in `scripts/audit-policy.exceptions.json`) |
| `npm run check:deps` | lockfile ↔ `node_modules` ↔ vendored bytes ↔ staged site agreement |
| `npm run toolchain` | the declared pins against the versions actually resolved |

Test membership is declared once, in `test/manifest.json`: the workflow YAML lists
no test files, and `scripts/validate-manifest.mjs` fails when a runnable file under
`test/` is unlisted. Each entry names a class (`offline`, `worker`, `browser`,
`scheduled-browser`, `live`) and an adapter, and the runner refuses `.only`,
`.skip`, `.todo` and retry-only passes in the required classes. Every class writes
`artifacts/results/<class>.json`; `npm run ci:summary` turns those (plus the
Playwright JSON report) into the CI job summary.

The browser suite runs against the staged `_site/` and fails before the first test
when the artifact is missing or stale. The Worker and every external origin are
served by `test/browser/fixture-server.mjs`, so it needs no key and no network; its
two local servers use ports 4319/4320 (`SITE_PORT`/`FIXTURE_PORT` override them).
The old manual `test/a11y.browser.mjs` harness is superseded — it sits in the
`live` class and never enters the required gate.

### Reproducing a CI failure

An engine stream failure prints its own replay line; this is that command:

```bash
STREAMS_SEED=20260914 STREAMS_CHILD=property STREAMS_REPLAY=tool-parallel:rand-3 \
  node test/streams.test.mjs
```

A failed browser run leaves the Playwright JSON report at
`artifacts/results/browser-playwright.json`
(`scheduled-browser-playwright.json` for the cross-browser class) and traces and
screenshots under `test-results/browser/` (`trace: retain-on-failure`,
`screenshot: only-on-failure`); in CI download the `browser-diagnostics` (or
`cross-browser-failure-artifacts`) artifact. Open a trace with:

```bash
npx playwright show-trace test-results/browser/<failed-test>/trace.zip
```

Visual baselines live next to the spec in
`test/browser/__snapshots__/visual.spec.mjs/`, per project and platform. CI never
writes them; review every changed PNG, then update them deliberately:

```bash
npm run test:update-snapshots   # npx playwright test --config test/browser/playwright.config.mjs --update-snapshots
```

The Worker runs locally under the same runtime it deploys to. The runtime tests use
a mock upstream and no key; the packaging dry run needs no Cloudflare credentials:

```bash
npm run test:worker        # vitest + @cloudflare/vitest-pool-workers, real workerd
npm run worker:package     # wrangler deploy --dry-run; records the bundle identity
npx wrangler dev           # optional local server (the operator key is needed to serve model requests)
```

## Operations

**Required check.** `main` requires exactly one status context: `build-and-test`,
the job id in `.github/workflows/ci.yml` — deliberately no `name:` override, so the
context cannot drift; `npm run lint` fails if it does. That job runs `npm run
verify` and then the artifact-identity re-check. CodeQL also runs on pull requests,
but it is not a required context. The `deploy` job publishes only a verified push to
`main`; `post-deploy-smoke` then verifies what was published.

**Optional scheduled checks.** `.github/workflows/cross-browser.yml` (firefox +
webkit) runs daily at 07:23 UTC and `.github/workflows/live-health.yml` at 06:17
UTC; CodeQL scans weekly. All three are signals, never PR gates, and all three can
also be dispatched by hand. `npm run live:health` runs the same read-only checks
locally (`--expect-commit <sha>` separates a stale artifact from a broken new one).

**Secrets and variables.**

| Name | Kind | Where it lives |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | environment secrets | `cloudflare-worker` (protected environment) |
| `ENABLE_WORKER_DEPLOY` | repository variable | `true` opts the manual Worker deployment in; unset means the workflow is a no-op |
| `LIVE_HEALTH_ENABLE_GENERATION` | repository variable | opts the budgeted live generation probe in |
| `LIVE_HEALTH_MAX_{REQUESTS,TOKENS,DURATION_MS,CONCURRENCY}` | repository variables | lower the probe budget; the hard ceilings are in `scripts/live-health.mjs` |
| `OPENROUTER_KEY` | Worker secret | Cloudflare: `npx wrangler secret put OPENROUTER_KEY`; `wrangler.toml` declares it required |

The required gate and the Pages publisher need no repository secret: they use the
per-run `GITHUB_TOKEN` (read-only outside the deploy job) and an OIDC token for
Pages. Environments: `github-pages` is live and allows only `main`;
`cloudflare-worker` is still pending (see activation below).

**Artifact identity and promotion.** `_site/` is staged once, by `npm run build`,
and is immutable: nothing adds files to it afterwards, and no deployment job builds
or injects metadata. `artifacts/site-inventory.json` records a sha256 per staged
file plus one `treeDigest` over the sorted list; `_site/build-info.json` records the
commit, the WASM and lockfile digests and the dependency versions. The promotion
guard is `node scripts/site-inventory.mjs --verify _site`, re-run after the tests —
a byte changed after testing fails the run before anything can be published.

**Retention.** 14 days: `verification-reports`, `cross-browser-reports`. 7 days:
`browser-diagnostics`, `deployed-site-smoke`. 30 days: `live-health-report`,
`live-health-incident`. 90 days: `worker-deploy-record`. CodeQL uploads SARIF to
code scanning instead of an artifact.

**Incidents.** `npm run incident:report` (`scripts/incident.mjs`) keeps at most one
open issue per (service, failure class), updates it while the failure persists, and
comments on and closes it on recovery. It is a no-op with a printed explanation
unless reporting is enabled and the token has push permission. Only the live-health
`report-incident` job has `issues: write`, and only sanitised data is stored.

**Deployment order.** Pages and the Worker are independent publishers: pushing
`main` never releases the Worker, and the Worker workflow never touches Pages. When
a change needs both, publish Pages first — the Worker is additive, while the
frontend depends on the Worker's current error shapes.

**Rollback.** Pages: revert the bad commit on `main`; the normal pipeline rebuilds,
re-verifies and publishes it, and a run whose commit is no longer the tip of `main`
publishes nothing (the freshness gate). In an emergency an administrator can
re-deploy a previously verified artifact through the Pages API and record it in the
deployment history. Worker: `npx wrangler versions deploy <previous-version-id>@100
--yes`, with each run's version id recorded in `artifacts/results/worker-deploy.json`.
Neither path rolls back automatically.

**Owner-only activation still pending.** These are repository and Cloudflare
settings, not code; until they exist the related workflow stays a no-op:

- the `cloudflare-worker` environment, with required reviewers;
- environment secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts: edit) and
  `CLOUDFLARE_ACCOUNT_ID` on that environment;
- repository variable `ENABLE_WORKER_DEPLOY=true`;
- Worker secret `OPENROUTER_KEY` on the deployed Worker;
- optional: `LIVE_HEALTH_ENABLE_GENERATION` and its budget variables, and custom
  Worker routes.

`bash scripts/settings-apply.sh` reports (and with `--apply`, sets) the
administrator settings this contract depends on — Action SHA pinning, the default
`GITHUB_TOKEN` scope, Dependabot security updates, CodeQL default setup staying off,
and the required-check context. A denied read is reported as "not verified", never
as "absent".

## Notes

- **Deploy** — GitHub Pages publishes the verified `_site/` artifact from the
  `deploy` job in `.github/workflows/ci.yml`, for main pushes only. There is no
  server-side application; the site is static.
- **Free proxy** — the Cloudflare Worker in `worker/api-chat.js` forwards
  `:free` model requests to OpenRouter with the Operator Key. It refuses every
  other model (`403 NOT_FREE`), and it refuses a request whose routing fields it
  cannot prove are free-only: `route` is rejected outright, and a `models`
  fallback list is accepted only when every entry is `:free`. The upstream body is
  built from a reviewed allowlist (`model`, `messages`, `stream`, `tools`, and the
  all-free `models`) rather than forwarded verbatim, so a request-shaping field
  this repository has not reviewed — OpenRouter bills some of them, such as the
  `web` plugin — cannot spend the Operator Key. The key is set with
  `wrangler secret put OPENROUTER_KEY`. The Worker allows the GitHub Pages
  origin, `*.pages.dev`, and localhost. See
  `docs/adr/0001-proxy-for-free-models.md`.
- **Paid models** — your own OpenRouter key, read before every request round. A
  key that is changed or removed stops the turn with an honest message.
- **Docs** — product and release decisions live in `docs/adr/` (ADR 0013 and
  ADR 0014 define the verification and deployment contract). The glossary is
  `CONTEXT.md`.
