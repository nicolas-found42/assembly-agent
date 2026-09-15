// ci-guards.test.mjs — durable negative proofs for the CI guards themselves.
//
// The campaign proved these guards with one-off drills recorded under
// .scratch/ci/evidence/, which is gitignored: nothing in the repository failed if a
// guard regressed afterwards. Every case below drives the real guard, so deleting or
// weakening one makes the matching test fail instead of passing silently.
//
// Covered
//   scripts/validate-manifest.mjs  an unclassified runnable file (rejected and named),
//                                  a duplicate entry, a path that does not exist
//   scripts/run-tests.mjs          the zero-test guard, an unexpected runtime skip, an
//                                  accidental focus modifier (rejected before execution),
//                                  a retry-only pass, a missing file — each driven by a
//                                  fixture manifest under test/fixtures/manifests/
//   .github/workflows/ci.yml       the deploy job's `if:` over every context that can
//                                  reach it (same-repo/fork/Dependabot PR, push to main
//                                  and to a feature branch, workflow_dispatch on a
//                                  feature ref and on main), the Freshness gate's real
//                                  shell logic under a stubbed curl, and the required job
//                                  (no `if:`, frozen gate command)
//
// Deterministic and offline: temp dirs only, no network, and the class runner's JSON is
// written to a temp dir — never artifacts/results/, which is the campaign's evidence chain.
//
// Maintainer note: this file is itself a required-class member, so the runner's source
// scan applies to it — the forbidden modifiers cannot appear literally below, which is
// why the needles are composed rather than written out.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = path.join(ROOT, 'test/manifest.json');
const FIXTURES = path.join(ROOT, 'test/fixtures/manifests');
// Negative-test seam for the workflow cases: point the same assertions at a mutated
// copy of ci.yml without ever touching the real file (the same idea as the runner's
// --manifest and the invariants script's --workflows).
const CI_YML = process.env.CI_GUARDS_CI_YML ?? path.join(ROOT, '.github/workflows/ci.yml');

// Composed so this file never contains the literal the runner's source scan rejects.
const FOCUS_NEEDLE = `.on${'ly('}`;

const CANDIDATE = 'c0'.repeat(20);
const OTHER_TIP = 'd1'.repeat(20);

function runNode(args) {
 return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
}

/**
 * The class runner spawns `node --test` itself, and Node marks test-file children with
 * NODE_TEST_CONTEXT. Inherited (this file runs under `node --test` too) it switches the
 * fixture process to the child reporter protocol and the runner then finds no summary to
 * parse. A real invocation — `npm run test:offline` — carries neither variable.
 */
function childEnv() {
 const env = { ...process.env };
 delete env.NODE_TEST_CONTEXT;
 delete env.NODE_TEST_WORKER_ID;
 return env;
}

function withTempDir(label, fn) {
 const dir = mkdtempSync(path.join(tmpdir(), `ci-guards-${label}-`));
 try {
  return fn(dir);
 } finally {
  rmSync(dir, { recursive: true, force: true });
 }
}

function readJson(file) {
 return JSON.parse(readFileSync(file, 'utf8'));
}

/** Run the class runner over a fixture manifest; its JSON output stays in a temp dir. */
function runFixtureClass(label, manifestName) {
 return withTempDir(label, (dir) => {
  const json = path.join(dir, 'results.json');
  const res = spawnSync(process.execPath, [
   'scripts/run-tests.mjs',
   '--class', 'offline',
   '--manifest', path.join(FIXTURES, manifestName),
   '--json', json,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: childEnv() });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  assert.ok(existsSync(json), `the runner wrote no results JSON for ${manifestName}:\n${output}`);
  const payload = readJson(json);
  assert.equal(payload.entries.length, 1, `expected exactly one entry in ${manifestName}`);
  return { res, output, entry: payload.entries[0] };
 });
}

// ── validate-manifest ────────────────────────────────────────────────────────

test('validate-manifest: an unclassified runnable file is rejected and named', () => {
 // `--manifest` validates an alternate manifest but discovery always sweeps the real
 // test/ tree, so the only way to exercise it is a real unlisted module: unique name,
 // removed in finally.
 const name = `zz-ci-guards-${process.pid}.mjs`;
 const abs = path.join(ROOT, 'test', name);
 try {
  writeFileSync(abs, "console.log('ALL CI-GUARDS-DUMMY PASS');\n");
  const res = runNode(['scripts/validate-manifest.mjs']);
  assert.equal(res.status, 1, `expected the sweep to fail:\n${res.stdout}${res.stderr}`);
  assert.ok(
   res.stderr.includes(`test/${name}: unclassified runnable test file`),
   `the failure must name the unclassified file:\n${res.stderr}`,
  );
 } finally {
  rmSync(abs, { force: true });
 }
});

