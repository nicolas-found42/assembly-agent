#!/usr/bin/env node
/**
 * scripts/verify.mjs — the one required gate command (`npm run verify`).
 *
 * Every step is named, all steps run even after a failure, all failures are
 * reported, and the process exits nonzero if any step failed:
 *
 *   1  manifest   node scripts/validate-manifest.mjs
 *   2  toolchain  node scripts/toolchain.mjs
 *   3  build      bash scripts/build-site.sh
 *   4  offline    node scripts/run-tests.mjs --class offline
 *   5  worker     node scripts/run-tests.mjs --class worker
 *   6  browser    node scripts/run-tests.mjs --class browser
 *   7  packaging  node scripts/site-inventory.mjs --verify _site
 *   8  deps       node scripts/check-deps.mjs
 *   9  lint       bash scripts/lint.sh
 *  10  audit      node scripts/audit-policy.mjs
 *  11  sentinel   node scripts/check-sentinel.mjs
 *
 * This is the single definition of required test membership: the class runner
 * reads `test/manifest.json`, so no step of the suite is duplicated in workflow
 * YAML. A missing prerequisite fails the gate — nothing is skipped silently.
 * `audit` fails closed when the advisory service is unreachable: an unavailable
 * scan is reported as unavailable, never as "0 vulnerabilities". `sentinel` runs
 * last because it scans the retained-output roots the other steps write into.
 *
 * Options: `--list` prints the steps; `--only <id>` runs just one (to reproduce a
 * CI failure locally without deciphering YAML).
 *
 * Exit 0 and a final `VERIFY PASS (steps: …)` line when every step passed;
 * otherwise exit 1 with `VERIFY FAIL (steps: …)`.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NODE = process.execPath;

const STEPS = [
  {
    id: 'manifest',
    name: 'test classification',
    argv: [NODE, 'scripts/validate-manifest.mjs'],
  },
  {
    id: 'toolchain',
    name: 'declared toolchain',
    argv: [NODE, 'scripts/toolchain.mjs'],
  },
  {
    id: 'build',
    name: 'staged site build',
    argv: ['bash', 'scripts/build-site.sh'],
  },
  {
    id: 'offline',
    name: 'offline suites (node + wasm engine)',
    argv: [NODE, 'scripts/run-tests.mjs', '--class', 'offline'],
  },
  {
    id: 'worker',
    name: 'worker runtime suite',
    argv: [NODE, 'scripts/run-tests.mjs', '--class', 'worker'],
  },
  {
    id: 'browser',
    name: 'browser + accessibility suite (staged site)',
    argv: [NODE, 'scripts/run-tests.mjs', '--class', 'browser'],
  },
  {
    id: 'packaging',
    name: 'packaging integrity (promotion guard)',
    argv: [NODE, 'scripts/site-inventory.mjs', '--verify', '_site'],
  },
  {
    id: 'deps',
    name: 'dependency and vendoring consistency',
    argv: [NODE, 'scripts/check-deps.mjs'],
  },
  {
    id: 'lint',
    name: 'workflow, script and source checks',
    argv: ['bash', 'scripts/lint.sh'],
  },
  {
    id: 'audit',
    name: 'vulnerability policy',
    argv: [NODE, 'scripts/audit-policy.mjs'],
  },
  {
    // Last on purpose: this scans the retained-output roots, so it must run after
    // every other step has written its report. It has no prerequisite and must
    // still run when an earlier step failed — a failing run is exactly when
    // traces and error contexts are written.
    id: 'sentinel',
    name: 'retained-output secret scan',
    argv: [NODE, 'scripts/check-sentinel.mjs'],
  },
];

function usage(code = 0) {
  const out = code === 0 ? console.log : console.error;
  out(`usage: node scripts/verify.mjs [--list] [--only <step-id>]

steps: ${STEPS.map((s) => s.id).join(', ')}`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { list: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--list') args.list = true;
    else if (argv[i] === '--only') {
      args.only = argv[i + 1];
      if (!args.only) usage(2);
      i += 1;
    } else if (argv[i] === '--help' || argv[i] === '-h') usage(0);
    else usage(2);
  }
  return args;
}

function printBounded(output, max = 80) {
  const lines = output.replace(/\s+$/, '').split(/\r?\n/);
  if (lines.length <= max) {
    for (const line of lines) console.log(`    │ ${line}`);
    return;
  }
  for (const line of lines.slice(0, 15)) console.log(`    │ ${line}`);
  console.log(`    │ … ${lines.length - max} line(s) omitted …`);
  for (const line of lines.slice(-(max - 15))) console.log(`    │ ${line}`);
}

function run(step) {
  const command = step.argv.join(' ');
  const started = process.hrtime.bigint();
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  const res = spawnSync(step.argv[0], step.argv.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const exit = res.status;
  const ok = !res.error && exit === 0;
  return { status: ok ? 'pass' : 'fail', command, exit, ms, output, error: res.error?.message };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const step of STEPS) console.log(`${step.id.padEnd(10)} ${step.argv.join(' ')}`);
    process.exit(0);
  }
  const steps = args.only ? STEPS.filter((s) => s.id === args.only) : STEPS;
  if (steps.length === 0) usage(2);

  console.log(`VERIFY — ${steps.length} step(s), repository ${ROOT}\n`);
  const results = [];
  steps.forEach((step, i) => {
    const label = `[${i + 1}/${steps.length}] ${step.id}: ${step.name}`;
    const result = run(step);
    results.push({ step, result });
    if (result.status === 'pass') {
      console.log(`${label} … PASS (${(result.ms / 1000).toFixed(1)}s) — ${result.command}`);
      if (result.output.trim()) console.log(`    │ ${result.output.trim().split('\n').pop()}`);
      return;
    }
    console.log(`${label} … FAIL (exit ${result.exit ?? 'spawn-error'}) — ${result.command}`);
    if (result.error) console.log(`    │ ${result.error}`);
    if (result.output?.trim()) printBounded(result.output);
  });

  const failures = results.filter((r) => r.result.status === 'fail');
  const icon = { pass: '✓', fail: '✗' };
  const summary = results.map(({ step, result }) => `${step.id}${icon[result.status]}`).join(' ');
  console.log(`\n${failures.length === 0 ? 'VERIFY PASS' : 'VERIFY FAIL'} (steps: ${summary})`);
  if (failures.length > 0) {
    console.log(`  failed: ${failures.map((f) => f.step.id).join(', ')}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
