#!/usr/bin/env node
/**
 * scripts/run-tests.mjs — class-scoped test runner (campaign R01).
 *
 * Contract (campaign "Fixed contracts"):
 *   - `--class <offline|worker|browser|scheduled-browser|live>`; the class list is
 *     read from test/manifest.json and is frozen by the contract.
 *   - Every selected entry runs in its own subprocess (no cross-import pollution,
 *     no ordering luck from shared globals).
 *   - run = node-test  -> `node --test <file>`; exit 0 AND a parsed reporter
 *     summary (spec footer `ℹ tests N` / TAP `# tests N`) with N > 0. A run whose
 *     summary reports zero tests, or that prints no summary at all, fails: Node
 *     still reports a synthetic file-level test, so node-test files are also
 *     checked for at least one test/assertion construct in source.
 *   - run = script     -> `node <file>`; exit 0 AND a final `ALL ... PASS` marker
 *     (regex /^ALL [A-Z0-9 :.-]+PASS$/m). Empty output = failure.
 *   - run = vitest-config / playwright -> delegate to the tool config, map the
 *     exit code, and parse its summary counts; a `flaky` retry-only pass fails.
 *   - Retries are NEVER enabled by this runner and a pass that used retries is a
 *     failure (see RETRY_PATTERNS). Deterministic PR runs must surface flakes.
 *   - `.only(`, `.skip(`, `.todo(` in a required-class test file fails the run
 *     before the file even executes (source scan, file + line reported). An entry
 *     may opt out with `"allowSkip": true` in the manifest, which is also the only
 *     way an intentional runtime skip/todo is tolerated.
 *   - A class with zero entries fails.
 *   - Machine-readable results are written to artifacts/results/<class>.json
 *     (`--json <path>` overrides; `--manifest <path>` swaps the manifest, used by
 *     the campaign's negative tests).
 *
 * Exit 0 and a final line `RUNNER <class> PASS (N/M entries)` only when every
 * selected entry passed; otherwise exit 1 with `RUNNER <class> FAIL (N/M entries)`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Frozen contract values (see campaign "Fixed contracts").
const CLASSES = ['offline', 'worker', 'browser', 'scheduled-browser', 'live'];
const REQUIRED_CLASSES = ['offline', 'worker', 'browser'];
// Marker contract. The campaign text spells it `/^ALL [A-Z0-9 :.-]+PASS$/m`, but
// that regex cannot match its own worked example `ALL PASS` (the `+` demands a
// qualifier before PASS). Minimal coherent deviation: allow the empty qualifier so
// `ALL PASS`, `ALL A11Y PASS`, `ALL DECODE-ESCAPE PASS` … all match while junk does
// not. See .scratch/ci/issues/s1.md.
const MARKER_RE = /^ALL(?: [A-Z0-9 :.-]+)? PASS$/m;
const TEST_CONSTRUCT_RE = /\b(?:test|it|describe)\s*\(|node:assert|assert\s*[.(]/;
const SOURCE_SCAN = [
  { label: '.only(', re: /\.only\s*\(/ },
  { label: '.skip(', re: /\.skip\s*\(/ },
  { label: '.todo(', re: /\.todo\s*\(/ },
  { label: 'describe.skip', re: /describe\.skip\b/ },
  { label: 'it.skip', re: /it\.skip\b/ },
  { label: 'test.skip', re: /test\.skip\b/ },
];
// Retries are never enabled here; any of these markers means a pass leaned on them.
const RETRY_PATTERNS = [
  { label: 'TAP retried', re: /^\s*#\s*retried\s+[1-9]\d*/m },
  { label: 'spec retried', re: /^\s*ℹ\s*retried\s+[1-9]\d*/m },
  { label: 'flaky summary', re: /(?:^|\s)[1-9]\d*\s+flaky\b/im },
  { label: 'retries metadata', re: /\bretries?["'\s]*[:=]\s*[1-9]\d*/i },
];
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function usage(code = 0) {
  const out = code === 0 ? console.log : console.error;
  out(`usage: node scripts/run-tests.mjs --class <${CLASSES.join('|')}> [options]

options:
  --json <path>      write the results JSON somewhere other than artifacts/results/<class>.json
  --manifest <path>  use an alternate manifest (negative tests must not edit test/manifest.json)
  --timeout <ms>     per-entry timeout (default 300000)
  --list             list the selected entries and exit
  --help             show this text`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { class: null, json: null, manifest: path.join(ROOT, 'test/manifest.json'), timeout: 300_000, list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined) usage(2);
      i += 1;
      return value;
    };
    if (arg === '--class') args.class = take();
    else if (arg === '--json') args.json = take();
    else if (arg === '--manifest') args.manifest = path.resolve(ROOT, take());
    else if (arg === '--timeout') args.timeout = Number(take());
    else if (arg === '--list') args.list = true;
    else if (arg === '--help' || arg === '-h') usage(0);
    else usage(2);
  }
  return args;
}

