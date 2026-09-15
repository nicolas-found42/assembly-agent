# ADR 0014: Artifact promotion and deployment trust boundaries

Date: 2026-09-15
Status: Accepted

## Context

The site used to be published from the repository root by a second workflow that
rebuilt and retested the tree in a privileged job just before deploying, and
uploaded the repository root as the Pages artifact. The bytes that were tested and
the bytes that were published were only assumed to be the same, the publisher
needed the whole build toolchain, and the deployment credentials sat in a job that
also ran build scripts and package installs. The Worker had no controlled path at
all: `wrangler deploy` from a developer machine, holding the operator key and the
account credentials.

The campaign required one immutable artifact with one tested identity, a publisher
that cannot be tricked into shipping something else, and separate, explicit trust
boundaries for the two publishers (Pages and the Worker).

## Decision

- **Build once, test the artifact.** `build-and-test` stages `_site/`
  (allowlisted, validated, within size budgets), runs every required class against
  it, and uploads that exact tree as the Pages artifact. Nothing rebuilds it, and
  nothing adds files — including build metadata — afterwards.
- **Digest promotion guard.** `artifacts/site-inventory.json` records a sha256 per
  staged file and one `treeDigest` over the sorted list; `_site/build-info.json`
  carries the commit, the WASM digest, the lockfile digest and the dependency
  versions. `node scripts/site-inventory.mjs --verify _site` runs after the tests
  and before the upload, so any byte changed after testing fails the run before
  anything can be published.
- **A publisher with no build step.** The `deploy` job has `needs:
  build-and-test`, runs only for `push` to `refs/heads/main`, holds
  `pages: write` + `id-token: write` (plus read) inside the protected
  `github-pages` environment, and executes no checkout, no package install, no
  test and no build — it consumes the artifact the gate produced. Its group is
  `github-pages` with `cancel-in-progress: false`, so an active publication is
  never cancelled.
- **Freshness gate.** Before deploying, the job compares its commit with the
  current tip of `main` (a plain `Accept: application/vnd.github.sha` read, no
  JSON parsing; a failed read aborts). If `main` has advanced, the run publishes
  nothing and says so, and the newer commit's own verified run publishes. This is
  independent of queue order, which is why a superseded run can never overwrite a
  newer deployment.
- **Rollback is explicit and authorised.** Preferred: revert the commit on `main`
  and let the normal pipeline re-verify and publish it. Emergency: an
  administrator re-deploys a previously verified artifact through the Pages API
  and records it in the deployment history. No workflow input can publish an
  arbitrary ref.
- **The Worker publisher is a separate, opt-in trust boundary.**
  `.github/workflows/worker-deploy.yml` is manual-only (`workflow_dispatch` with a
  typed confirmation), gated by the repository variable `ENABLE_WORKER_DEPLOY`, a
  `refs/heads/main` guard, the protected `cloudflare-worker` environment with its
  reviewers, and a required-check lookup on the exact commit (`gh api
  .../check-runs`, falling back to the merged pull-request head that produced it).
  `scripts/worker-package.mjs` records the bundle identity with a credential-free
  dry run, and `scripts/worker-deploy.sh` re-verifies the source and configuration
  digests immediately before `versions upload --strict` →
  `versions deploy <version-id>@100`. Nothing here writes a secret, and there is
  no automatic rollback: an upstream provider outage must not roll the application
  back.
- **Live probes are budgeted and opt-in.** `scripts/live-health.mjs` runs
  read-only checks by default; the generation probe needs
  `LIVE_HEALTH_ENABLE_GENERATION` (or an explicit flag), performs at most one real
  request, never retries and never falls back to a paid model, and reports budget
  exhaustion as an outcome. The scheduled workflow runs it; the post-deploy smoke
  does not enable generation.
- **Incidents are deduplicated.** `scripts/incident.mjs` keeps at most one open
  issue per (service, failure class), updates it while the failure persists, and
  closes it with a recovery comment. Only the `report-incident` job holds
  `issues: write`, and only sanitised data reaches an issue.

## Consequences

- A fork, Dependabot or feature-branch run cannot reach a publisher: the deploy
  jobs require a main push or are manual-only, and the environments allow only
  `main` (Pages) or are not yet configured (Worker).
- The published site is exactly the tested tree, and the smoke job can distinguish
  a stale artifact from a broken new one by comparing the served commit with the
  expected one.
- Rollback speed is bounded by a pipeline run; the emergency path is an
  administrator action by design.
- The Worker stays on its current version until an owner creates the
  `cloudflare-worker` environment, sets `ENABLE_WORKER_DEPLOY` and installs the
  credentials — the workflow is a no-op until then.
- The `cloudflare-worker` environment is the only home for Cloudflare credentials,
  and the operator key is a Worker secret, never a repository secret.

## Considered Options

- **Rebuild in the deploy job** (the previous shape). Rejected: it tests one tree
  and ships another, and it hands the publisher a build toolchain and package
  install it does not need.
- **Inject build metadata at deploy time** (write the commit into the artifact
  from the deploy job). Rejected: it mutates the artifact after testing, which is
  exactly what the digest guard exists to catch.
- **Publish the repository root as the artifact** (the previous shape). Rejected:
  nothing then ties what was tested to what is served, and the publisher must
  carry the build toolchain to produce a tree the gate did not verify.
- **Deploy the Worker automatically on main pushes.** Rejected: a Worker release
  changes the upstream boundary the frontend depends on, and the required gate
  covers the site, not the Worker's runtime.
- **One environment for both publishers.** Rejected: Pages needs `pages`/`id-token`
  and the Worker needs Cloudflare credentials; sharing protection would widen
  both.
- **Automatic rollback when the post-deploy smoke fails.** Rejected: a provider
  outage or a transient network failure is not a reason to roll a release back,
  and an automatic rollback would itself be an unattended production change.
