#!/usr/bin/env bash
# settings-apply.sh — idempotent, inspectable administrator settings for this repo.
#
#   bash scripts/settings-apply.sh            # dry run: report every difference (default)
#   bash scripts/settings-apply.sh --apply    # apply the differences
#   bash scripts/settings-apply.sh --check    # report only; exit 1 when drift exists
#
# Why a script: the campaign's repository-side work is verifiable, but the settings
# that make it effective (SHA-pinning enforcement, Dependabot security updates,
# code-scanning publisher, protected environment, required check context) live in
# the GitHub API. This script reads them, states exactly what it would change, and
# preserves every setting it does not own.
#
# Never changes, only verifies:
#   * branch protection: required status-check context `build-and-test` must be present.
#     The required-check migration in R05 depends on that exact context; the script
#     reports a mismatch instead of editing branch protection (a botched edit here
#     would strand every PR).
#   * the `github-pages` environment and its branch policy.
#   * secret scanning / push protection.
#
# Requires: `gh` authenticated as a repository administrator. A denied call is
# reported as "not verified" (exit 2 in --check), never as "disabled" or "absent".

set -uo pipefail

REPO=${REPO:-nicolas-found42/assembly-agent}
MODE=dry-run
for arg in "$@"; do
  case "$arg" in
    --apply) MODE=apply ;;
    --check) MODE=check ;;
    -h | --help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

command -v gh >/dev/null || { echo "gh is required" >&2; exit 2; }
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated" >&2; exit 2; }

drift=0
denied=0
apply() { # apply <description> <command...>
  local what=$1
  shift
  if [ "$MODE" = apply ]; then
    if "$@" >/dev/null 2>&1; then
      echo "  APPLIED  $what"
    else
      echo "  FAILED   $what (command: $*)"
      drift=1
    fi
  else
    echo "  WOULD    $what"
    drift=1
  fi
}
ok() { echo "  ok       $1"; }

echo "settings for $REPO (mode: $MODE)"

# ── 1. Actions: allowlist + require full-length SHA pins ────────────────
if perms=$(gh api "repos/$REPO/actions/permissions" 2>/dev/null); then
  enabled=$(jq -r '.enabled' <<<"$perms")
  allowed=$(jq -r '.allowed_actions' <<<"$perms")
  sha=$(jq -r '.sha_pinning_required' <<<"$perms")
  echo "actions: enabled=$enabled allowed_actions=$allowed sha_pinning_required=$sha"
  if [ "$enabled" != true ]; then
    echo "  WARN     GitHub Actions are disabled; every workflow in this repository is inert."
    drift=1
  fi
  if [ "$sha" != true ]; then
    # Every external `uses:` in .github/workflows is a full 40-hex commit SHA; the
    # platform policy makes that auditable instead of conventional. Local `./` refs
    # and reusable workflows in this repository are unaffected.
    apply "require full-length commit SHA for every action" \
      gh api -X PUT "repos/$REPO/actions/permissions" \
      -F enabled=true -f allowed_actions="$allowed" -F sha_pinning_required=true
  else
    ok "action pinning is enforced by the platform"
  fi
else
  echo "  UNVERIFIED  could not read actions permissions (insufficient scope?)"
  denied=1
fi

# ── 2. Default GITHUB_TOKEN scope for workflows ─────────────────────────
if wf=$(gh api "repos/$REPO/actions/permissions/workflow" 2>/dev/null); then
  scope=$(jq -r '.default_workflow_permissions' <<<"$wf")
  echo "workflow default token: $scope"
  if [ "$scope" = read ]; then
    ok "default token is read-only"
  else
    apply "set the default workflow token to read-only" \
      gh api -X PUT "repos/$REPO/actions/permissions/workflow" \
      -f default_workflow_permissions=read
  fi
else
  echo "  UNVERIFIED  could not read workflow permissions"
  denied=1
fi

# ── 3. Dependabot security updates (R03: retain security updates) ───────
if alerts=$(gh api "repos/$REPO" --jq '.security_and_analysis.dependabot_security_updates.status' 2>/dev/null); then
  echo "dependabot security updates: $alerts"
  if [ "$alerts" = enabled ]; then
    ok "Dependabot security updates are on"
  else
    apply "enable Dependabot security updates" \
      gh api -X PUT "repos/$REPO/automated-security-fixes"
  fi
else
  echo "  UNVERIFIED  could not read dependabot security update state"
  denied=1
fi

# ── 4. Code scanning: exactly one publisher ─────────────────────────────
# This repository runs CodeQL through .github/workflows/codeql.yml ("advanced
# setup"). GitHub's account-level default setup must stay unconfigured, or the
# same commit is published twice under one analysis category and findings are
# reported twice.
if setup=$(gh api "repos/$REPO/code-scanning/default-setup" 2>/dev/null); then
  state=$(jq -r '.state' <<<"$setup")
  echo "code scanning default setup: $state"
  if [ "$state" = configured ]; then
    echo "  WARN     default setup is configured while .github/workflows/codeql.yml is the intended publisher."
    echo "           Disable default setup in Settings → Code security, or delete the workflow — not both."
    drift=1
  else
    ok "single CodeQL publisher (codeql.yml)"
  fi