test('validate-manifest: a duplicate entry is rejected', () => {
 const manifest = readJson(MANIFEST);
 const first = manifest.entries[0];
 withTempDir('duplicate', (dir) => {
  const dup = path.join(dir, 'manifest.json');
  writeFileSync(dup, `${JSON.stringify({ ...manifest, entries: [first, { ...first }, ...manifest.entries.slice(1)] }, null, 2)}\n`);
  const res = runNode(['scripts/validate-manifest.mjs', '--manifest', dup]);
  assert.equal(res.status, 1, `expected a duplicate to fail:\n${res.stdout}${res.stderr}`);
  assert.ok(
   res.stderr.includes(`${first.path}: duplicate manifest entry`),
   `the failure must name the duplicated path:\n${res.stderr}`,
  );
 });
});

test('validate-manifest: a path that does not exist is rejected', () => {
 withTempDir('nonexistent', (dir) => {
  const manifest = readJson(MANIFEST);
  const missing = path.join(dir, 'manifest.json');
  const entry = { path: 'test/fixtures/manifests/does-not-exist.mjs', kind: 'test', class: 'offline', run: 'node-test' };
  writeFileSync(missing, `${JSON.stringify({ ...manifest, entries: [...manifest.entries, entry] }, null, 2)}\n`);
  const res = runNode(['scripts/validate-manifest.mjs', '--manifest', missing]);
  assert.equal(res.status, 1, `expected a nonexistent path to fail:\n${res.stdout}${res.stderr}`);
  assert.ok(
   res.stderr.includes(`${entry.path}: path does not exist`),
   `the failure must name the missing path:\n${res.stderr}`,
  );
 });
});

// ── run-tests.mjs ────────────────────────────────────────────────────────────

test('run-tests: a suite with no test or assertion fails the zero-test guard', () => {
 const { res, output, entry } = runFixtureClass('zero-test', 'zero-test.json');
 assert.equal(res.status, 1, `expected the zero-test guard to fail the run:\n${output}`);
 assert.equal(entry.ok, false);
 assert.match(entry.reason, /zero-test guard: .* declares no test or assertion construct/);
});

test('run-tests: an accidental focus modifier is rejected before execution', () => {
 // The fixture writes a marker next to the OS temp dir the moment it is loaded; the
 // scan runs first, so the marker must never appear.
 const marker = path.join(tmpdir(), 'ci-guards-only-fixture.marker');
 rmSync(marker, { force: true });
 try {
  const { res, output, entry } = runFixtureClass('only', 'only.json');
  assert.equal(res.status, 1, `expected the source scan to fail the run:\n${output}`);
  assert.equal(entry.ok, false);
  assert.ok(entry.reason.startsWith('source scan rejected the file:'), entry.reason);
  assert.ok(entry.reason.includes(`contains ${FOCUS_NEEDLE}`), entry.reason);
  assert.equal(existsSync(marker), false, 'the fixture was executed — the scan must reject it first');
 } finally {
  rmSync(marker, { force: true });
 }
});

test('run-tests: an unexpected runtime skip is rejected', () => {
 const { res, output, entry } = runFixtureClass('runtime-skip', 'runtime-skip.json');
 assert.equal(res.status, 1, `expected the skip to fail the run:\n${output}`);
 assert.equal(entry.skipped, 1, 'the fixture skipped one test: the summary, not the text scan, is the guard');
 assert.match(entry.reason, /unexpected skip\/todo \(skipped=1, todo=0\)/);
});

test('run-tests: a retry-only pass is rejected', () => {
 const { res, output, entry } = runFixtureClass('retry', 'retry.json');
 assert.equal(res.status, 1, `expected the retry guard to fail the run:\n${output}`);
 assert.equal(entry.exit, 0, 'the fixture exits 0 with a valid marker — only the retry report fails it');
 assert.match(entry.reason, /retry-only success is not accepted/);
});

