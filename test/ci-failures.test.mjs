// ci-failures.test.mjs — durable proofs for the failure paths the campaign claims to detect.
//
// Brief §15 asks for evidence that the new CI detects failures, not only that it goes
// green. Two of those rows existed only as hand drills, which means nothing in the
// repository failed if the behaviour regressed afterwards; this file keeps them honest by
// driving the real entry points:
//
//   "Browser, axe, or fixture server is unavailable"
//     both halves run `scripts/run-tests.mjs --class browser` for real — once with an
//     empty PLAYWRIGHT_BROWSERS_PATH (no browser binary to find) and once with
//     FIXTURE_PORT already bound (the fixture server cannot listen). The class must FAIL
//     in both cases with the cause stated, never pass or go quiet. The first half filters
//     the class to one spec through the runner's own `--manifest` seam (see the call
//     site): every test fails at browser launch, so the whole suite would spend a minute
//     of launch failures on a property one spec settles.
//   "A test/log contains the synthetic secret sentinel"
//     `scripts/check-sentinel.mjs` must fail, naming file and line, on a planted sentinel
//     and on a foreign sk-or-v1 key, and clear the same root once they are gone.
//
// Nothing below re-implements the scripts under test: each case spawns the real entry
// point with the Node that runs the class. Three consequences are handled explicitly
// rather than assumed:
//
//   * the class runner writes artifacts/results/<class>.json by default, so every
//     invocation is given `--json <tmpdir>/…`, and the Playwright JSON report — whose
//     path the browser config fixes — is redirected with PLAYWRIGHT_JSON_OUTPUT_FILE:
//     the campaign's evidence chain under artifacts/results/ is never rewritten here;
//   * Playwright owns test-results/browser and rewrites it at the start of every run, so
//     a child run replaces the class's previous retained diagnostics (harmless in the
//     gate's own order, offline before browser) and the directories the children create
//     are removed again in `finally`;
//   * the browser class tests the staged artifact, so `_site/` is a hard precondition: a
//     missing build is reported as a missing build, not as a missing browser.
//
// Ports are chosen per child by binding :0, so a drill cannot collide with a real browser
// run happening at the same time. Every child is bounded twice — the runner's own
// `--timeout` for the class runs and this file's timer on all of them — so a hang fails
// this test instead of stalling the class. Deterministic and offline: no network, no fixed
// ports, temp dirs only.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The artifact the browser class tests; its config refuses an unbuilt tree. */
const SITE = path.join(ROOT, '_site');
/** The browser class's own output directory (see the rewriting note above). */
const BROWSER_OUT = path.join(ROOT, 'test-results', 'browser');

/**
 * One child, bounded, stdout and stderr read as a single stream as the runner does.
 *
 * Asynchronous on purpose: the port this file holds for the fixture-server case is a
 * listener in this process, and a synchronous spawn would block the event loop that has
 * to reset the connections Playwright's webServer probe opens to it. Blocked, the probe
 * simply waits — measured: the class then hangs on the probe with nothing printed and is
 * only stopped by its own timeout, which proves the wrong thing.
 *
 * The child gets its own process group (the runner does the same) so the last-resort
 * timer can sweep the whole tree instead of leaving servers behind.
 */
function run(argv, { env = {}, timeout }) {
 return new Promise((resolve) => {
  const child = spawn(argv[0], argv.slice(1), {
   cwd: ROOT,
   detached: true,
   env: { ...process.env, ...env },
  });
  let output = '';
  let timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const timer = setTimeout(() => {
   timedOut = true;
   try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, timeout);
  child.on('close', (status) => {
   clearTimeout(timer);
   resolve({ status, timedOut, output });
  });
 });
}

const scratch = (label) => mkdtempSync(path.join(tmpdir(), `ci-failures-${label}-`));
const entriesOf = (dir) => (existsSync(dir) ? readdirSync(dir) : []);

/** Remove what a child added to the browser class's output dir — never what was there. */
function dropNewOutput(before) {
 for (const name of entriesOf(BROWSER_OUT)) {
  if (!before.includes(name)) rmSync(path.join(BROWSER_OUT, name), { recursive: true, force: true });
 }
}

/** A port nothing holds right now: bound on :0, read, released. */
function freePort() {
 return new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
   const { port } = probe.address();
   probe.close(() => resolve(port));
  });
 });
}

/**
 * Hold `port` for as long as the returned server lives, resetting every connection.
 *
 * The reset is the point. Playwright probes the webServer URL before it starts anything,
 * and that probe has no deadline of its own: a listener that accepts without ever
 * answering leaves it waiting, so nothing is printed and the class is only stopped by the
 * bound the runner was given. Resetting makes the probe fail at once, and the failure the
 * class reports is the one this drill is about — the fixture server's own refusal.
 */
