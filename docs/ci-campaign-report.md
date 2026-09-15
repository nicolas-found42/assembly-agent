# CI campaign completion report

Date: 2026-09-15
Branch: `ci/campaign` **merged** into `main` as `4e6b272bed071b5b345049e0823a18ea9946587a`
(merge commit; the branch's 13 commits are preserved in `main`'s history)
Base: `main` @ `332ed511e3fbecce22d89032cc4b9ec9fc499339` before the merge
PR: [#47](https://github.com/nicolas-found42/assembly-agent/pull/47) — merged 2026-09-15T15:35:42Z

This report answers §16 of the implementation brief. Status words mean exactly
this: **implemented + verified** (the code exists and both local verification and
a GitHub-hosted run exercised it); **implemented, externally unverified** (code
and local evidence exist, the platform-dependent leg has not run);
**blocked** (exact prerequisite stated). Nothing here claims a hosted run,
publication, deployment or setting that was not observed.

## 1. Identity and change summary

Thirteen commits on top of `332ed51` — the seven the campaign was built with,
then six that close the review findings. They were merged into `main` as the
merge commit `4e6b272` (2026-09-15T15:35:42Z), so every SHA below is reachable
from `main`'s history.

| Commit | Subject |
| --- | --- |
| `c292d78` | add package.json, lockfile, and build-output ignores (campaign foundation) |
| `9b2ef79` | make the required gate a real boundary, not a checklist |
| `b8bc581` | fix what the first hosted run found |
| `46974a3` | every dialog shot goes through the same resting state |
| `308b9ff` | the last two linux dialog baselines are now runner-rendered |
| `ab3e555` | close the two CodeQL findings in the campaign's own code |
| `9313d41` | a timeout that sweeps its children, and a budget that counts the request it sent |
| `681f1b0` | prove the gate's own guards with committed tests |
| `c63f5b2` | worker: one stable message for an upstream fetch failure |
| `3c1b5cf` | map the documented live-health budget variables into the workflow |
| `2ce1e90` | analyse the repository's own shell scripts with shellcheck |
| `7841592` | report the campaign's verified state, and make the activation surface honest |
| `950422c` | keep the sentinel out of the source, so retained copies cannot trip the scan |

Diff against `main`: 120 files, 102 added, 17 modified, 1 deleted
(`.github/workflows/deploy.yml`), +19,883/−83 lines. Grouped:

- **Required gate and test classification** — `scripts/verify.mjs` (the one gate
  command, 11 named steps), `scripts/run-tests.mjs`, `scripts/validate-manifest.mjs`,
  `test/manifest.json` (single membership declaration; `deploy.yml` deleted).
- **Browser suite** — `test/browser/**`: `playwright.config.mjs` (staged `_site/`
  preflight, one worker, retries 0, `forbidOnly`), `lib/**` harness, 8 spec files
  (`boot`, `a11y`, `harness`, `leak`, `journey-turn/search/library`,
  `journey-security`, `visual`), `fixture-server.mjs`, `fixtures/**`,
  `a11y-baseline.json`, 22 visual baselines under `__snapshots__/visual.spec.mjs/`.
- **Worker** — `test/worker/**` (vitest + `@cloudflare/vitest-pool-workers`, mock
  upstream), `worker/api-chat.js` (free-only routing fix), `wrangler.toml`.
- **Product fixes** — `js/markdown.js`, `js/search.js`, `index.html`, `styles.css`;
  docs: `README.md`, `CONTEXT.md`, ADR 0013 (test tiers) and 0014 (artifact
  promotion) new, 0001/0008/0010/0012 amended.
- **Artifact assembly and promotion** — `scripts/build-site.sh` (allowlist staging,
  `wasm-validate` + ABI check, notices, budgets, validation, inventory),
  `site-inventory.mjs`, `build-info.mjs`, `serve-site.mjs`, `worker-package.mjs`.
- **Workflows** — `ci.yml` (build-and-test → deploy → post-deploy-smoke),
  `cross-browser.yml`, `live-health.yml`, `worker-deploy.yml`, `codeql.yml`,
  `.github/dependabot.yml`.
- **Evidence, lint and security tooling** — `lint.sh`, `workflow-invariants.mjs`,
  `check-deps.mjs`, `audit-policy.mjs` + `audit-policy.exceptions.json`,
  `check-sentinel.mjs`, `ci-summary.mjs`, `incident.mjs`, `live-health.mjs`,
  `toolchain.mjs`, `install-toolchain.sh`, `install-lint-tools.sh`,
  `settings-apply.sh`, `worker-deploy.sh`.

## 2. R01–R09 status (brief numbering)

The brief's numbering is used here. PR #47's own body table used *different*
R-labels: its R07 is engine verification, its R05/R06 are merged into one row, and
the brief's R07 (evidence/diagnostics/sentinel) has no row there at all — treat
that table's counts as superseded (it also says "176 firefox+webkit; 66
baselines"; the committed numbers are 160 and 22).

| Req | Requirement | Implementation | Acceptance evidence | Status |
| --- | --- | --- | --- | --- |
| R01 | Central, complete required coverage; enforceable classification | `scripts/verify.mjs`, `run-tests.mjs`, `validate-manifest.mjs`, `test/manifest.json` | hosted CI `34970772333` step 9 ran all classes; `test/ci-guards.test.mjs` (11 tests, green) rejects unclassified/duplicate/missing paths, zero-test and retry-only suites | implemented + verified |
| R02 | Deterministic browser + a11y verification of the staged artifact | `test/browser/**`, `fixture-server.mjs`, `scripts/serve-site.mjs` | hosted `34989501324`: 88 chromium tests green inside the gate; firefox+webkit leg **160 tests green on a hosted runner** in the first `Cross-browser` run `34990031960` (8m01s); `artifacts/results/browser-playwright.json` `expected 88, flaky 0` | implemented + verified |
| R03 | Lockfile-pinned, vendored runtime deps; advisories; Dependabot | `package.json`/`package-lock.json`, `build-site.sh` VENDOR_MAP, `check-deps.mjs`, `audit-policy.mjs` + dated exception, `.github/dependabot.yml` | verify steps 8 and 10 (hosted, inside step 9); `npm ci` used by CI; exceptions file is the only accepted finding; after the merge Dependabot's grouped `deps-dev` PRs arrived and the gate sorted them: `#48` (yaml 2.8.3 → 2.9.1) green (`34989620823`) and landed with this change set; `#49` (vitest 4 → 5, a major) fails `npm ci` (`34989651920`) and is deferred (§6) | implemented + verified (Dependabot alerts + security updates also enabled, §7) |
| R04 | Immutable `_site/` artifact, identity, promotion guard | `build-site.sh`, `site-inventory.mjs`, `build-info.mjs` | `_site` = 23 files, 537,841 B; hosted step 10 re-verified the digest inside the gate and again as the promotion guard; the merge published that same payload (deployment `6462600548`), and the live `build-info.json` reports commit `4e6b272` with a matching wasm digest | implemented + verified |
| R05 | Consolidated workflows, honest required gate, deploy privileges, freshness | `.github/workflows/ci.yml` (replaces `deploy.yml`), `workflow-invariants.mjs` | hosted `34989501324` (push to `main`): `build-and-test` 3m20s → `deploy` 11s → `Deployed-site smoke` 12s, all success; the freshness gate read the tip of `main` before publishing; red PR runs show the gate failing honestly | implemented + verified |
| R06 | Explicit toolchains, pinned SHAs, minimal permissions | `toolchain.mjs` pins, `install-toolchain.sh` (SHA-verified WABT), `install-lint-tools.sh`, workflow `uses:` at full SHAs | hosted: Node `24.21.0` installed from the pin, WABT `1.0.41` digest-verified, `npm run toolchain` step green; `workflow-invariants` `uses-pinned`, `permissions-declared`, `privileged-scope` | implemented + verified |
| R07 | Named steps, machine-readable results, summaries, diagnostics, sentinel | `ci-summary.mjs`, `check-sentinel.mjs`, class JSON reports, artifact uploads | hosted steps 12–14 (job summary + `verification-reports` + `browser-diagnostics`) succeeded; sentinel is verify's last step; `test/ci-failures.test.mjs` drives the real scan | implemented + verified |
| R08 | actionlint/zizmor/shellcheck, CodeQL, secrets, WASM/ABI, bounded streams | `lint.sh` (8 sections), `workflow-invariants.mjs` (13 checks), `.github/workflows/codeql.yml`, `abi-check.mjs`, `wasm-validate` in the build, `test/streams.test.mjs` | CodeQL `34970772349` green (both languages); `WORKFLOW INVARIANTS PASS (13/13)`; `ABI OK (26 exports, 0 imports, 23 used by js/, memory 16+ pages)`; stream suite 41 tests in the offline class | implemented + verified |
| R09 | Worker runtime, controlled deployment, live health, incidents | `test/worker/**`, `scripts/worker-deploy.sh`, `worker-deploy.yml`, `live-health.mjs` + `live-health.yml`, `incident.mjs` | hosted `34989501324`: worker class (50 tests, real workerd) green inside the gate; `test/worker/incident.test.mjs` dedup/recovery; `test/live-health-budget.test.mjs`; the first `Live health` run `34990029186` succeeded on `main` (generation probe correctly "not configured"); worker deployment still blocked on credentials (§7) | implemented + verified (runtime, live health); Worker deployment blocked |

## 3. §15 negative-proof matrix

Sixteen rows from the brief's §15. "Kind" separates durable in-repo evidence from
drills that lived only in the gitignored `.scratch/ci/evidence/`.

| # | Deliberate condition | Durable evidence | Kind |
| --- | --- | --- | --- |
| a | an existing regression assertion fails | hosted red runs `34926838166`, `34927815616`, `34929670917`: step 9 printed `VERIFY FAIL (steps: … browser✗ …)` naming the failing entry; `.scratch/ci/evidence/s1-c-sabotaged-assertion.md` (flipped assertion, text preserved) | hosted + drill |
| b | a new runnable test is unclassified | `test/ci-guards.test.mjs` — `validate-manifest: an unclassified runnable file is rejected and named` (temp file removed in `finally`) | committed |
| c | a required suite is missing, empty, or skipped | `test/ci-guards.test.mjs` — zero-test guard, unexpected runtime skip, accidental focus modifier, retry-only pass, missing file, duplicate entry, nonexistent path | committed |
| d | browser, axe, or fixture server unavailable | `test/ci-failures.test.mjs` — empty `PLAYWRIGHT_BROWSERS_PATH` ⇒ Playwright's "Executable doesn't exist" in the failure; occupied `FIXTURE_PORT` ⇒ `EADDRINUSE` surfaced; `test/browser/harness.spec.mjs` — planted critical axe violation fails the gate | committed |
| e | the app attempts an unexpected external request | `test/browser/harness.spec.mjs` — unfixtured origin recorded even when the app swallows the error (two independent records) | committed |
| f | a critical a11y or visual regression is introduced | `harness.spec.mjs` planted axe violation; `visual.spec.mjs` baseline compare; hosted `34927815616` failed with `expect(page).toHaveScreenshot(expected) failed` + retained `error-context.md` | committed + hosted |
| g | WASM fails validation or ABI drift | `wasm-validate dist/agent.wasm` and `node scripts/abi-check.mjs dist/agent.wasm` inside `build-site.sh` (exports derived from `js/bridge.js`/`js/models.js`, memory floor from `src/agent.wat`) | enforced in the build; negative case drill-only |
| h | a required asset is absent or a forbidden file enters `_site/` | `build-site.sh` allowlist + `site-inventory.mjs`; drill `s2-failures.md` drills 2–6: injected `.env`, research doc, symlink, deleted vendor file, missing source vendor — each exit 1 | enforced in the build; drill-only negative |
| i | a tested artifact's bytes change before promotion | `node scripts/site-inventory.mjs --verify _site` (verify step 7, hosted step 10); drill 7: post-test WASM tamper ⇒ `content changed after build` + tree-digest mismatch, exit 1 | enforced in the build; drill-only negative |
| j | a required prerequisite fails, cancels, or unexpectedly skips | `test/ci-guards.test.mjs` pins that the required job carries no `if:` and runs the frozen gate command; `workflow-invariants` `required-job-ungated`; ADR 0013 records that a cancelled workflow is non-passing | argued from design + static invariant (no runtime cancel drill) |
| k | a fork/Dependabot/feature-ref run reaches publication | `test/ci-guards.test.mjs` — deploy `if:` evaluated over six contexts (same-repo/fork/Dependabot PR, push to main, feature ref, `workflow_dispatch` on main): only push-to-main is truthy; `publication-gate`, `no-prod-secrets-in-pr` | committed simulation |
| l | an older verified candidate finishes after a newer one | `test/ci-guards.test.mjs` — the freshness `run:` block executed under bash with a stubbed `curl`: tip == candidate ⇒ `fresh=true`; tip != candidate ⇒ `fresh=false` + "superseded — no-op"; curl failure ⇒ step exits nonzero | committed simulation |
| m | a test/log contains the synthetic secret sentinel | `test/ci-failures.test.mjs` — real `check-sentinel.mjs` exits 1 naming file:line for the planted campaign sentinel and a foreign `sk-or-v1-…` key; `test/browser/leak.spec.mjs` is the sentinel's vehicle in the suite. The sentinel is assembled from fragments in every file that handles it, never written as a literal: a retained copy of the source (a trace, an injected review diff) must not itself trip the scan, and `test/ci-guards.test.mjs` enforces that | committed |
| n | the Worker receives a forbidden paid request | `test/worker/chat.test.mjs` — `403 NOT_FREE` with `count=0` upstream calls, plus paid-fallback list and `route:` refusal; `forwardedBody` allowlist | committed |
| o | a live probe exceeds its budget | `test/live-health-budget.test.mjs` (9 tests) — non-integer and above-ceiling values for all four `LIVE_HEALTH_MAX_*` variables are usage errors (exit 2, empty stdout) raised before any request; `live-health.yml` now maps the variables | committed |
| p | the same incident repeats, then recovers | `test/worker/incident.test.mjs` — dedup on repeat failure, recovery closes the same incident, untrusted text neutralised, reporting gate | committed |

Rows still drill-only (gitignored evidence, no committed negative test): **a**
(hosted runs cover it), **g**, **h**, **i**, and the runtime half of **j**. Rows
**b**, **c**, **d**, **e**, **f**, **k**, **l**, **m**, **n**, **o**, **p** have a
committed test that fails if the guard is deleted or weakened.

## 4. Hosted evidence

| Run | Event / ref | Result |
| --- | --- | --- |
| [CI 34989501324](https://github.com/nicolas-found42/assembly-agent/actions/runs/34989501324) | `push` to `main`, `4e6b272` | first publish run: `build-and-test` **success** 3m20s → `deploy` **success** 11s (freshness gate read the tip, then `actions/deploy-pages`) → `Deployed-site smoke` **success** 12s; Pages deployment `6462600548` |
| [CI 34989620823](https://github.com/nicolas-found42/assembly-agent/actions/runs/34989620823) | `pull_request`, PR `#48` head `996439b` | `build-and-test` **success** 3m23s — the first grouped `deps-dev` bump (yaml 2.8.3 → 2.9.1) passes the gate; `deploy` + `Deployed-site smoke` skipped (push-to-main only) |
| [CI 34989651920](https://github.com/nicolas-found42/assembly-agent/actions/runs/34989651920) | `pull_request`, PR `#49` head `84a0b1d` | `build-and-test` **failure** 17s at `Install npm dependencies` — `npm ci` rejects the vitest 5 tree with `ERESOLVE`: `@cloudflare/vitest-pool-workers@0.22.0` peers `vitest ^4.1.0`. The gate refusing a resolution it cannot install, not a test failure (§6) |
| [Live health 34990029186](https://github.com/nicolas-found42/assembly-agent/actions/runs/34990029186) | `workflow_dispatch`, `main` | **success** — first run of the scheduled workflow; non-generating checks only, probe reported as not configured |
| [Cross-browser 34990031960](https://github.com/nicolas-found42/assembly-agent/actions/runs/34990031960) | `workflow_dispatch`, `main` | **success** 8m01s — first run of the scheduled workflow; firefox + webkit, 160 tests |
| [CI 34986386666](https://github.com/nicolas-found42/assembly-agent/actions/runs/34986386666) | `pull_request`, head `950422c` | `build-and-test` **success** 3m18s — the full 11-step gate on `ubuntu-24.04`: `RUNNER offline PASS (17/17)`, worker, `RUNNER browser PASS`, `LINT PASS (8/8)`, `SENTINEL OK`, and `INVENTORY OK` twice (once inside the gate, once as the promotion guard); `deploy` + `Deployed-site smoke` skipped (push-to-main only) |
| [CodeQL 34986386674](https://github.com/nicolas-found42/assembly-agent/actions/runs/34986386674) | `pull_request`, head `950422c` | both analyses **success** |
| [CI 34984924887](https://github.com/nicolas-found42/assembly-agent/actions/runs/34984924887) | `pull_request`, head `7841592` | **failure at step 11** — sentinel: 10 of 11 steps green; the retained Playwright JSON report carries a review tool's embedded `git diff`, and a document quoting the sentinel literal was inside it. Fixed at the root by `950422c` (§6) |
| [CI 34970772333](https://github.com/nicolas-found42/assembly-agent/actions/runs/34970772333) | `pull_request`, head `9313d41`, merge `bb2fed0` | `build-and-test` **success** 12:45:47→12:48:31 (2m44s); `deploy` and `Deployed-site smoke` **skipped** (push-to-main only; nothing was published) |
| [CodeQL 34970772349](https://github.com/nicolas-found42/assembly-agent/actions/runs/34970772349) | `pull_request`, head `9313d41` | `analyze (javascript-typescript)` and `analyze (actions)` **success** |
| [CI 34926838166](https://github.com/nicolas-found42/assembly-agent/actions/runs/34926838166) | `pull_request`, `9b2ef79` | **failure at step 9** — worker class: no parseable vitest summary plus workerd uncaught `simulated connection reset`; browser 7 failing |
| [CI 34927815616](https://github.com/nicolas-found42/assembly-agent/actions/runs/34927815616) | `pull_request`, `b8bc581` | **failure at step 9** — visual baseline mismatch (`toHaveScreenshot(expected) failed`) |
| [CI 34929670917](https://github.com/nicolas-found42/assembly-agent/actions/runs/34929670917) | `pull_request`, `46974a3` | **failure at step 9** — dialogs baseline mismatch; fixed by runner-rendered baselines (`308b9ff`) |

Ten of the last eleven runs of *this repository's* workflows (CI, CodeQL,
Cross-browser, Live health) are green. Dependabot's internal update jobs arrive as
`dynamic` events rather than repository workflows and are not counted — including
them would make the same window nine of eleven. Five red runs are recorded above,
and each one failed *inside* the required gate or its install step rather than in
a side channel: four produced a fix, and the fifth is the gate refusing a
dependency tree it cannot install (`#49`, §6) — so the gate is demonstrated to
fail closed on a runner rather than only locally.

`cross-browser.yml` and `live-health.yml` could not run before the merge: GitHub
resolves workflow files from the default branch, so
`gh workflow run cross-browser.yml --ref ci/campaign` returned
`HTTP 404: workflow cross-browser.yml not found on the default branch`. That is
recorded here because it is why the scheduled legs are verified only after the
merge — and after the merge both ran: `Cross-browser` `34990031960` (firefox +
webkit, 160 tests, 8m01s) and `Live health` `34990029186`, dispatched by hand on
`main`. All five repository workflows are now registered
(`ci.yml`, `codeql.yml`, `cross-browser.yml`, `live-health.yml`,
`worker-deploy.yml`), so the cron schedules (`07:23` and `06:17` UTC) execute from
here on. `worker-deploy.yml` remains a deliberate no-op until its owner
prerequisites exist (§7).

**Deployed-site smoke against production (local runs, coordinator, before and after the merge):**
before — `node scripts/live-health.mjs --mode health --expect-commit
332ed511e3fbecce22d89032cc4b9ec9fc499339 --base-url
https://nicolas-found42.github.io/assembly-agent/` ⇒ exit 10,
classification `deployment`: `site.build-info` 404 `[site.build-info-missing]`
and `site.vendor.{marked,purify,highlight}` / `site.font` 404
`[site.asset-missing]`, while `site.base`, `site.entry`, `site.wasm`
(200, `application/wasm`), `site.wasm-valid`, `worker.health`
(200 `{"ok":true,"freeOnly":true}`), `worker.free-only-boundary` (403) and
`catalog.shape` (446 models, 20 free) passed — the live tree was still the
pre-campaign artifact published by the retired `deploy.yml`.
After the merge, the same command with the merge commit's full SHA —
`--expect-commit 4e6b272bed071b5b345049e0823a18ea9946587a` — returns
**exit 0**: every check passes, including `site.vendor.*`, `site.font` and
`site.build-info` ("commit `4e6b272bed…`; wasm digest matches served bytes"), so
the campaign publication now satisfies the vendor/font/build-info contract. The
comparison is an exact string match (`live-health.mjs`:
`parsed.commit === args.expectCommit`), so an abbreviated SHA is reported as
`[site.stale-artifact]` even against a correct deployment, and the check reads
the commit that is live *now* — it is meaningful only against the current tip.

## 5. Local verification

- `npm run verify` (coordinator-run) — **PASS 11/11**, run repeatedly; expected
  count `expected 88, unexpected 0, flaky 0` in the Playwright report. The staged
  tree digest is stable for a given commit and lockfile (`sha256:7a891fe7…` for
  tip `9313d41`, `sha256:e91832bd…` for `7841592`, 23 files, 537,841 bytes) — it
  tracks them because `_site/build-info.json` records both the commit and
  `lockfileSha256`, and everything else in the tree is byte-identical across runs
  and platforms. (Building the artifact with and without the yaml bump applied in
  this change set leaves `build-info.json` as the only file that differs, which is
  that field moving and nothing else.)
- Class counts from the **final** gate run (after the three new §15 files landed):
  **offline 77** (17 entries), **worker 50**, **browser 88** (chromium),
  **scheduled-browser 160** (firefox 80 + webkit 80 — re-run green on this tree,
  295 s, `RUNNER scheduled-browser PASS`); the cross-browser config declares
  3 engines × 80 = 240. Visual baselines: **22 PNGs** (11 states × darwin/linux,
  chromium only — the cross-browser config ignores `visual.spec.mjs` by design).
- The three §15 files are `test/ci-guards.test.mjs` (11 tests — validator/runner
  guards, the event/ref matrix, the freshness decision, the no-snapshot-auto-accept
  invariant), `test/live-health-budget.test.mjs` (9 tests — per-variable
  non-integer and above-ceiling usage errors, proving validation happens before
  any network work) and `test/ci-failures.test.mjs` (3 tests — missing browser,
  unavailable fixture port, sentinel leak). All three are listed in
  `test/manifest.json`; `MANIFEST OK (21 tests, 0 helpers, 1 fixtures)` and the
  gate runs `RUNNER offline PASS (17/17 entries)`.
- Commands this report checked directly: `node scripts/abi-check.mjs
  dist/agent.wasm`, `node scripts/workflow-invariants.mjs` (13/13),
  `bash scripts/install-lint-tools.sh --print-versions`, `bash
  scripts/settings-apply.sh`, `node --test` on the three §15 files, `jq` over
  `artifacts/results/*.json` and `artifacts/site-inventory.json`, and the
  GitHub API reads in §4.
- Toolchain as resolved: Node `26.8.2` local / pin `24.21.0` CI, npm `11.19.1`,
  WABT `1.0.41`, Playwright `1.63.0` (chromium `153.0.8010.12`/r1243,
  firefox `155.0`/r1543, webkit `26.6`/r2359), actionlint `1.7.12`,
  zizmor `1.30.1`, shellcheck `0.11.0`, runner `ubuntu-24.04`.
- `bash scripts/settings-apply.sh` (tool of record) — **applied during this change set**,
  and now clean: `sha_pinning_required=true` ok, default workflow token `read` ok,
  `dependabot security updates: enabled`, code-scanning default setup
  `not-configured` (single CodeQL publisher) ok, secret scanning + push protection
  `enabled`, required context `build-and-test` present, `github-pages` ok and
  **its branch policy read as `main` only**, `cloudflare-worker` exists with a
  `main`-only branch policy and a required reviewer. `--check` exits 0. What
  remains pending is listed in §7 (the two Cloudflare secrets, the
  `ENABLE_WORKER_DEPLOY` opt-in, the Worker's own `OPENROUTER_KEY`).
- `scripts/settings-apply.sh` itself was tightened in this change set: it now
  reads the `github-pages` **branch policy** (not just the environment's name) and
  reports each missing `cloudflare-worker` prerequisite by name, instead of
  printing `ok` for an environment that has no credentials.

## 6. Security findings, exceptions, flakes, residual risks

Fixed in this change set:

- **DOMPurify kept `<style>`** — a hostile answer could fetch a remote stylesheet
  and restyle the app. `js/markdown.js` now passes `FORBID_TAGS: ['style']`;
  `@security hostile markup: style element / @import stays inert` covers it.
- **r.jina.ai empty bodies counted as Sources** — a 200 with an empty body made
  the documented "no search results" state unreachable. `js/search.js`
  `jinaHelper` skips it.
- **Worker free-only boundary covered only the model id** — a paid `models[]`
  fallback or `route:` would have spent the Operator Key. `worker/api-chat.js`
  refuses both and forwards only an allowlist (`FORWARDED_FIELDS`), so an
  unreviewed billed field (e.g. the `web` plugin) cannot ride along.
- **502 forwarded raw provider exception text** — the body is now
  `{"error":{"message":"Upstream fetch failed"}}`; the truncated exception
  remains only in the Worker's structured log line
  (`status:"upstream_fetch_error"`).
- **CodeQL findings in campaign code** — two issues in `scripts/ci-summary.mjs`
  and `scripts/incident.mjs` fixed (`ab3e555`); no suppression was added.
- **shellcheck over the repo's own scripts** — new 8th lint section
  (`shellcheck -S warning`, 8 scripts); two narrow suppressions
  (`setup-proxy.sh` SC2034 palette, `lint.sh` SC2206 deliberate list), `cd` bug
  fixed rather than suppressed.

Exception: `scripts/audit-policy.exceptions.json` carries one dated exception —
`sharp <0.35.4` (GHSA-rgj7-g3m4-5g8c plus the two libheif advisories) reached
through the dev-only `@cloudflare/vitest-pool-workers` → `miniflare` → `sharp`
chain (and `wrangler`); owner `@nicolas-found42`, `reviewBy: 2026-12-14`. Audit
policy: 0 critical, 0 moderate/low, 4 high findings — all four the same advisory
on that one chain; registry failure is reported as an unavailable scan, never as
"0 vulnerabilities". The same chain defeats the updater, not only the audit:
Dependabot's security-update job for that alert exits 1 with *"A patched version
exists for sharp, but the available update path still resolves it to 0.33.5"*
(`top_level_ancestor: @cloudflare/vitest-pool-workers`, run
[34989513002](https://github.com/nicolas-found42/assembly-agent/actions/runs/34989513002)),
so no update PR exists to merge and the alert stays open until `miniflare` (via
the pool) moves to a patched `sharp` — which is exactly what the dated exception
is for, and why it is re-reviewed by 2026-12-14 rather than assumed transient.

Known flakes: none observed — the browser config runs with `retries: 0`, and
repeat runs were green. The linux visual baselines were originally rendered in
the `mcr.microsoft.com/playwright:v1.63.0-noble` container rather than on a
runner; that risk is now retired by evidence, not by argument: hosted run
[34970772333](https://github.com/nicolas-found42/assembly-agent/actions/runs/34970772333)
executed `visual.spec.mjs` (8 specs) on `ubuntu-24.04` with the committed
baselines and reported `expected 88, unexpected 0, flaky 0`. A future runner
image change would show up as a screenshot diff, never as an auto-accept.

Residual risks:

- **The vitest 5 upgrade is deferred, and cannot yet land (Dependabot `#49`).**
  `@cloudflare/vitest-pool-workers` — latest published release `0.22.0`, which is
  what this repository uses — peers `vitest ^4.1.0`, `@vitest/runner ^4.1.0` and
  `@vitest/snapshot ^4.1.0`. The first range is the install blocker: vitest 5.0.0
  falls outside it, so `npm ci` refuses the tree before a single test runs. Behind
  it sits the structural one: vitest 5 inlines its runner, so `@vitest/runner` is
  published only up to 4.1.11 — a vitest 5 tree could carry nothing but that 4.x
  copy beside vitest 5's own inlined runner, which is the mismatched pairing the
  required worker class cannot afford. That class draws its evidence from running
  inside the real workerd runtime *through that pool* (R09), so the bump has no
  supported landing: `npm ci` on `#49` fails with `ERESOLVE` on a hosted runner
  (`34989651920`), and `--force`/`legacy-peer-deps` would buy that unsupported
  combination rather than an upgrade. vitest stays on `^4.1.0` until the pool
  publishes vitest 5 support, or until the worker class is moved onto a different
  workerd harness — a change that would give up the pool's current-runtime
  property and is not part of this campaign. The two interfaces that would have to
  change besides the peers were checked rather than assumed:
  `scripts/run-tests.mjs` gates the class on the reporter's `Tests` block, and
  vitest 5.0.0 prints that block exactly as 4.1.11 does — a mixed probe yields
  `Tests  1 failed | 1 passed | 1 skipped (3)` under both, so the `failed`,
  `passed` and `skipped` counters the runner reads (and fails on) parse
  identically, `disableConsoleIntercept` is still honoured, and only the
  `Duration` breakdown's wording differs, which the runner never reads. The
  worker suite also touches none of the APIs vitest 5 removes or tightens — its
  imports are exactly `describe`/`test`/`expect`/`beforeEach` plus
  `cloudflare:test`. So the deferral is a peer-range wait, not a harness
  migration.
- Remote `img`/`video`/`audio` sources and the inline `style` attribute remain
  allowed after sanitization (the inline attribute can still name a remote
  `url()`); forbidding inline styles is a broader content decision and was not
  taken here — see ADR 0012 and `CONTEXT.md`.
- Row **j** (a cancelled or unexpectedly skipped required prerequisite) is argued
  from design plus a static invariant, not exercised by a runtime cancellation
  drill.
- Rows **g**, **h**, **i** are enforced inside the real build/verify path but have
  no committed planted-fault test; their negative proofs are the gitignored
  `.scratch/ci/evidence/` drills.
- `check-sentinel.mjs` scans retained output. Two ways a green tree could still show
  a finding, both now contained: (1) the sentinel must never be written as a literal
  in the repository — the hosted runner proved why on 2026-09-15, when a third-party
  review reporter embedded the PR's `git diff` in the retained Playwright JSON report
  and a document quoting the value failed the scan on an otherwise green run; the
  value is now assembled from fragments everywhere it is handled, and
  `test/ci-guards.test.mjs` fails if any tracked file carries it. (2) A *failing*
  `leak.spec.mjs` run renders the sentinel into the page by design, so its retained
  error context can still quote it — that finding is real (the value really is in a
  retained artifact), the class is already red, and the class summary is written
  before the scan runs, so attribution is preserved.

## 7. Owner-only activation

All of these are repository/Cloudflare settings, not code. The tool of record is
`bash scripts/settings-apply.sh` — dry run by default, `--apply` to change,
`--check` to exit 1 on drift — and it never edits branch protection or the
`github-pages` environment (it verifies them).

| Setting | Prerequisite | Verification | Rollback |
| --- | --- | --- | --- |
| Actions: require full-length SHA pinning | **applied** (`--apply` during this change set; every external `uses:` was already a full SHA) | `bash scripts/settings-apply.sh --check` exits 0; `actions: … sha_pinning_required=true` | `gh api -X PUT repos/{owner}/{repo}/actions/permissions -F enabled=true -f allowed_actions=all -F sha_pinning_required=false` |
| Dependabot alerts + security updates | **applied** (`vulnerability-alerts` first — security updates 422 without it — then `automated-security-fixes`) | dry run prints `ok Dependabot security updates are on`; `dependabot/alerts?state=open` returns **one** open alert — `sharp` (high, `GHSA-rgj7-g3m4-5g8c` through the dev-only `@cloudflare/vitest-pool-workers` chain) created 2026-09-15T15:35:47Z, seconds after the merge and therefore after this report's first draft; it is the finding §6 carries a dated exception for, and no security-update PR can carry the fix (§6) | `gh api -X DELETE repos/{owner}/{repo}/automated-security-fixes` (and `-X DELETE .../vulnerability-alerts`) |
| Code scanning publisher | keep account-level *default setup* off while `codeql.yml` is the publisher | dry run prints `code scanning default setup: not-configured` ok | delete `codeql.yml` **or** enable default setup, never both |
| `cloudflare-worker` environment | **created and protected**: `main`-only branch policy + required reviewer (`nicolas-found42`) | dry run prints `ok protected environment 'cloudflare-worker' exists` and then names each missing secret | `gh api -X DELETE repos/{owner}/{repo}/environments/cloudflare-worker` |
| `CLOUDFLARE_API_TOKEN` (Workers Scripts: edit) + `CLOUDFLARE_ACCOUNT_ID` (environment secrets on `cloudflare-worker`) | **pending** — needs the account that owns the Worker; never paste a value into chat, a workflow or an artifact | dry run stops printing `PENDING environment secret …` | delete the environment secrets |
| `ENABLE_WORKER_DEPLOY=true` (repository variable) | the environment and both secrets above | dry run prints `ok ENABLE_WORKER_DEPLOY is set: Worker deployment is armed`; a dispatch then records a version id in `artifacts/results/worker-deploy.json` behind the environment's approval | unset the variable (the workflow is a no-op) |
| Worker secret `OPENROUTER_KEY` | Cloudflare account access | `npx wrangler secret list` on the Worker names the secret; `worker-deploy.sh` refuses to promote a version without it; never print a value | rotate with `wrangler secret put OPENROUTER_KEY` |
| `LIVE_HEALTH_ENABLE_GENERATION` + `LIVE_HEALTH_MAX_{REQUESTS,TOKENS,DURATION_MS,CONCURRENCY}` | none for the non-generating checks; quota for the probe. The four budget variables are now mapped into `live-health.yml` from `vars.*` | dispatch `live-health.yml`: unset ⇒ `generationProbe: "not-configured"` (reported as not configured, not as a passing generation test); set ⇒ one budgeted free-model probe per run, and a non-integer or above-ceiling value is a usage error before any request | unset the variables (non-generating health checks keep running) |

## 8. Merge and activation order

Implemented in the repository and verified in GitHub: the required gate and all
required classes, the artifact guard, lint/security/engine checks, CodeQL, and the
evidence pipeline. Exercised by the platform after the merge: Pages publication,
the post-deploy smoke, the scheduled cross-browser and live-health workflows.
Activated in production: the campaign site is live (`4e6b272`, deployment
`6462600548`). Not activated: Worker deployment, which waits on credentials.

1. ~~Merge PR #47 into `main`.~~ **Done** 2026-09-15T15:35:42Z as merge commit
   `4e6b272` (13 campaign commits preserved).
2. ~~The first `push`-to-main run must publish Pages and then run
   `post-deploy-smoke`.~~ **Done** — CI `34989501324`: `build-and-test` 3m20s →
   `deploy` 11s → `Deployed-site smoke` 12s, all success; the live
   `build-info.json` reports commit `4e6b272…` and the served wasm digest matches.
3. ~~Confirm the scheduled workflows register after the merge and dispatch each
   once by hand.~~ **Done** — all five workflows registered; `Live health`
   `34990029186` and `Cross-browser` `34990031960` (firefox + webkit, 160 tests)
   both green on `main`. The crons (`cross-browser.yml` 07:23 UTC,
   `live-health.yml` 06:17 UTC, weekly CodeQL) now fire on their own.
4. Owner settings: **already applied** — SHA pinning, Dependabot alerts and
   security updates are on and `bash scripts/settings-apply.sh --check` exits 0;
   the `cloudflare-worker` environment exists with a `main`-only branch policy
   and a required reviewer. Dependabot opened its first grouped npm PRs
   (`#48`, `#49`) within minutes of the merge; `#48`'s required check passed and
   its yaml bump landed with this change set, while `#49`'s vitest 5 major cannot
   install against the worker pool and is deferred (§6).
5. Worker deployment last: add the two Cloudflare environment secrets
   (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and set
   `ENABLE_WORKER_DEPLOY=true`, dispatch `worker-deploy.yml`, verify the recorded
   version id, then optionally enable the live generation probe. Pages never
   implies a Worker release, and the Worker is additive — Pages is already live.

Rollback: Pages by reverting the bad commit on `main` (the pipeline re-verifies
and republishes; a run whose commit is no longer the tip publishes nothing);
Worker with `npx wrangler versions deploy <previous-version-id>@100 --yes`; live
probe by unsetting its variables. Neither path rolls back automatically.
