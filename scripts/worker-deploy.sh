#!/usr/bin/env bash
# scripts/worker-deploy.sh — the single, trusted production publisher for the Cloudflare Worker (R09 §12.2).
#
# Everything below is checked BEFORE anything reaches Cloudflare. The workflow that calls this script is
# manual-only; ordinary PR verification never has these credentials.
#
#   ENABLE_WORKER_DEPLOY=true       repository variable (owner-configured opt-in; the workflow is a no-op
#                                   while it is unset)
#   CONFIRM_DEPLOY=deploy-worker    typed confirmation from the workflow_dispatch input
#   GITHUB_REF=refs/heads/main      approved source ref only
#   build-and-test passed           the required check must have succeeded on this exact commit
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID   from the protected `cloudflare-worker` environment only
#
# Steps: package (dry run + identity) → re-verify the source/config digests → `versions upload --strict`
#        → `versions deploy <version-id>@100` → write artifacts/results/worker-deploy.json.
#
# Deliberately absent: any secret write (`wrangler secret put`), any automatic retry, any automatic
# rollback (an upstream provider being down is not a reason to roll back the application).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PACKAGE_JSON="artifacts/results/worker-package.json"
DEPLOY_JSON="artifacts/results/worker-deploy.json"

die() { echo "WORKER-DEPLOY FAIL: $*" >&2; exit 1; }

# ── 1. owner opt-in, typed confirmation, approved ref ───────────────────
[[ "${ENABLE_WORKER_DEPLOY:-}" == "true" ]] \
  || die "the repository variable ENABLE_WORKER_DEPLOY is not 'true' — deployment stays disabled until an owner enables it"
[[ "${CONFIRM_DEPLOY:-}" == "deploy-worker" ]] \
  || die "typed confirmation missing: pass confirm=deploy-worker to the workflow"
[[ "${GITHUB_REF:-}" == "refs/heads/main" ]] \
  || die "refusing to publish from '${GITHUB_REF:-<unset>}' — only refs/heads/main may deploy"

# ── 2. the required check passed on this exact commit ───────────────────
SHA="${GITHUB_SHA:-}"
REPO="${GITHUB_REPOSITORY:-}"
[[ -n "$SHA" && -n "$REPO" ]] || die "GITHUB_SHA / GITHUB_REPOSITORY are not set"
[[ "${GH_TOKEN:-}" != "" ]] || die "GH_TOKEN is not set — the required-check verification cannot run"

successful_required_checks() { # $1 = commit SHA -> number of successful `build-and-test` runs
  gh api "repos/$REPO/commits/$1/check-runs?per_page=100" \
    --jq '[.check_runs[] | select(.name == "build-and-test" and .conclusion == "success")] | length'
}

DIRECT="$(successful_required_checks "$SHA")" || die "could not read check runs for $SHA"
if [[ "$DIRECT" != "0" ]]; then
  VERIFIED_BY="check run 'build-and-test' on $SHA"
else
  # `build-and-test` runs on pull requests, so main's merge/squash commit itself carries no such check run.
  # Fall back to the merge provenance — and only that: the commit must be main's tip and must come from a
  # merged pull request whose head commit passed the required check.
  TIP="$(gh api "repos/$REPO/commits/main" --jq '.sha')" || die "could not read main"
  [[ "$TIP" == "$SHA" ]] || die "$SHA is not a verified commit: no successful 'build-and-test' run and it is not the tip of main"
  PR_HEAD="$(gh api "repos/$REPO/commits/$SHA/pulls" --jq '[.[] | select(.merged_at != null) | .head.sha] | first // ""')" \
    || die "could not read the pull request that produced $SHA"
  [[ -n "$PR_HEAD" ]] || die "no merged pull request found for $SHA — deploy only a commit that passed the required check"
  PR_CHECKS="$(successful_required_checks "$PR_HEAD")" || die "could not read check runs for $PR_HEAD"
  [[ "$PR_CHECKS" != "0" ]] || die "'build-and-test' has not succeeded on the pull-request head $PR_HEAD — deploy only a verified commit"
  VERIFIED_BY="required check on the merged pull-request head $PR_HEAD that produced $SHA"
fi
echo "WORKER-DEPLOY ref check ok: $VERIFIED_BY"

# ── 3. credentials from the protected environment only ──────────────────
for name in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  [[ -n "${!name:-}" ]] || die "$name is not set — source it from the protected 'cloudflare-worker' environment"
done