function holdPort(port) {
 return new Promise((resolve, reject) => {
  const server = net.createServer((socket) => socket.destroy());
  server.on('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server));
 });
}

/** The per-root coverage line the scan prints for one root. */
function coverageLine(output, root) {
 const line = output.split('\n').find((l) => l.trimStart().startsWith(`${root} `));
 assert.ok(line, `the scan printed no coverage line for ${root}:\n${output}`);
 return line;
}

/** The browser class serves the staged artifact, so a missing build must read as one. */
function requireStagedSite() {
 const missing = ['index.html', path.join('dist', 'agent.wasm')]
  .filter((rel) => !existsSync(path.join(SITE, rel)));
 assert.equal(missing.length, 0,
  `_site/ is not staged (missing ${missing.join(', ')}). Run \`npm run build\` first: the `
  + 'required gate builds before the browser class, and these drills serve the same artifact.');
}

// ── scripts/check-sentinel.mjs ────────────────────────────────────────────────

test('check-sentinel: a planted sentinel or foreign key fails the scan and is named', async () => {
 const root = scratch('sentinel');
 try {
  const leak = path.join(root, 'notes', 'leak.txt');
  const foreign = path.join(root, 'foreign.txt');
  const clean = path.join(root, 'clean.txt');
  const dummy = path.join(root, 'declared-dummy.txt');
  mkdirSync(path.dirname(leak), { recursive: true });
  writeFileSync(leak, ['# retained run log', 'api key SYNTHETIC-SECRET-SENTINEL-9f3c1a must never ship', ''].join('\n'));
  writeFileSync(foreign, 'authorization: sk-or-v1-ABCDEFGHIJKLMNOP1234\n');
  writeFileSync(clean, 'a retained line with nothing secret-shaped in it\n');
  writeFileSync(dummy, "const DECLARED_DUMMY = 'sk-or-v1-test-dummy-key-not-real';\n");

  const dirty = await run([process.execPath, 'scripts/check-sentinel.mjs', root], { timeout: 60_000 });
  assert.equal(dirty.timedOut, false, `the scan did not finish:\n${dirty.output}`);
  assert.equal(dirty.status, 1, `a planted leak must fail the scan (exit ${dirty.status}):\n${dirty.output}`);
  assert.ok(dirty.output.includes(`${leak}:2  synthetic sentinel:`),
   `the sentinel must be reported at its own file and line:\n${dirty.output}`);
  assert.ok(dirty.output.includes(`${foreign}:1  key-shaped string:`),
   `the foreign key must be reported at its own file and line:\n${dirty.output}`);
  assert.ok(dirty.output.includes('SENTINEL FAIL'), `the summary must say the scan failed:\n${dirty.output}`);
  assert.equal(dirty.output.includes(clean), false, `a clean retained line is not a finding:\n${dirty.output}`);
  assert.equal(dirty.output.includes(dummy), false,
   `the declared dummy key is legitimate and must not be reported:\n${dirty.output}`);
  assert.match(coverageLine(dirty.output, root), /scanned 4 file\(s\)/,
   'the root must have been read, so "no finding" can never mean "not looked at"');

  // Same root, planted files gone: the scan must clear it. The default roots
  // (artifacts/, test-results/, _site/) are scanned too, and a *failing* browser run
  // legitimately retains the sentinel in its traces — see the header of
  // scripts/check-sentinel.mjs — so the failure message names the root to look at.
  rmSync(path.join(root, 'notes'), { recursive: true, force: true });
  rmSync(foreign, { force: true });

  const clear = await run([process.execPath, 'scripts/check-sentinel.mjs', root], { timeout: 60_000 });
  assert.equal(clear.status, 0,
   `a clean root must scan clean (exit ${clear.status}); any finding outside ${root} comes from the `
   + "repository's own retained roots — usually a stale failing browser run under test-results/ — "
   + `not from this drill:\n${clear.output}`);
  assert.match(clear.output, /^SENTINEL OK — no sentinel or foreign sk-or-v1 key/m,
   `the clean summary must be explicit:\n${clear.output}`);
  assert.match(coverageLine(clear.output, root), /scanned 2 file\(s\)/,
   'the clean run must still have read the root');
 } finally {
  rmSync(root, { recursive: true, force: true });
 }
});

// ── scripts/run-tests.mjs, class "browser" ────────────────────────────────────

test('browser class: no browser installed fails the class and names the executable it wanted', async () => {
 requireStagedSite();
 const browsers = scratch('empty-browsers');  // deliberately empty: Playwright finds nothing in it
 const manifest = scratch('manifest');
 const reports = scratch('reports');
 const before = entriesOf(BROWSER_OUT);
 const sitePort = await freePort();
 const fixturePort = await freePort();
 const reportPath = path.join(reports, 'browser-playwright.json');
 const spec = 'test/browser/harness.spec.mjs';
 // The class as the manifest declares it enumerates all 88 chromium specs, and every one
 // of them fails at launch: measured, that is 17 s on an idle machine and over a minute
 // under load, for a property one spec settles. The runner's `--manifest` seam (documented
 // for exactly this, and used the same way by test/ci-guards.test.mjs) filters the class to
 // one real spec — the class, its config, its two webServers and its preflight are the same.
 writeFileSync(path.join(manifest, 'browser.json'), `${JSON.stringify({
  version: 1,
  entries: [{ path: spec, kind: 'test', class: 'browser', run: 'playwright' }],
 }, null, 2)}\n`);
 try {
  const child = await run([
   process.execPath, 'scripts/run-tests.mjs', '--class', 'browser',
   '--manifest', path.join(manifest, 'browser.json'),
   '--json', path.join(reports, 'browser.json'),
   '--timeout', '120000',
  ], {
   env: {
    PLAYWRIGHT_BROWSERS_PATH: browsers,
    PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath,
    SITE_PORT: String(sitePort),
    FIXTURE_PORT: String(fixturePort),
   },
   timeout: 180_000,
  });

  assert.equal(child.timedOut, false, `the browser class never finished:\n${child.output}`);
  assert.notEqual(child.status, 0,
   `the class must fail without a browser instead of reporting success:\n${child.output}`);
  assert.ok(child.output.includes('RUNNER browser FAIL'), `the runner must fail the class:\n${child.output}`);
  const failing = /exit 1 \((\d+) failing\)/.exec(child.output);
  assert.ok(failing,
   `the class must report failing tests — a quiet pass is the defect this proves absent:\n${child.output}`);
  assert.ok(child.output.includes(spec), `the failing entry must be named:\n${child.output}`);
  assert.ok(child.output.includes(`READY http://127.0.0.1:${sitePort}/assembly-agent/`)
   && child.output.includes(`READY http://127.0.0.1:${fixturePort}/__fixture/health`),
   'both servers must have started: the browser is what is missing, nothing else');

  assert.ok(existsSync(reportPath), `Playwright wrote no JSON report:\n${child.output}`);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.stats.expected, 0, 'no test can pass without a browser');
  assert.equal(report.stats.skipped, 0, 'no test may be omitted when the browser is absent');
  assert.ok(report.stats.unexpected > 0, 'the missing browser must fail tests, not make them disappear');
  assert.equal(Number(failing[1]), report.stats.unexpected,
   'the runner and Playwright must count the same failures');
  assert.ok(report.suites.some((suite) => String(suite.file).includes('harness.spec.mjs')),
   `the class must have run the scoped spec:\n${child.output}`);

  const messages = [...new Set(report.suites
   .flatMap((suite) => suite.specs ?? [])
   .flatMap((entry) => entry.tests ?? [])
   .flatMap((entry) => entry.results ?? [])
   .map((result) => result.error?.message ?? ''))].filter(Boolean);
  assert.ok(messages.length > 0, `Playwright recorded no error message:\n${child.output}`);
  for (const message of messages) {
   assert.ok(message.includes(`Executable doesn't exist at ${browsers}`),
    `the cause must be the browser searched for in the empty PLAYWRIGHT_BROWSERS_PATH:\n${message}`);
   assert.ok(message.includes('npx playwright install'),
    `the message must carry the fix, not just the failure:\n${message}`);
  }
 } finally {
  dropNewOutput(before);
  rmSync(browsers, { recursive: true, force: true });
  rmSync(manifest, { recursive: true, force: true });
  rmSync(reports, { recursive: true, force: true });
 }
});