else
  echo "  UNVERIFIED  could not read code-scanning default setup"
  denied=1
fi

# ── 5. Verify-only: secret scanning, push protection, branch policy ─────
repo_json=$(gh api "repos/$REPO" 2>/dev/null || true)
if [ -n "$repo_json" ]; then
  for feature in secret_scanning secret_scanning_push_protection; do
    status=$(jq -r --arg f "$feature" '.security_and_analysis[$f].status // "unavailable"' <<<"$repo_json")
    echo "$feature: $status"
    if [ "$status" != enabled ]; then
      echo "  WARN     $feature is not enabled. Enabling it is an owner action in repository settings"
      echo "           (Settings → Code security); the API refuses it for features a plan does not cover."
      drift=1
    fi
  done
fi

prot=$(gh api "repos/$REPO/branches/main/protection" 2>/dev/null || true)
if [ -n "$prot" ]; then
  contexts=$(jq -r '.required_status_checks.contexts | join(",")' <<<"$prot")
  echo "required status checks on main: ${contexts:-<none>}"
  case ",$contexts," in
    *,build-and-test,*) ok "required context 'build-and-test' is present" ;;
    *)
      echo "  WARN     the required context 'build-and-test' is missing. Required verification would be"
      echo "           unenforced. Fix branch protection deliberately (Settings → Branches); this script"
      echo "           does not edit it."
      drift=1
      ;;
  esac
else
  echo "  UNVERIFIED  could not read branch protection for main"
  denied=1
fi

envs=$(gh api "repos/$REPO/environments" --jq '[.environments[].name] | join(",")' 2>/dev/null || true)
if [ -n "$envs" ]; then
  echo "environments: $envs"
  case ",$envs," in
    *,github-pages,*) ok "protected environment 'github-pages' exists" ;;
    *) echo "  WARN     environment 'github-pages' is missing; Pages publication is unprotected."; drift=1 ;;
  esac
  # Existence is not the property that matters: the deploy job's `if:` guard is the
  # first line of defence and this branch policy is the second. Read it.
  if pages_policies=$(gh api "repos/$REPO/environments/github-pages/deployment-branch-policies" \
    --jq '[.branch_policies[] | select(.type == "branch") | .name] | join(",")' 2>/dev/null); then
    case ",$pages_policies," in
      ,main,) ok "github-pages allows only the 'main' branch" ;;
      *)
        echo "  WARN     github-pages branch policies are '${pages_policies:-<none>}'; expected exactly 'main'."
        echo "           A wider policy would let another ref publish through the environment."
        drift=1
        ;;
    esac
  else
    echo "  UNVERIFIED  could not read the github-pages branch policies"
    denied=1
  fi
  case ",$envs," in
    *,cloudflare-worker,*)
      ok "protected environment 'cloudflare-worker' exists"
      # The environment is the approval gate; it is inert until the credentials and
      # the opt-in variable exist. Report each one by name — never a value.
      if cf_secrets=$(gh api "repos/$REPO/environments/cloudflare-worker/secrets" \
        --jq '[.secrets[].name] | join(",")' 2>/dev/null); then
        for secret in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
          case ",$cf_secrets," in
            *",$secret,"*) ;;
            *) echo "  PENDING  environment secret $secret is not set on cloudflare-worker" ;;
          esac
        done
      else
        echo "  UNVERIFIED  could not read the cloudflare-worker secrets"
        denied=1
      fi
      if cf_var=$(gh api "repos/$REPO/actions/variables" \
        --jq '[.variables[] | select(.name == "ENABLE_WORKER_DEPLOY") | .value] | join(",")' 2>/dev/null); then
        case "$cf_var" in
          true | 1) ok "ENABLE_WORKER_DEPLOY is set: Worker deployment is armed" ;;
          *) echo "  PENDING  repository variable ENABLE_WORKER_DEPLOY is not 'true': worker-deploy.yml stays disabled" ;;
        esac
      else
        echo "  UNVERIFIED  could not read repository variables"
        denied=1
      fi
      ;;
    *)
      echo "  PENDING  environment 'cloudflare-worker' does not exist. Worker deployment"
      echo "           (.github/workflows/worker-deploy.yml) stays disabled until an owner creates it"
      echo "           with required reviewers and the CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID secrets."
      ;;
  esac
else
  echo "  UNVERIFIED  could not read environments"
  denied=1
fi

echo
if [ "$MODE" = apply ]; then
  [ "$drift" = 0 ] && echo "SETTINGS OK (all managed settings already correct)" || echo "SETTINGS APPLIED WITH ERRORS"
  exit "$drift"
fi

if [ "$drift" = 0 ]; then
  echo "SETTINGS OK (no drift; no changes needed)"
  exit 0
fi

if [ "$MODE" = check ]; then
  echo "SETTINGS DRIFT (run with --apply to change the managed settings)"
  exit 1
fi

echo "SETTINGS DRY RUN — nothing changed. Re-run with --apply to change the items marked WOULD."
[ "$denied" = 0 ] || exit 2
exit 0