# ── 3b. the operator key must already exist as a Worker secret ──────────
# `[secrets] required` in wrangler.toml is a declaration: wrangler warns about a
# missing one (in dev and in dry runs) but does not stop a deployment, so this is
# the enforcement point. A version that cannot reach the upstream at all must not
# be promoted, and nothing here writes a secret.
echo "WORKER-DEPLOY checking the Worker's secrets (names only, never values)"
SECRETS_OUT="$(npx wrangler secret list 2>&1)" || die "could not read the Worker's secret list:
$SECRETS_OUT"
printf '%s' "$SECRETS_OUT" | node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
  let list;
  try { list = JSON.parse(s); } catch { process.stderr.write("unreadable wrangler output\n"); process.exit(2); }
  if (!Array.isArray(list)) { process.stderr.write("unexpected wrangler output shape\n"); process.exit(2); }
  process.exit(list.some((x) => x && x.name === "OPENROUTER_KEY") ? 0 : 1);
});
' || die "the Worker has no OPENROUTER_KEY secret — set it once with 'npx wrangler secret put OPENROUTER_KEY' (never by a workflow in this repository)"
echo "WORKER-DEPLOY worker secret OPENROUTER_KEY present"

# ── 4. package / dry-run, then re-verify the identity being promoted ────
node scripts/worker-package.mjs --json "$PACKAGE_JSON" >/dev/null
BUNDLE_DIGEST="$(node -e '
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const rec = JSON.parse(readFileSync(process.argv[1], "utf8"));
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
if (sha(rec.source.path) !== rec.source.sha256) { console.error("source changed after packaging"); process.exit(1); }
if (sha(rec.config.path) !== rec.config.sha256) { console.error("configuration changed after packaging"); process.exit(1); }
process.stdout.write(rec.bundle.digest);
' "$PACKAGE_JSON")" || die "the packaged source/configuration changed after the dry run — refusing to promote it"

# Previous versions, for the rollback record (best effort: the list is not required to deploy).
PREVIOUS_VERSIONS="$(npx wrangler versions list 2>/dev/null | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -5 | paste -sd, - || true)"

# ── 5. upload a version (no traffic shift), then deploy it at 100% ──────
echo "WORKER-DEPLOY uploading version (bundle digest ${BUNDLE_DIGEST:0:16}…)"
UPLOAD_OUT="$(npx wrangler versions upload --strict \
  --tag "sha-${SHA:0:12}" \
  --message "assembly-agent ${SHA:0:12} (bundle ${BUNDLE_DIGEST:0:12})" 2>&1)" || die "versions upload failed:
$UPLOAD_OUT"
printf '%s\n' "$UPLOAD_OUT"
VERSION_ID="$(printf '%s\n' "$UPLOAD_OUT" | grep -oE 'Worker Version ID: *[0-9a-f-]{36}' | grep -oE '[0-9a-f-]{36}' | head -1 || true)"
[[ -n "$VERSION_ID" ]] || die "could not read the Worker Version ID from the upload output — not deploying an unrecorded version"

echo "WORKER-DEPLOY deploying version $VERSION_ID at 100%"
DEPLOY_OUT="$(npx wrangler versions deploy "${VERSION_ID}@100" --yes 2>&1)" || die "versions deploy failed:
$DEPLOY_OUT"
printf '%s\n' "$DEPLOY_OUT"

# ── 6. record the deployment identity ───────────────────────────────────
RECORD_VERSION_ID="$VERSION_ID" RECORD_PREVIOUS="$PREVIOUS_VERSIONS" RECORD_BUNDLE_DIGEST="$BUNDLE_DIGEST" \
RECORD_SHA="$SHA" RECORD_REF="${GITHUB_REF}" RECORD_REPO="$REPO" RECORD_RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/$REPO/actions/runs/${GITHUB_RUN_ID:-unknown}" \
node -e '
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { dirname } = require("node:path");
const pkg = JSON.parse(readFileSync("artifacts/results/worker-package.json", "utf8"));
const record = {
  schema: "worker-deploy/1",
  at: new Date().toISOString(),
  worker: pkg.worker.name,
  versionId: process.env.RECORD_VERSION_ID,
  previousVersionIds: process.env.RECORD_PREVIOUS ? process.env.RECORD_PREVIOUS.split(",") : [],
  bundleDigest: process.env.RECORD_BUNDLE_DIGEST,
  sourceSha256: pkg.source.sha256,
  configSha256: pkg.config.sha256,
  compatibilityDate: pkg.worker.compatibilityDate,
  commit: process.env.RECORD_SHA,
  ref: process.env.RECORD_REF,
  repository: process.env.RECORD_REPO,
  runUrl: process.env.RECORD_RUN_URL,
  secretNames: pkg.secretNames,
  rollback: `npx wrangler versions deploy <previous-version-id>@100 --yes`,
};
mkdirSync(dirname(process.argv[1]), { recursive: true });
writeFileSync(process.argv[1], `${JSON.stringify(record, null, 2)}\n`);
' "$DEPLOY_JSON"

echo "WORKER-DEPLOY ok: version $VERSION_ID (record: $DEPLOY_JSON)"
echo "WORKER-DEPLOY rollback, if needed: npx wrangler versions deploy <previous-version-id>@100 --yes"
echo "WORKER-DEPLOY the OpenRouter operator key stays a Worker secret (wrangler secret put OPENROUTER_KEY); this script never writes secrets."