test('browser class: a taken FIXTURE_PORT fails the class with the fixture server refusal', async () => {
 requireStagedSite();
 const reports = scratch('reports');
 const before = entriesOf(BROWSER_OUT);
 const sitePort = await freePort();
 const fixturePort = await freePort();
 const held = await holdPort(fixturePort);
 try {
  const child = await run([
   process.execPath, 'scripts/run-tests.mjs', '--class', 'browser',
   '--json', path.join(reports, 'browser.json'),
   '--timeout', '90000',
  ], {
   env: {
    SITE_PORT: String(sitePort),
    FIXTURE_PORT: String(fixturePort),
    PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(reports, 'browser-playwright.json'),
   },
   timeout: 150_000,
  });

  assert.equal(child.timedOut, false,
   `the class hung although its servers fail at startup:\n${child.output}`);
  assert.notEqual(child.status, 0,
   `the class must fail when the fixture server cannot listen:\n${child.output}`);
  assert.ok(child.output.includes('RUNNER browser FAIL'), `the runner must fail the class:\n${child.output}`);
  assert.ok(child.output.includes('Process from config.webServer was not able to start'),
   `Playwright must report the web server as the cause:\n${child.output}`);
  assert.ok(child.output.includes(`FIXTURE FAIL: cannot listen on 127.0.0.1:${fixturePort}`),
   `the fixture server's own refusal must survive into the class output:\n${child.output}`);
  assert.ok(child.output.includes('EADDRINUSE'), `the refusal must name the errno:\n${child.output}`);
  assert.ok(child.output.includes(`READY http://127.0.0.1:${sitePort}/assembly-agent/`),
   'the site server must have started: the port that matters is the fixture one');
 } finally {
  await new Promise((resolve) => held.close(resolve));
  dropNewOutput(before);
  rmSync(reports, { recursive: true, force: true });
 }
});
