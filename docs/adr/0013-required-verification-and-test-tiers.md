# ADR 0013: Required verification and test tiers

Date: 2026-09-15
Status: Accepted

## Context

Before this campaign, CI was hand-wired. `.github/workflows/ci.yml` listed the
`node --test` files and the engine scripts inside a `run:` line, and a second
workflow (`.github/workflows/deploy.yml`) repeated the same build-and-test steps
as its own gate before publishing. A test file that nobody added to that line
simply did not run, and nothing in the repository could tell that it had been
omitted. Browser and accessibility checking was a developer-local manual harness
(`test/a11y.browser.mjs`, puppeteer + axe, network-dependent), so the only
automated check that mattered was the one a human remembered to run. There was no
machine-readable result and no way to tell a skipped suite from a passing one.

The campaign required one required result, deterministic browser verification
against the artifact that ships, and a definition of "required" a reviewer can
inspect.

## Decision

- **One required result.** `build-and-test` is the only required status context on
  `main`. It is the job id in `.github/workflows/ci.yml` — deliberately no `name:`
  override, because the required context is the job id and a rename would leave
  every pull request waiting on a check that no longer reports.
  `scripts/workflow-invariants.mjs` (part of `npm run lint`) fails if that
  changes, and `scripts/settings-apply.sh` reports whether branch protection still
  requires the exact string.
- **One required command.** `npm run verify` (`scripts/verify.mjs`) is the gate:
  every step is named, all steps run even after a failure, all failures are
  reported, and the process exits nonzero if any failed. The step list is declared
  once, in that file; no workflow YAML restates it, and `--only <step>` reproduces
  a single step locally.
- **Five test classes.** `offline`, `worker` and `browser` are required;
  `scheduled-browser` and `live` are optional. The tiers exist because they fail
  differently and cost differently: `offline` is deterministic and self-contained,
  `worker` executes the Worker in real workerd, `browser` drives the staged
  `_site/` in Playwright on chromium, `scheduled-browser` runs the same browser
  suite on firefox and webkit where an engine difference is a signal rather than a
  PR gate, and `live` holds operational probes against deployed or external
  systems under budgets of their own.
- **Probes are excluded from required discovery.** A manifest entry flagged
  `live`/`probe` must be in the `live` class and can never sit in a required class;
  `scripts/validate-manifest.mjs` enforces it. Live traffic, credentials and
  provider quota therefore cannot make a pull request fail, and a probe that is
  temporarily unavailable cannot be mistaken for a regression.
- **Membership lives in a manifest, not in workflow YAML.** `test/manifest.json`
  is the single declaration of what belongs to which class, and every runnable
  file under `test/` must be listed (suite internals under `test/browser/` and
  `test/worker/` are covered by their suite entry). Adding a test file without
  listing it fails the gate with the file named — the failure mode the old CI had.
- **The runner refuses what would hide a gap.** `.only` (silent shrinking),
  `.skip`/`.todo` (a green run that tested less), zero-test files and retry-only
  passes all fail a required class, and a class with zero entries fails rather
  than reporting success.
- **No workflow-level `concurrency:` and no job `name:` on the required job.** A
  workflow-level group with `cancel-in-progress` can cancel the deploy job's own
  per-environment group and abort an active publication, so the required job
  carries a PR-scoped group instead (`ci-pr-<n>` for PRs, `ci-ref-<ref>-<sha>`
  otherwise) and publishing keeps a separate non-cancelling group. The required
  job keeps its bare job id so the context string cannot drift. Both absences are
  intentional and are reported as advisory lint findings rather than suppressed.

## Consequences

- A workflow change that renames the job, adds a workflow-level `paths:` filter,
  or wraps a required step in `continue-on-error: true` fails `npm run lint`
  before it can strand `main`.
- "What does the required check actually run?" has one answer: `scripts/verify.mjs`
  plus the manifest it reads.
- Optional tiers are excluded explicitly (by `if:` guards, or by not being
  required), and a skipped optional job is never read as a pass.
- Adding a required test is a two-file change — the test and its manifest entry —
  and shows up in review as such.
- The cross-browser and live-health workflows never gate a merge, so an engine
  difference or an unavailable provider is a signal, not a blocked pull request.

## Considered Options

- **Keep the file lists in workflow YAML.** Rejected: two places to update, no way
  to detect an omitted regression, and the deploy workflow had already duplicated
  the gate.
- **An aggregate "required" job that `needs:` every other job.** Rejected: a
  cancelled workflow cannot run the aggregate, and a failed prerequisite surfaces
  as a skipped job — both read as "not failed" in the checks UI. One job with all
  the steps has no such state.
- **A workflow-level `concurrency:` block.** Rejected: it can cancel an active
  deployment. Publishing is serialized by the deploy job's `github-pages` group
  with `cancel-in-progress: false` instead.
- **Giving the required job a `name:` for readability.** Rejected: the required
  status-check context on `main` is the job id, so a rename strands every PR
  behind a pending check.
- **`paths` filters on the required workflow.** Rejected: with a filter, the
  required context never reports for changes outside the paths, and those PRs
  cannot merge.
- **Retries on the browser class.** Rejected: a retry-only pass is a failure in
  this runner. A flaky suite is a defect to fix, not to paper over.
