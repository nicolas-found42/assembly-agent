#!/usr/bin/env node
/**
 * scripts/workflow-invariants.mjs — executable checks for the workflow invariants a
 * static parse can actually prove (campaign R08.1, run by the required lint gate).
 *
 * PROVEN STATICALLY (these exit nonzero when violated):
 *   1. uses-pinned            every external `uses:` is a full 40-hex commit SHA with a
 *                             readable version comment on the same line (job- and step-level).
 *   2. job-timeout            every job declares a positive `timeout-minutes`.
 *   3. permissions-declared   the workflow declares permissions and they are read-only;
 *                             any `: write` lives on the specific job that needs it.
 *   4. privileged-scope       `pages: write` / `id-token: write` / `issues: write` are job-level
 *                             and only in an environment job or a workflow PRs cannot reach.
 *   5. publication-gate       every `environment:` job declares a named environment and is gated to
 *                             `refs/heads/main`: either the workflow pushes to main, or it has no
 *                             push trigger at all and the job's `if:` pins `refs/heads/main`
 *                             (manual-only publisher). A pull_request trigger may reach such a job
 *                             only when the `if:` provably excludes PR events as well.
 *   6. no-prod-secrets-in-pr  no `secrets.*` reference (other than the per-run GITHUB_TOKEN)
 *                             appears in a workflow reachable from pull_request / merge_group /
 *                             workflow_run — which is also the Dependabot path.
 *   7. required-context       exactly one job reports the required check context
  *                             `build-and-test` (job id, no `name:` override), the required
  *                             workflow has no workflow-level `paths`/`paths-ignore` filter,
  *                             and the job itself is unconditional — a skipped required job
  *                             still reports success.
 *   8. concurrency            the required job's effective concurrency is PR-scoped and cancels
 *                             superseded PR runs; a publishing job's effective concurrency can
 *                             never cancel an active publish, and no workflow-level
 *                             `cancel-in-progress: true` covers a publishing job.
 *   9. no-continue-on-error   the workflow reporting the required check never uses
 *                             `continue-on-error`.
  *  10. pages-publication      a job that publishes with `actions/deploy-pages` never checks out
  *                             the repository and never runs a build/install command (the
  *                             verified artifact is its only input), and the publish step is
  *                             gated on a freshness decision computed in that same job: a step
  *                             writing both `fresh=true` and `fresh=false` to $GITHUB_OUTPUT,
  *                             which `actions/deploy-pages` must require.
  *  11. no-snapshot-autorefresh no workflow `run:` block passes Playwright's snapshot-update
  *                             flag (long or short form), and the browser config never sets
  *                             `updateSnapshots` to anything but an explicit 'missing' — CI must
  *                             never accept the baselines it compares against.
 *
 * NOT PROVEN HERE — a PASS is not evidence for any of these, they need a real run:
  *   GitHub event scheduling and trigger evaluation (GitHub's own expression engine, not the
  *   local evaluator in test/ci-guards.test.mjs); runtime enforcement of the `permissions`
 *   block; environment protection rules and deployment-branch policies (repo settings, see
 *   .scratch/ci/research/pins.md §9); artifact identity/immutability and digests; secret
 *   availability and scoping for forks/Dependabot; the behaviour of action code; and whether a
  *   required check actually gates a merge. The freshness step's no-op and fail-closed
  *   behaviour under a chosen tip is executed by test/ci-guards.test.mjs, not proven here.
 *
 * Usage: node scripts/workflow-invariants.mjs [--workflows <dir>] [--help]
 *   --workflows <dir>  directory of workflow files (default .github/workflows); the negative
 *                      tests point this at a throwaway fixture directory.
 * Exit 0 and a final `WORKFLOW INVARIANTS PASS` line only when every check passes.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Frozen contract values (see local://ci-contracts.md; never derived from the files).
const REQUIRED_CONTEXT = 'build-and-test';
const PR_EVENTS = ['pull_request', 'pull_request_target'];
// Events that put untrusted code/refs in front of a job without a human gate.
const UNTRUSTED_EVENTS = [...PR_EVENTS, 'merge_group', 'workflow_run'];
const PRIVILEGED_JOB_PERMISSIONS = ['pages: write', 'id-token: write', 'issues: write'];
const READ_ONLY_LEVELS = ['read', 'none'];
// Ref-independent triggers: a run started by these can be any ref unless the job guards it.
const REF_INDEPENDENT_EVENTS = ['workflow_dispatch', 'repository_dispatch', 'workflow_call'];
// `secrets.GITHUB_TOKEN` is minted per run and scoped by the workflow's own `permissions`
// declaration, so it is not a stored production credential: the one allowed name. Anything
// else must be added here deliberately, with a written trust argument.
const ALLOWED_SECRETS = new Map([
  ['GITHUB_TOKEN', 'per-run token minted by the runner, scoped by the workflow permissions block'],
]);
const SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_COMMENT_RE = /#\s*v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.]+)?\s*$/;

function usage(code = 0) {
  const out = code === 0 ? console.log : console.error;
  out(`usage: node scripts/workflow-invariants.mjs [--workflows <dir>]

options:
  --workflows <dir>  directory holding the workflow YAML files (default .github/workflows)
  --help             show this text`);
  process.exit(code);
}

const args = { workflows: path.join(ROOT, '.github/workflows') };
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === '--workflows') {
    const value = process.argv[i + 1];
    if (value === undefined) usage(2);
    args.workflows = path.resolve(process.cwd(), value);
    i += 1;
  } else if (arg === '--help' || arg === '-h') usage(0);
  else usage(2);
}

// ------------------------------------------------------------------ load workflows
if (!statSync(args.workflows, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`WORKFLOW INVARIANTS FAIL — not a directory: ${args.workflows}`);
  process.exit(1);
}
const files = readdirSync(args.workflows)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();
if (files.length === 0) {
  // An empty directory would make every check vacuously pass; that is never the intent.
  console.error(`WORKFLOW INVARIANTS FAIL — no workflow files (*.yml) in ${args.workflows}`);
  process.exit(1);
}

const workflows = [];
const parseFailures = [];
for (const file of files) {
  const full = path.join(args.workflows, file);
  const text = readFileSync(full, 'utf8');
  try {
    const doc = parseYaml(text) ?? {};
    // The `yaml` package is already a devDependency; YAML 1.2 keeps `on` a string, and the
    // `doc['true']` fallback covers a parser that resolves it as the boolean key.
    const on = doc.on ?? doc['true'] ?? null;
    workflows.push({
      file,
      text,
      lines: text.split('\n'),
      doc,
      on,
      events: eventNames(on),
      jobs: Object.entries(doc.jobs ?? {}).map(([id, job]) => ({ id, job: job ?? {} })),
    });
  } catch (err) {
    parseFailures.push(`${file}: ${String(err.message).split('\n')[0]}`);
  }
}

function eventNames(on) {
  if (on == null) return [];
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  return Object.keys(on);
}

const asString = (v) => (v === null || v === undefined ? '' : String(v));

// ------------------------------------------------------------------ collection
const problems = [];
const notes = [];
const addProblem = (check, msg) => problems.push({ check, msg });
const addNote = (check, msg) => notes.push({ check, msg });

// ------------------------------------------------------------------ 1. uses-pinned
{
  const id = 'uses-pinned';
  let external = 0;
  for (const wf of workflows) {
    wf.lines.forEach((line, idx) => {
      const m = /^\s*(?:-\s*)?uses:\s*(.*)$/.exec(line);
      if (!m) return;
      const raw = m[1].trim();
      if (raw === '' || raw.startsWith('#')) return;
      const hashAt = raw.indexOf('#');
      const comment = hashAt === -1 ? '' : raw.slice(hashAt).trim();
      const value = (hashAt === -1 ? raw : raw.slice(0, hashAt)).trim().replace(/^["']|["']$/g, '');
      const where = `${wf.file}:${idx + 1}`;
      if (value.startsWith('./') || value.startsWith('docker://')) return;
      external += 1;
      const at = value.lastIndexOf('@');
      if (at === -1) {
        addProblem(id, `${where}  external uses '${value}' has no @<ref> — pin a full 40-hex commit SHA`);
        return;
      }
      const ref = value.slice(at + 1);
      const repo = value.slice(0, at);
      if (!SHA_RE.test(ref)) {
        const kind = /^[0-9a-f]{7,39}$/i.test(ref) ? 'abbreviated SHA' : 'movable ref';
        addProblem(id, `${where}  '${repo}@${ref}' is a ${kind}; pin the full 40-hex commit SHA`);
      } else if (!VERSION_COMMENT_RE.test(comment)) {
        addProblem(id, `${where}  '${repo}@${ref}' has no readable version comment (expected e.g. '# v7.0.1')`);
      }
    });
  }
  addNote(id, `${external} external action reference(s) checked`);
}

// ------------------------------------------------- 2-6, 9: per workflow and job
for (const wf of workflows) {
  const events = wf.events;
  const prReachable = events.some((e) => PR_EVENTS.includes(e));
  const untrustedReachable = events.some((e) => UNTRUSTED_EVENTS.includes(e));

  // 2. job-timeout
  for (const { id: jobId, job } of wf.jobs) {
    const where = `${wf.file}  job '${jobId}'`;
    if (job.uses !== undefined) {
      addProblem('job-timeout', `${where}  a reusable-workflow job cannot declare timeout-minutes; this repository does not use that form — restructure instead of dropping the bound`);
      continue;
    }
    const t = job['timeout-minutes'];
    if (!Number.isInteger(t) || t <= 0) {
      addProblem('job-timeout', `${where}  missing or invalid timeout-minutes (${JSON.stringify(t ?? null)}); every job needs a positive integer`);
    }
  }

  // 3. permissions-declared (workflow level read-only default)
  const perms = wf.doc.permissions;
  if (perms === undefined || perms === null) {
    addProblem('permissions-declared', `${wf.file}  no top-level \`permissions:\` — declare the read-only default explicitly`);
  } else if (typeof perms === 'string') {
    if (perms !== 'read-all') {
      addProblem('permissions-declared', `${wf.file}  workflow-level permissions '${perms}' is not read-only; declare per-permission reads`);
    }
  } else if (typeof perms === 'object') {
    for (const [key, value] of Object.entries(perms)) {
      if (value === 'write' || value === 'write-all') {
        addProblem('permissions-declared', `${wf.file}  workflow-level '${key}: write' grants the permission to every job; move it to the job that needs it`);
      } else if (!READ_ONLY_LEVELS.includes(asString(value))) {
        addProblem('permissions-declared', `${wf.file}  workflow-level '${key}: ${asString(value)}' is not one of read/none`);
      }
    }
  }

  for (const { id: jobId, job } of wf.jobs) {
    if (job.permissions === undefined) continue;
    const where = `${wf.file}  job '${jobId}'`;
    if (typeof job.permissions === 'string') {
      if (job.permissions !== 'read-all') addProblem('permissions-declared', `${where}  permissions '${job.permissions}' is not read-only`);
      continue;
    }
    if (typeof job.permissions !== 'object') continue;
    for (const [key, value] of Object.entries(job.permissions)) {
      // 4. privileged-scope
      if (!PRIVILEGED_JOB_PERMISSIONS.includes(`${key}: ${asString(value)}`)) continue;
      if (job.environment !== undefined) {
        addNote('privileged-scope', `${where}  '${key}: write' allowed: environment-gated job`);
      } else if (!prReachable) {
        addNote('privileged-scope', `${where}  '${key}: write' allowed: workflow is not reachable from pull_request`);
      } else {
        addProblem('privileged-scope', `${where}  grants '${key}: write' but the workflow is reachable from pull_request and the job declares no environment`);
      }
    }
  }

  // 5. publication-gate
  const pushBranches = (() => {
    if (!events.includes('push')) return [];
    const push = typeof wf.on === 'object' && !Array.isArray(wf.on) ? wf.on?.push : null;
    if (push == null) return null; // push with no branch filter = every branch
    if (push.branches === undefined) return null;
    return Array.isArray(push.branches) ? push.branches.map(String) : [String(push.branches)];
  })();
  const refIndependent = REF_INDEPENDENT_EVENTS.some((e) => events.includes(e))
    || (pushBranches !== null && pushBranches.some((b) => b !== 'main'));
  const guard = (job) => asString(job.if);
  // An `if:` that provably keeps a run away from pull_request events.
  const guardExcludesPr = (g) => {
    if (g === '') return false;
    const neq = /github\.event_name\s*!=\s*['"]([A-Za-z_]+)['"]/.exec(g);
    if (neq && PR_EVENTS.includes(neq[1])) return true;
    const eq = /github\.event_name\s*==\s*['"]([A-Za-z_]+)['"]/.exec(g);
    if (eq && !PR_EVENTS.includes(eq[1])) return true;
    return false;
  };

  for (const { id: jobId, job } of wf.jobs) {
    if (job.environment === undefined) continue;
    const envName = typeof job.environment === 'string' ? job.environment : asString(job.environment?.name);
    const where = `${wf.file}  job '${jobId}' (environment '${envName || 'unnamed'}')`;
    const g = guard(job);
    if (!envName) addProblem('publication-gate', `${where}  the environment block has no name; protection rules attach to a named environment`);
    if (prReachable) {
      if (guardExcludesPr(g) && /refs\/heads\/main/.test(g)) {
        addNote('publication-gate', `${where}  PR trigger present but the job is guarded: if: ${g.trim()}`);
      } else {
        addProblem('publication-gate', `${where}  a pull_request trigger can reach this publishing workflow and the job guard '${g.trim() || '(none)'}' does not prove it stays on push-to-main (need github.event_name excluding PR events AND refs/heads/main)`);
      }
    }
    // Two accepted trigger shapes for a publication job: an automatic push-to-main workflow,
    // or a workflow with no push trigger at all whose job proves the ref itself (manual
    // dispatch, e.g. a publisher that stays opt-in until its environment is configured).
    const pushToMain = events.includes('push') && pushBranches !== null && pushBranches.includes('main');
    const manualOnlyWithRefGuard = !events.includes('push') && /refs\/heads\/main/.test(g);
    if (!pushToMain && !manualOnlyWithRefGuard) {
      addProblem('publication-gate', `${where}  publication must be gated to refs/heads/main: either the workflow pushes to main, or (no push trigger at all and) the job's if: pins refs/heads/main (events: ${events.join(', ') || 'none'}; guard: '${g.trim() || '(none)'}')`);
    } else if (!pushToMain) {
      addNote('publication-gate', `${where}  manual-only publication (${events.join(', ')}) with a refs/heads/main guard`);
    }
    if (refIndependent && !/refs\/heads\/main/.test(g)) {
      addProblem('publication-gate', `${where}  the workflow also runs on a manually chosen or non-main ref but the job has no \`if:\` guard on refs/heads/main`);
    } else if (!prReachable && !pushToMain && /refs\/heads\/main/.test(g)) {
      addNote('publication-gate', `${where}  ref guard: ${g.trim()}`);
    }
  }

  // 6. no-prod-secrets-in-pr
  if (untrustedReachable) {
    const reach = events.filter((e) => UNTRUSTED_EVENTS.includes(e)).join('/');
    const seen = new Set();
    wf.lines.forEach((line, idx) => {
      for (const m of line.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const name = m[1];
        if (seen.has(name)) continue;
        seen.add(name);
        if (ALLOWED_SECRETS.has(name)) {
          addNote('no-prod-secrets-in-pr', `${wf.file}:${idx + 1}  secrets.${name} allowed (${ALLOWED_SECRETS.get(name)})`);
        } else {
          addProblem('no-prod-secrets-in-pr', `${wf.file}:${idx + 1}  secrets.${name} is referenced in a workflow reachable from ${reach} (this includes Dependabot PRs)`);
        }
      }
    });
  }
}

// --------------------------------------------------- 7-9: the required workflow
const contexts = [];
for (const wf of workflows) {
  for (const { id: jobId, job } of wf.jobs) {
    contexts.push({ wf, jobId, job, context: job.name === undefined ? jobId : asString(job.name) });
  }
}
const matching = contexts.filter((c) => c.context === REQUIRED_CONTEXT);
if (matching.length === 0) {
  const renamed = contexts.find((c) => c.jobId === REQUIRED_CONTEXT);
  if (renamed) {
    addProblem('required-context', `${renamed.wf.file}  job id '${REQUIRED_CONTEXT}' exists but \`name: ${renamed.context}\` renames the check context; the repository requires exactly '${REQUIRED_CONTEXT}'`);
  } else {
    addProblem('required-context', `no job reports the required check context '${REQUIRED_CONTEXT}' (job id, no name override)`);
  }
} else if (matching.length > 1) {
  for (const c of matching) {
    addProblem('required-context', `${c.wf.file}  job '${c.jobId}'  duplicate check context '${REQUIRED_CONTEXT}' — ambiguous required status blocks PRs, make job names unique`);
  }
} else {
  addNote('required-context', `${matching[0].wf.file}  job '${matching[0].jobId}' reports '${REQUIRED_CONTEXT}'`);
}
const requiredJob = matching[0] ?? null;

// 7b. no workflow-level paths filter on the required workflow
if (requiredJob) {
  const on = requiredJob.wf.on;
  if (typeof on === 'object' && !Array.isArray(on)) {
    for (const [event, cfg] of Object.entries(on)) {
      if (cfg === null || typeof cfg !== 'object') continue;
      for (const key of ['paths', 'paths-ignore']) {
        if (cfg[key] !== undefined) {
          addProblem('required-context', `${requiredJob.wf.file}  on.${event}.${key}: the required check must run for every change — a filtered-out job still reports success and can merge unchecked code`);
        }
      }
    }
  }
}

// 7c. the required job must be unconditional -------------------------------------
// A condition on the job that reports the required check is a hole in the gate: a
// skipped job reports success, so a run that executes nothing can still satisfy branch
// protection. Whatever a condition should express belongs inside the steps.
if (requiredJob) {
  const g = asString(requiredJob.job.if).trim();
  if (g !== '') {
    addProblem('required-job-ungated', `${requiredJob.wf.file}  job '${requiredJob.jobId}' declares \`if: ${g}\` — a skipped required job still reports success; keep the job unconditional and gate its steps instead`);
  } else {
    addNote('required-job-ungated', `${requiredJob.wf.file}  job '${requiredJob.jobId}' is unconditional`);
  }
}

// 8. concurrency -----------------------------------------------------------------
// "Effective" concurrency is the job's own key when it declares one, otherwise the
// workflow-level key, which applies to every job that does not override it.
function effectiveConcurrency(wf, job) {
  const c = job.concurrency !== undefined ? job.concurrency : wf.doc.concurrency;
  if (c === undefined || c === null) return { group: '', cancel: undefined };
  if (typeof c === 'string') return { group: c, cancel: undefined };
  return { group: asString(c.group), cancel: c['cancel-in-progress'] };
}
// Does this cancel-in-progress value provably cancel a *publishing* run? A publish is
// never a pull_request event, so an expression conditioned on the PR event cannot.
function publishCancel(value) {
  if (value === undefined || value === null || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  const s = asString(value);
  if (/pull_request/.test(s)) return false;
  return 'unknown';
}

if (requiredJob) {
  const { wf, job, jobId } = requiredJob;
  const conc = effectiveConcurrency(wf, job);
  if (!conc.group) {
    addProblem('concurrency', `${wf.file}  job '${jobId}': no concurrency key (workflow- or job-level); superseded PR runs must be cancelled`);
  } else {
    if (!/github\.ref|pull_request\.number|github\.event\.number/.test(conc.group)) {
      addProblem('concurrency', `${wf.file}  job '${jobId}': concurrency group '${conc.group}' is not PR-scoped (expected github.ref or the PR number)`);
    }
    const c = conc.cancel;
    const cancelsPr = c === true || c === 'true' || /pull_request/.test(asString(c));
    if (!cancelsPr) {
      addProblem('concurrency', `${wf.file}  job '${jobId}': concurrency cancel-in-progress ${JSON.stringify(c ?? null)} does not cancel superseded PR runs`);
    } else {
      addNote('concurrency', `${wf.file}  job '${jobId}': group '${conc.group}', cancel-in-progress ${JSON.stringify(c)}`);
    }
  }
}

{
  const requiredGroup = requiredJob ? effectiveConcurrency(requiredJob.wf, requiredJob.job).group : '';
  for (const wf of workflows) {
    for (const { id: jobId, job } of wf.jobs) {
      if (job.environment === undefined) continue;
      const conc = effectiveConcurrency(wf, job);
      const where = `${wf.file}  job '${jobId}'`;
      if (!conc.group) {
        addProblem('concurrency', `${where}  publishing job has no effective concurrency key; parallel publishes into one environment must be serialized`);
        continue;
      }
      const verdict = publishCancel(conc.cancel);
      if (verdict === true) {
        addProblem('concurrency', `${where}  publishing concurrency '${conc.group}' sets cancel-in-progress: ${JSON.stringify(conc.cancel)} — an active deployment must never be cancelled`);
      } else if (verdict === 'unknown') {
        addProblem('concurrency', `${where}  publishing concurrency '${conc.group}' sets cancel-in-progress to '${asString(conc.cancel)}', which is not provably false for a publish`);
      }
      // A workflow-level key only covers the publishing job when the job does not override it,
      // which the verdict above already judged. A workflow-level cancel-in-progress: true next
      // to an overridden deploy job is still worth recording, because it can cancel the
      // in-flight build of a publish run.
      const wfConc = wf.doc.concurrency;
      if (job.concurrency !== undefined && typeof wfConc === 'object' && wfConc !== null
        && (wfConc['cancel-in-progress'] === true || wfConc['cancel-in-progress'] === 'true')) {
        addNote('concurrency', `${where}  note: workflow-level cancel-in-progress is true, but the publishing job overrides it with group '${conc.group}' (a publish in flight is not cancelled)`);
      }
      if (requiredGroup && conc.group === requiredGroup) {
        addProblem('concurrency', `${where}  publishing shares the required job's concurrency group '${conc.group}'; a PR run could block or cancel a publish`);
      }
      const envName = typeof job.environment === 'string' ? job.environment : asString(job.environment?.name);
      const scopeNote = /github\.environment/.test(conc.group) || conc.group === envName
        ? 'per-environment group'
        : `constant group '${conc.group}' (environment '${envName || 'unnamed'}')`;
      addNote('concurrency', `${where}  ${scopeNote}, cancel-in-progress ${JSON.stringify(conc.cancel ?? null)}`);
    }
  }
}

// 9. no-continue-on-error in the workflow reporting the required check ------------
{
  const requiredWf = requiredJob?.wf ?? null;
  const scan = (wf, gating) => {
    wf.lines.forEach((line, idx) => {
      const m = /^\s*(?:-\s*)?continue-on-error:\s*(.*)$/.exec(line);
      if (!m) return;
      const value = m[1].split('#')[0].trim().replace(/^["']|["']$/g, '');
      if (wf === requiredWf && gating) {
        addProblem('no-continue-on-error', `${wf.file}:${idx + 1}  continue-on-error: ${value || '(empty)'} in the workflow that reports the required check '${REQUIRED_CONTEXT}'`);
      } else {
        addNote('no-continue-on-error', `${wf.file}:${idx + 1}  continue-on-error: ${value || '(empty)'} outside the required workflow (an optional job must be excluded by name, not by a blanket rule)`);
      }
    });
  };
  for (const wf of workflows) scan(wf, true);
}

// ---------------------------- 10. the Pages publication path ---------------------
// `actions/deploy-pages` uploads the artifact `build-and-test` produced, so the job
// around it must neither check out the repository nor build anything: a fresh tree or a
// fresh build would publish bytes no test ever saw. The publish step must also be gated
// on a freshness decision computed in that same job — a comment claiming a guard is not
// a guard, and an unconditional publish cannot be superseded safely.
const BUILD_COMMAND_RE = /\bnpm\s+(?:ci|install)\b|\bnpm\s+run\s+(?:build|verify)\b|\bbuild-site\.sh\b|\bnode\s+scripts\/build/;
for (const wf of workflows) {
  for (const { id: jobId, job } of wf.jobs) {
    const where = `${wf.file}  job '${jobId}'`;
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const publishing = steps.filter((s) => /^actions\/deploy-pages@/.test(asString(s?.uses)));
    if (publishing.length === 0) continue;

    steps.forEach((step, i) => {
      const uses = asString(step?.uses);
      const label = `${where}  step ${i + 1} '${asString(step?.name) || uses || '(unnamed)'}'`;
      if (/^actions\/checkout@/.test(uses)) {
        addProblem('publish-no-rebuild', `${label}  checks out the repository inside a publishing job; the published bytes must be the verified artifact, never a fresh tree`);
      }
      const build = BUILD_COMMAND_RE.exec(asString(step?.run));
      if (build) {
        addProblem('publish-no-rebuild', `${label}  runs '${build[0].trim()}' inside a publishing job; nothing may build or install after the artifact was verified`);
      }
    });

    const freshness = steps.find((s) => {
      const run = asString(s?.run);
      return asString(s?.id) !== '' && run.includes('fresh=true') && run.includes('fresh=false');
    });
    const freshnessId = freshness ? asString(freshness.id) : null;
    if (!freshnessId) {
      addProblem('publish-freshness-gate', `${where}  publishes a Pages artifact but no step with an id writes both \`fresh=true\` and \`fresh=false\` to $GITHUB_OUTPUT; whether this run still owns main must be a decision, not an assumption`);
    }
    const requiresFresh = freshnessId ? new RegExp(`\\b${freshnessId}\\.outputs\\.fresh\\s*==\\s*'true'`) : null;
    for (const step of publishing) {
      const g = asString(step.if);
      if (!requiresFresh || !requiresFresh.test(g)) {
        addProblem('publish-freshness-gate', `${where}  step '${asString(step.name)}' publishes with \`if: ${g || '(none)'}\`; it must require ${freshnessId ? `steps.${freshnessId}.outputs.fresh == 'true'` : 'the freshness decision the job computes'}`);
      }
    }
  }
}

// ---------------------------- 11. no snapshot auto-accept ------------------------
// The visual baselines are the evidence that the UI did not change, so a run that can
// rewrite them turns a regression into a fresh baseline. CI must never pass Playwright's
// snapshot-update flag, and the browser config must not enable it by configuration.
// Narrow on purpose: `run:` blocks plus the one config value — no browser is started.
{
  const id = 'no-snapshot-autorefresh';
  const updateFlags = [
    { label: '--update-snapshots', re: /--update-snapshots\b/ },
    { label: "'-u' (--update-snapshots shorthand)", re: /(?:^|[\s"'=])-u(?:[\s"']|$)/m },
  ];
  let runs = 0;
  for (const wf of workflows) {
    for (const { id: jobId, job } of wf.jobs) {
      const steps = Array.isArray(job.steps) ? job.steps : [];
      steps.forEach((step, i) => {
        const text = asString(step?.run);
        if (text === '') return;
        runs += 1;
        for (const { label, re } of updateFlags) {
          if (re.test(text)) {
            addProblem(id, `${wf.file}  job '${jobId}'  step ${i + 1} '${asString(step?.name) || '(unnamed)'}'  run: block contains ${label}; CI must never accept the snapshots it compares against`);
          }
        }
      });
    }
  }

  const configFile = 'test/browser/playwright.config.mjs';
  const configPath = path.join(ROOT, configFile);
  if (!statSync(configPath, { throwIfNoEntry: false })?.isFile()) {
    addProblem(id, `${configFile}  not found; the snapshot policy of the browser suite cannot be checked`);
  } else {
    const declared = /updateSnapshots\s*:\s*([^\n]+)/.exec(readFileSync(configPath, 'utf8'));
    if (declared) {
      const shown = declared[1].split('//')[0].trim();
      const value = shown.replace(/^["']|["']$/g, '');
      if (value !== 'missing') {
        addProblem(id, `${configFile}  updateSnapshots: ${shown} — only an explicit 'missing' is allowed; 'all'/'changed' auto-accept the baselines, and 'none' or a computed value hides the decision from this scan`);
      } else {
        addNote(id, `${configFile}  updateSnapshots: 'missing'`);
      }
    } else {
      addNote(id, `${configFile}  updateSnapshots unset (Playwright writes missing baselines only, never rewrites existing ones)`);
    }
  }
  addNote(id, `${runs} run: block(s) and ${configFile} scanned`);
}

// ------------------------------------------------------------------ report
const checks = [
  ['uses-pinned', 'every external action is a full-SHA pin with a version comment'],
  ['job-timeout', 'every job declares timeout-minutes'],
  ['permissions-declared', 'permissions declared, read-only at workflow level, writes job-scoped'],
  ['privileged-scope', 'pages/id-token/issues write confined to trusted jobs'],
  ['publication-gate', 'publication gated to refs/heads/main and a named environment'],
  ['no-prod-secrets-in-pr', 'no production secret in a pull_request/merge_group/workflow_run path'],
  ['required-context', `required check context is exactly '${REQUIRED_CONTEXT}', with no paths filter`],
  ['required-job-ungated', 'the required check is reported by an unconditional job'],
  ['concurrency', 'PR runs cancel superseded runs; publishing is never cancelled'],
  ['no-continue-on-error', 'no continue-on-error where the required check is reported'],
  ['publish-no-rebuild', 'a Pages publication never checks out or rebuilds the verified artifact'],
  ['publish-freshness-gate', 'a Pages publication is gated on the freshness decision its own job computes'],
  ['no-snapshot-autorefresh', 'no run: block and no browser config can accept Playwright snapshots'],
];

console.log(`WORKFLOW INVARIANTS — ${files.length} workflow file(s), ${contexts.length} job(s), dir ${path.relative(process.cwd(), args.workflows) || args.workflows}`);
console.log(`  files: ${files.join(', ')}`);

let passed = 0;
const report = [];
for (const [id, title] of checks) {
  const own = problems.filter((p) => p.check === id);
  const ok = own.length === 0;
  if (ok) passed += 1;
  report.push(`  ${ok ? 'PASS' : 'FAIL'}  ${id} — ${title}`);
  for (const p of own) report.push(`        ${p.msg}`);
  for (const n of notes.filter((x) => x.check === id)) report.push(`        note: ${n.msg}`);
}
console.log(report.join('\n'));

if (parseFailures.length > 0) {
  console.log('  FAIL  parse — workflow YAML could not be read');
  for (const f of parseFailures) console.log(`        ${f}`);
}

console.log(`
  PROVEN STATICALLY: pins, job timeouts, permission shape, publication trigger/ref gating,
    secret references, the required check context and its unconditional job, the Pages publish
    path (no checkout, no rebuild, gated on the freshness decision the job computes), concurrency
    keys, continue-on-error, and the absence of any snapshot auto-accept flag or config value —
  read from these files only.
    NOT PROVEN (needs a real run): event scheduling and trigger evaluation (GitHub's expression
    engine, not the evaluator in test/ci-guards.test.mjs), runtime permission enforcement,
    environment protection rules, artifact identity/immutability, secret availability for forks
    and Dependabot, action behaviour, and whether the required check actually blocks a merge.`);

const okAll = problems.length === 0 && parseFailures.length === 0;
console.log(`\nWORKFLOW INVARIANTS ${okAll ? 'PASS' : 'FAIL'} (${passed}/${checks.length} checks, ${problems.length} finding(s)${parseFailures.length ? `, ${parseFailures.length} parse failure(s)` : ''})`);
process.exit(okAll ? 0 : 1);