test('run-tests: a manifest entry whose file is missing is rejected', () => {
 const { res, output, entry } = runFixtureClass('missing-path', 'missing-path.json');
 assert.equal(res.status, 1, `expected a missing file to fail the run:\n${output}`);
 assert.match(entry.reason, /^missing file test\/fixtures\/manifests\/does-not-exist\.mjs/);
});

// ── .github/workflows/ci.yml ─────────────────────────────────────────────────

const CI = parseYaml(readFileSync(CI_YML, 'utf8'));

function tokenizeIf(expr) {
 const tokens = [];
 const re = /\s*(github\.event_name|github\.ref|'[^']*'|==|!=|&&|\|\||!|\(|\))/g;
 let last = 0;
 let m;
 while ((m = re.exec(expr)) !== null) {
  if (m.index !== last) {
   throw new Error(`if: unsupported syntax at ${JSON.stringify(expr.slice(last, m.index + 1))} in ${JSON.stringify(expr)}`);
  }
  tokens.push(m[1]);
  last = re.lastIndex;
 }
 if (expr.slice(last).trim() !== '') {
  throw new Error(`if: unsupported syntax at ${JSON.stringify(expr.slice(last))} in ${JSON.stringify(expr)}`);
 }
 if (tokens.length === 0) throw new Error('if: empty expression');
 return tokens;
}

/**
 * Evaluator for exactly the `if:` grammar these guards use:
 *   <or>    := <and> ('||' <and>)*
 *   <and>   := <unary> ('&&' <unary>)*
 *   <unary> := '!' <unary> | '(' <or> ')' | github.event_name|github.ref ('=='|'!=') '<literal>'
 * Anything else — a function call, another property, a bare identifier — throws, so a
 * rewritten guard fails this file loudly instead of being mis-evaluated as false.
 */
function evalIf(expr, ctx) {
 const tokens = tokenizeIf(expr);
 let pos = 0;
 const peek = () => tokens[pos];
 const expect = (token) => {
  if (tokens[pos] !== token) throw new Error(`if: expected ${token}, found ${tokens[pos] ?? 'end'} in ${JSON.stringify(expr)}`);
  pos += 1;
 };
 const unary = () => {
  if (peek() === '!') {
   pos += 1;
   return !unary();
  }
  if (peek() === '(') {
   pos += 1;
   const value = or();
   expect(')');
   return value;
  }
  const field = peek();
  if (field !== 'github.event_name' && field !== 'github.ref') {
   throw new Error(`if: unsupported operand ${JSON.stringify(field ?? 'end')} in ${JSON.stringify(expr)}`);
  }
  pos += 1;
  const op = peek();
  if (op !== '==' && op !== '!=') {
   throw new Error(`if: ${field} must be compared with == or != (found ${JSON.stringify(op ?? 'end')}) in ${JSON.stringify(expr)}`);
  }
  pos += 1;
  const literal = peek();
  if (literal === undefined || !literal.startsWith("'")) {
   throw new Error(`if: ${field} ${op} expects a single-quoted literal (found ${JSON.stringify(literal ?? 'end')}) in ${JSON.stringify(expr)}`);
  }
  pos += 1;
  const key = field === 'github.event_name' ? 'event_name' : 'ref';
  if (ctx[key] === undefined) throw new Error(`if: context is missing ${key}`);
  return op === '==' ? ctx[key] === literal.slice(1, -1) : ctx[key] !== literal.slice(1, -1);
 };
 const and = () => {
  let value = unary();
  while (peek() === '&&') {
   pos += 1;
   const rhs = unary();
   value = value && rhs;
  }
  return value;
 };
 const or = () => {
  let value = and();
  while (peek() === '||') {
   pos += 1;
   const rhs = and();
   value = value || rhs;
  }
  return value;
 };
 const result = or();
 if (pos !== tokens.length) {
  throw new Error(`if: trailing tokens '${tokens.slice(pos).join(' ')}' in ${JSON.stringify(expr)}`);
 }
 return result;
}