function resolveToolConfig(entry, tool) {
  if (typeof entry.config === 'string' && entry.config) return entry.config;
  const p = String(entry.path ?? '').replace(/\/+$/, '');
  const defaultName = tool === 'playwright' ? 'playwright.config.mjs' : 'vitest.config.mjs';
  const abs = path.join(ROOT, p);
  if (!p.endsWith('.mjs') && existsSync(abs)) return `${p}/${defaultName}`;
  if (/\.config\.[cm]?js$/.test(p)) return p;
  return `${path.dirname(p)}/${defaultName}`;
}

function commandFor(entry, cls) {
  const p = String(entry.path);
  switch (entry.run) {
    case 'node-test':
      return { argv: [process.execPath, '--test', p], display: `node --test ${p}` };
    case 'script':
      return { argv: [process.execPath, p], display: `node ${p}` };
    case 'vitest-config': {
      const config = resolveToolConfig(entry, 'vitest');
      return { argv: [NPX, 'vitest', 'run', '--config', config], display: `npx vitest run --config ${config}` };
    }
    case 'playwright': {
      const config = resolveToolConfig(entry, 'playwright');
      const argv = [NPX, 'playwright', 'test', '--config', config];
      if (entry.kind === 'test') argv.push(p);
      if (cls === 'scheduled-browser') argv.push('--project=firefox', '--project=webkit');
      return { argv, display: `npx playwright test --config ${config}${cls === 'scheduled-browser' ? ' --project=firefox --project=webkit' : ''}` };
    }
    default:
      throw new Error(`unknown run "${entry.run}" for ${p}`);
  }
}