test('ci.yml: the deploy job is reachable from a push to main only', () => {
 const guard = CI.jobs.deploy?.if;
 assert.equal(typeof guard, 'string', 'the deploy job must carry its own `if:` guard');

 // At the workflow level a fork PR and a Dependabot PR expose the same
 // github.event_name/github.ref as a same-repo PR (the fork lives in
 // github.event.pull_request.head.repo.fork, which this job never reads); the guard
 // reads those two fields only and the job never checks out the PR head, so none of
 // the three can reach it. Each is listed anyway, so a future guard that widened the
 // matrix would be caught here.
 //
 // The push-to-a-feature-branch row is not reachable today — `on.push.branches` is
 // `[main]` — but a guard must not lean on the trigger filter: widen the branches
 // list and `github.event_name == 'push'` alone would publish an unverified branch.
 const contexts = [
  { label: 'same-repo PR', event_name: 'pull_request', ref: 'refs/pull/42/merge' },
  { label: 'fork PR', event_name: 'pull_request', ref: 'refs/pull/43/merge' },
  { label: 'Dependabot PR', event_name: 'pull_request', ref: 'refs/pull/44/merge' },
  { label: 'push to main', event_name: 'push', ref: 'refs/heads/main' },
  { label: 'push to a feature branch', event_name: 'push', ref: 'refs/heads/feature/x' },
  { label: 'workflow_dispatch on a feature ref', event_name: 'workflow_dispatch', ref: 'refs/heads/feature/x' },
  { label: 'workflow_dispatch on main', event_name: 'workflow_dispatch', ref: 'refs/heads/main' },
 ];
 const reached = contexts.filter((ctx) => evalIf(guard, ctx)).map((ctx) => ctx.label);
 assert.deepEqual(reached, ['push to main'], `guard: ${guard}`);
});

test('ci.yml: the freshness gate decides publication from the live main tip', () => {
 const step = (CI.jobs.deploy?.steps ?? []).find((s) => String(s?.name ?? '').startsWith('Freshness gate'));
 assert.equal(typeof step?.run, 'string', 'the deploy job must carry a Freshness gate run step');

 // The step is executed as written, with a stub curl first on PATH: no network, and
 // the tip is whatever the test chooses.
 const runFreshness = (tip, { curlFails = false } = {}) => withTempDir('freshness', (dir) => {
  const script = path.join(dir, 'freshness.sh');
  writeFileSync(script, step.run);
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const stub = path.join(bin, 'curl');
  writeFileSync(stub, curlFails ? '#!/bin/sh\nexit 22\n' : "#!/bin/sh\nprintf '%s\\n' \"$STUB_TIP\"\n");
  chmodSync(stub, 0o755);
  const outputFile = path.join(dir, 'github-output');
  const summaryFile = path.join(dir, 'step-summary');
  writeFileSync(outputFile, '');
  writeFileSync(summaryFile, '');
  const res = spawnSync('bash', [script], {
   cwd: dir,
   encoding: 'utf8',
   timeout: 60_000,
   env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    STUB_TIP: tip,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    CANDIDATE,
    GITHUB_TOKEN: 'stub-token',
    API_URL: 'https://api.example.invalid',
    REPOSITORY: 'owner/repo',
   },
  });
  return {
   status: res.status,
   stderr: res.stderr,
   outputs: readFileSync(outputFile, 'utf8'),
   summary: readFileSync(summaryFile, 'utf8'),
  };
 });

 const fresh = runFreshness(CANDIDATE);
 assert.equal(fresh.status, 0, `a tip equal to the candidate must succeed: ${fresh.stderr}`);
 assert.match(fresh.outputs, /^fresh=true$/m);

 const superseded = runFreshness(OTHER_TIP);
 assert.equal(superseded.status, 0, `a superseded run is a no-op, not a failure: ${superseded.stderr}`);
 assert.match(superseded.outputs, /^fresh=false$/m);
 assert.match(superseded.summary, /superseded — no-op/, 'the no-op must be recorded in the step summary');

 const failedRead = runFreshness(CANDIDATE, { curlFails: true });
 assert.notEqual(failedRead.status, 0, 'a failed tip read must abort the step');
 assert.doesNotMatch(failedRead.outputs, /fresh=/, 'no freshness decision may be recorded when the read failed');
});

test('ci.yml: the required job cannot be skipped and still runs the frozen gate command', () => {
 const job = CI.jobs['build-and-test'];
 assert.ok(job, "the job reporting the 'build-and-test' context must exist");
 assert.equal(job.if, undefined, 'a job-level `if:` lets the required check report success without running the gate');
 const commands = (job.steps ?? []).map((s) => (typeof s?.run === 'string' ? s.run.trim() : ''));
 assert.ok(commands.includes('npm run verify'), 'the required job must run the frozen gate command `npm run verify`');
});