function scanSource(absPath) {
  let source;
  try {
    source = readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  const hits = [];
  source.split('\n').forEach((line, i) => {
    for (const { label, re } of SOURCE_SCAN) {
      if (re.test(line)) hits.push(`${rel(absPath)}:${i + 1}: contains ${label}`);
    }
  });
  return hits;
}

const rel = (p) => path.relative(ROOT, p) || p;

function parseSummary(output) {
  // Spec reporter: `ℹ tests 4`; TAP reporter: `# tests 4`. Last occurrence wins.
  const summary = {};
  for (const line of output.split('\n')) {
    const m = /^\s*(?:ℹ\s*|#\s*)(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/.exec(line);
    if (m) summary[m[1]] = Number(m[2]);
  }
  if (summary.tests === undefined) {
    const plan = /^\s*1\.\.(\d+)\s*$/m.exec(output);
    if (plan) summary.tests = Number(plan[1]);
  }
  return summary;
}

/**
 * SGR/CSI escape sequences as produced by vitest, playwright and workerd.
 * Written with String.fromCharCode so the source file stays plain ASCII.
 */
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const stripAnsi = (text) => text.replace(ANSI_RE, '');

function retryHits(output) {
  const hits = [];
  for (const { label, re } of RETRY_PATTERNS) {
    const m = re.exec(output);
    if (m) hits.push(`${label} (${m[0].trim()})`);
  }
  return hits;
}

function analyzeToolSummary(output, tool) {
  // Counts must come from the reporter's summary block, never from test titles:
  // vitest → `Tests  1 failed | 2 passed (3)`; playwright → `  1 passed (2.3s)`.
  const summaryValue = (label) => {
    let value = 0;
    for (const line of output.split('\n')) {
      const m = new RegExp(`^\\s*(\\d+)\\s+${label}\\b`).exec(line);
      if (m) value = Number(m[1]);
    }
    return value;
  };
  if (tool === 'vitest') {
    const line = output.split('\n').reverse().find((l) => /^\s*Tests\s/.test(l)) ?? '';
    const n = (re) => {
      const m = re.exec(line);
      return m ? Number(m[1]) : 0;
    };
    return {
      passed: n(/(\d+)\s+passed/),
      failed: n(/(\d+)\s+failed/),
      skipped: n(/(\d+)\s+skipped/),
      parsed: line !== '',
    };
  }
  return {
    passed: summaryValue('passed'),
    failed: summaryValue('failed'),
    skipped: summaryValue('skipped'),
    parsed: /(\d+)\s+passed\b/.test(output) || /(\d+)\s+failed\b/.test(output),
  };
}

function runEntry(entry, cls, timeout) {
  const { argv, display } = commandFor(entry, cls);
  const result = {
    path: entry.path,
    kind: entry.kind,
    run: entry.run,
    cmd: display,
    exit: null,
    ms: 0,
    tests: null,
    passed: null,
    failed: null,
    skipped: 0,
    marker: null,
    ok: false,
    reason: null,
  };

  const absPath = path.join(ROOT, String(entry.path));
  if (!existsSync(absPath)) {
    result.reason = `missing file ${entry.path}`;
    return result;
  }

  // Source scan before execution (required classes only): .only/.skip/.todo.
  if (entry.kind === 'test' && REQUIRED_CLASSES.includes(cls) && entry.allowSkip !== true) {
    const hits = scanSource(absPath);
    if (hits.length > 0) {
      result.reason = `source scan rejected the file:\n${hits.join('\n')}`;
      result.hits = hits;
      return result;
    }
  }

  const started = process.hrtime.bigint();
  // Captured output must be parseable and warning-free: drop forced-colour hints
  // (a TTY-less pipe is colourless anyway, and NO_COLOR would fight Playwright's
  // own FORCE_COLOR for its workers, which Node reports as a warning).
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  result.ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
  const timedOut = Boolean(res.error && res.error.code === 'ETIMEDOUT');
  // Reporters colour their summary when the environment allows it, and whether
  // they do is not ours to decide: vitest emits SGR sequences in CI while a
  // developer shell with NO_COLOR set sees plain text. Strip them once here so
  // every downstream read (summary parsing, retry detection, printed output,
  // the sentinel scan) sees the same bytes in both places. A summary that only
  // parses when the terminal is plain is not a summary we can gate on.
  const output = stripAnsi(`${res.stdout ?? ''}${res.stderr ?? ''}`);
  result.exit = res.status;
  result.output = output;

  if (timedOut) {
    result.reason = `timed out after ${timeout} ms`;
    return result;
  }
  if (res.error) {
    result.reason = `spawn failed: ${res.error.message}`;
    return result;
  }

  const retries = retryHits(output);
  if (retries.length > 0) {
    result.reason = `retry-only success is not accepted (${retries.join(', ')})`;
    return result;
  }

  if (entry.run === 'script') {
    if (res.status !== 0) {
      result.reason = `exit ${res.status}`;
      return result;
    }
    if (output.trim() === '') {
      result.reason = 'no output from a script entry (nothing ran)';
      return result;
    }
    const marker = MARKER_RE.exec(output);
    if (!marker) {
      result.reason = 'missing "ALL ... PASS" marker';
      return result;
    }
    result.marker = marker[0];
    result.tests = 1;
    result.passed = 1;
    result.failed = 0;
    result.ok = true;
    return result;
  }

  if (entry.run === 'node-test') {
    if (res.status !== 0) {
      result.reason = `exit ${res.status}`;
      return result;
    }
    const summary = parseSummary(output);
    if (summary.tests === undefined) {
      result.reason = 'no test summary in reporter output (spec footer `ℹ tests N` / TAP `# tests N`)';
      return result;
    }
    result.tests = summary.tests;
    result.passed = summary.pass ?? 0;
    result.failed = summary.fail ?? 0;
    result.skipped = summary.skipped ?? 0;
    result.todo = summary.todo ?? 0;
    result.cancelled = summary.cancelled ?? 0;
    if (summary.tests === 0) {
      result.reason = 'zero tests executed';
      return result;
    }
    if (!TEST_CONSTRUCT_RE.test(readFileSync(absPath, 'utf8'))) {
      result.reason = `zero-test guard: ${entry.path} declares no test or assertion construct`;
      return result;
    }
    if ((summary.fail ?? 0) > 0) {
      result.reason = `${summary.fail} failing test(s)`;
      return result;
    }
    if ((summary.cancelled ?? 0) > 0) {
      result.reason = `${summary.cancelled} cancelled test(s)`;
      return result;
    }
    if ((summary.skipped ?? 0) > 0 || (summary.todo ?? 0) > 0) {
      if (entry.allowSkip !== true) {
        result.reason = `unexpected skip/todo (skipped=${summary.skipped ?? 0}, todo=${summary.todo ?? 0}) — set "allowSkip": true only for a reviewed exception`;
        return result;
      }
    }
    result.ok = true;
    return result;
  }

  // vitest-config | playwright
  const tool = entry.run === 'playwright' ? 'playwright' : 'vitest';
  const counts = analyzeToolSummary(output, tool);
  result.tests = counts.passed + counts.failed + counts.skipped;
  result.passed = counts.passed;
  result.failed = counts.failed;
  result.skipped = counts.skipped;
  if (res.status !== 0) {
    result.reason = `exit ${res.status}${counts.failed ? ` (${counts.failed} failing)` : ''}`;
    return result;
  }
  if (!counts.parsed) {
    // Exit 0 with an unreadable summary is not evidence that tests ran: a reporter
    // change or a silently empty selection would otherwise pass the required class.
    result.reason = `no parseable test summary in the ${tool} output (expected the reporter's "${tool === 'playwright' ? 'N passed' : 'Tests  N passed'}" line)`;
    return result;
  }
  if (result.tests === 0) {
    result.reason = 'zero tests executed';
    return result;
  }
  if (counts.skipped > 0 && entry.allowSkip !== true) {
    result.reason = `unexpected skip (skipped=${counts.skipped}) — set "allowSkip": true only for a reviewed exception`;
    return result;
  }
  result.ok = true;
  return result;
}

function printOutput(output, max = 80) {
  const lines = output.replace(/\s+$/, '').split(/\r?\n/);
  if (lines.length > max) {
    const head = lines.slice(0, 15);
    const tail = lines.slice(-(max - 15));
    for (const line of head) console.log(`    │ ${line}`);
    console.log(`    │ … ${lines.length - max} line(s) omitted …`);
    for (const line of tail) console.log(`    │ ${line}`);
    return;
  }
  for (const line of lines) console.log(`    │ ${line}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.class) usage(2);
  if (!CLASSES.includes(args.class)) {
    console.error(`RUNNER FAIL: unknown class "${args.class}" (expected ${CLASSES.join(', ')})`);
    process.exit(2);
  }
  if (!existsSync(args.manifest)) {
    console.error(`RUNNER FAIL: manifest not found: ${rel(args.manifest)}`);
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
  if (manifest.version !== 1) {
    console.error(`RUNNER FAIL: manifest version must be 1 (got ${JSON.stringify(manifest.version)})`);
    process.exit(2);
  }

  const entries = (manifest.entries ?? []).filter(
    (e) => e && (e.kind === 'test' || e.kind === 'suite') && e.class === args.class,
  );
  if (entries.some((e) => e.live === true || e.probe === true) && args.class !== 'live') {
    console.error(`RUNNER FAIL: live probe selected for class "${args.class}"`);
    process.exit(2);
  }

  console.log(`RUNNER class=${args.class} manifest=${rel(args.manifest)} timeout=${args.timeout}ms`);
  if (args.class === 'live') {
    console.log('RUNNER note: "live" is not a required class — operational probes never gate a PR.');
  }

  if (entries.length === 0) {
    console.error(`RUNNER ${args.class} FAIL (0/0 entries)`);
    console.error(
      `  no manifest entries for class "${args.class}" — add one (kind "test"/"suite" with class+run) once the suite exists.`,
    );
    process.exit(1);
  }

  if (args.list) {
    for (const e of entries) console.log(`  ${e.path} (${e.kind}, ${e.run})`);
    process.exit(0);
  }

  const results = [];
  for (const entry of entries) {
    console.log(`\n▶ ${entry.path} [${entry.run}]`);
    const result = runEntry(entry, args.class, args.timeout);
    results.push(result);
    if (result.ok) {
      const counts = result.tests === null ? '' : `, tests ${result.tests}`;
      console.log(`✓ ${entry.path} — exit 0, ${(result.ms / 1000).toFixed(1)}s${counts}${result.marker ? `, marker "${result.marker}"` : ''}`);
      if (result.output) console.log(`    │ ${result.output.trim().split('\n').pop()}`);
    } else {
      console.log(`✗ ${entry.path} — ${result.reason}`);
      for (const hit of result.hits ?? []) console.log(`    ✗ ${hit}`);
      if (result.output) printOutput(result.output);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const totalTests = results.reduce((sum, r) => (r.ok && typeof r.tests === 'number' ? sum + r.tests : sum), 0);
  const ok = okCount === results.length;
  const outPath = args.json ? path.resolve(ROOT, args.json) : path.join(ROOT, 'artifacts', 'results', `${args.class}.json`);
  const payload = {
    class: args.class,
    ok,
    totalTests,
    manifest: rel(args.manifest),
    durationMs: results.reduce((sum, r) => sum + r.ms, 0),
    entries: results.map((r) => ({
      path: r.path,
      kind: r.kind,
      run: r.run,
      cmd: r.cmd,
      exit: r.exit,
      ms: r.ms,
      tests: r.tests,
      passed: r.passed,
      failed: r.failed,
      skipped: r.skipped,
      marker: r.marker,
      ok: r.ok,
      reason: r.reason,
    })),
  };
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  console.log('');
  for (const r of results) {
    const status = r.ok ? 'PASS' : 'FAIL';
    console.log(`  ${status}  ${r.path}${r.ok ? '' : ` — ${String(r.reason).split('\n')[0]}`}`);
  }
  console.log(`  results: ${rel(outPath)}`);
  console.log(`RUNNER ${args.class} ${ok ? 'PASS' : 'FAIL'} (${okCount}/${results.length} entries)`);
  process.exit(ok ? 0 : 1);
}

main();
