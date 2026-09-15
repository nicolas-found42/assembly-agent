#!/usr/bin/env node
// audit-policy.mjs — the vulnerability policy gate over `npm audit --json` (R03).
//
//   node scripts/audit-policy.mjs [--threshold <level>] [--offline-ok]
//                                 [--exceptions <file>] [--out <file>] [--report <file>]
//
// The gate is the campaign's answer to "a dependency scan must be a decision, not
// a report". It is reached from `npm run verify` (step 8) and `npm run audit`.
//
// Policy, in force for every run:
//
//   1. A scan that did not happen is NOT a pass. If `npm audit` cannot reach the
//      advisory service (or returns no report / an error document) the run is
//      reported as UNAVAILABLE and exits 2 — never "0 vulnerabilities". The
//      `--offline-ok` flag exists for offline triage only: it turns the exit code
//      to 0 while the artifact and the summary still say `unavailable`.
//   2. Severity threshold "high" by default (`--threshold`): a finding at or
//      above it fails unless a specific exception covers it.
//   3. A finding that reaches a RUNTIME dependency — anything staged into
//      `_site/` and served to users — fails at any severity. Dev-only tooling
//      (the Worker/WASM test toolchain) is judged by the threshold alone.
//   4. An exception is an owned, dated, specific statement about ONE advisory:
//      `scripts/audit-policy.exceptions.json` carries `{id, package, reason,
//      owner, reviewBy}` per entry. A blanket pattern/exclusion is impossible by
//      construction (the id is a GHSA id, the package is validated against the
//      package the advisory actually affects, and `reviewBy` expires the entry).
//      An exception that matches nothing in the report is reported as stale.
//
// The machine-readable result is written to `artifacts/results/audit-policy.json`;
// exit 0 = policy satisfied, 1 = policy violation or invalid exceptions,
// 2 = the advisory service was unavailable.
//
// `--report <file>` re-evaluates a captured `npm audit --json` document instead of
// contacting the registry (triage and the fault-injection harness in .scratch/ci);
// the required gate never passes it.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const rel = (path) => (path.startsWith(`${repoRoot}/`) ? path.slice(repoRoot.length + 1) : path);

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const EXCEPTION_KEYS = new Set(['id', 'package', 'reason', 'owner', 'reviewBy', 'references']);
const GHSA_ID = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const MIN_REASON = 40;

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 || !process.argv[i + 1] ? fallback : process.argv[i + 1];
}

const EXIT = { ok: 0, fail: 1, unavailable: 2 };

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node scripts/audit-policy.mjs [--threshold info|low|moderate|high|critical] [--offline-ok]');
  console.log('                                    [--exceptions <file>] [--out <file>] [--report <audit.json>]');
  process.exit(0);
}

const threshold = arg('--threshold', 'high');
if (!SEVERITIES.includes(threshold)) {
  console.error(`AUDIT POLICY FAIL: --threshold must be one of ${SEVERITIES.join('|')} (got ${threshold})`);
  process.exit(EXIT.fail);
}
const thresholdRank = SEVERITIES.indexOf(threshold);
const offlineOk = process.argv.includes('--offline-ok');
const exceptionsPath = resolve(arg('--exceptions', join(repoRoot, 'scripts/audit-policy.exceptions.json')));
const outPath = resolve(arg('--out', join(repoRoot, 'artifacts/results/audit-policy.json')));
const reportPath = arg('--report', null);
// Test/offline hook for the "unavailable registry" path; also accepted by npm itself.
const registry = process.env.AUDIT_POLICY_REGISTRY || null;

const severityRank = (severity) => {
  const rank = SEVERITIES.indexOf(severity);
  return rank === -1 ? SEVERITIES.length : rank;
};

const versionCache = new Map();
function installedVersionOf(name) {
  if (!versionCache.has(name)) {
    const manifest = join(repoRoot, 'node_modules', name, 'package.json');
    versionCache.set(name, existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).version : null);
  }
  return versionCache.get(name);
}

/** A simple x.y.z comparison, only ever used to describe npm's own fix offer. */
function compareVersions(a, b) {
  const parts = (v) => String(v).split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// ── the scan ─────────────────────────────────────────────────────────────
/** Why a document is not a usable audit report, or null when it is one. */
function reportProblem(report) {
  if (!report || typeof report !== 'object') return 'the document is not an object';
  if (report.error) {
    const { code, summary, detail } = report.error;
    const described = [code, report.message, summary, detail].filter((v) => typeof v === 'string' && v.trim() !== '').join(' — ');
    return `npm audit could not reach the advisory service: ${described || JSON.stringify(report.error)}`;
  }
  if (!report.vulnerabilities || !report.metadata) return 'the document has no vulnerability table';
  return null;
}

function scan() {
  if (reportPath) {
    const file = resolve(reportPath);
    if (!existsSync(file)) return { status: 'unavailable', reason: `--report ${file} does not exist` };
    const command = `node scripts/audit-policy.mjs --report ${rel(file)}`;
    let report;
    try {
      report = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      return { status: 'unavailable', reason: `--report ${file} is not valid JSON: ${error.message}` };
    }
    const problem = reportProblem(report);
    return problem ? { status: 'unavailable', reason: `--report ${file}: ${problem}` } : { status: 'ok', report, command, registry: null };
  }
  const argv = ['audit', '--json'];
  if (registry) argv.push('--registry', registry);
  const res = spawnSync('npm', argv, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  });
  const stdout = res.stdout ?? '';
  const stderr = (res.stderr ?? '').replace(/\s+$/, '');
  if (res.error) return { status: 'unavailable', reason: `could not run npm audit: ${res.error.message}`, detail: stderr };
  let report = null;
  try {
    report = JSON.parse(stdout);
  } catch {
    report = null;
  }
  if (!report || typeof report !== 'object') {
    const detail = (stderr.split('\n').slice(-4).join(' ') || stdout.slice(0, 300)).replace(/\s+/g, ' ').trim();
    return {
      status: 'unavailable',
      reason: `npm audit exited ${res.status} without a JSON report — the registry or advisory service was unreachable`,
      detail,
    };
  }
  const problem = reportProblem(report);
  return problem ? { status: 'unavailable', reason: problem, detail: stderr.slice(-400) || null } : { status: 'ok', report, command: `npm ${argv.join(' ')}`, registry };
}

// ── exceptions ───────────────────────────────────────────────────────────
function loadExceptions() {
  if (!existsSync(exceptionsPath)) return { entries: [], problems: [] };
  const label = rel(exceptionsPath);
  let raw;
  try {
    raw = JSON.parse(readFileSync(exceptionsPath, 'utf8'));
  } catch (error) {
    return { entries: [], problems: [`${label} is not valid JSON: ${error.message}`] };
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.exceptions) ? raw.exceptions : null;
  if (!list) return { entries: [], problems: [`${label} must be an array of exceptions or an object with an "exceptions" array`] };
  const today = new Date().toISOString().slice(0, 10);
  const entries = [];
  const problems = [];
  list.forEach((entry, i) => {
    const where = `${label} exceptions[${i}]`;
    const found = [];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${where} is not an object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!EXCEPTION_KEYS.has(key)) found.push(`${where} has unknown field "${key}" (allowed: ${[...EXCEPTION_KEYS].join(', ')})`);
    }
    if (typeof entry.id !== 'string' || !GHSA_ID.test(entry.id)) found.push(`${where}.id must be a GHSA advisory id (GHSA-xxxx-xxxx-xxxx), got ${JSON.stringify(entry.id)}`);
    if (typeof entry.package !== 'string' || entry.package.trim().length < 2) found.push(`${where}.package must name the affected npm package`);
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < MIN_REASON) found.push(`${where}.reason must justify the exception in at least ${MIN_REASON} characters (why the advisory is unreachable / why no fix exists)`);
    if (typeof entry.owner !== 'string' || entry.owner.trim().length < 2) found.push(`${where}.owner must name who answers for the exception`);
    if (typeof entry.reviewBy !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewBy) || Number.isNaN(Date.parse(entry.reviewBy))) {
      found.push(`${where}.reviewBy must be an ISO date (YYYY-MM-DD)`);
    } else if (entry.reviewBy < today) {
      found.push(`${where} expired on ${entry.reviewBy} (owner ${entry.owner}) — re-review the advisory or remove the entry`);
    }
    if (entry.references !== undefined && (!Array.isArray(entry.references) || entry.references.some((r) => typeof r !== 'string'))) {
      found.push(`${where}.references must be an array of URLs`);
    }
    problems.push(...found);
    if (found.length === 0) entries.push(entry);
  });
  return { entries, problems };
}

// ── evaluate ─────────────────────────────────────────────────────────────
const dependencies = Object.keys(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).dependencies ?? {});
const runtimeNames = new Set(dependencies);
const lockPath = join(repoRoot, 'package-lock.json');
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { packages: {} };
const lockedVersionOf = (name) => lock.packages?.[`node_modules/${name}`]?.version ?? null;

/** Every package named in an install path, so a nested runtime dep is still runtime. */
function anchorPackages(nodePath) {
  const segments = String(nodePath).split('/');
  const found = [];
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i] !== 'node_modules') continue;
    const name = segments[i + 1]?.startsWith('@') ? `${segments[i + 1]}/${segments[i + 2]}` : segments[i + 1];
    if (name) found.push(name);
  }
  return found;
}

const { entries: exceptions, problems: exceptionProblems } = loadExceptions();
const problems = [...exceptionProblems];

function writeArtifact(payload) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
}

function fail(found, extra = {}) {
  writeArtifact({
    schema: 'assembly-agent/audit-policy@1',
    status: 'fail',
    generatedAt: new Date().toISOString(),
    threshold,
    exceptionFile: rel(exceptionsPath),
    ...extra,
    problems: found,
  });
  console.error(`AUDIT POLICY FAIL — ${found.length} problem(s):`);
  for (const problem of found) console.error(`  - ${problem}`);
  process.exit(EXIT.fail);
}

if (problems.length > 0) fail(problems, { exceptions });

const scanResult = scan();

if (scanResult.status !== 'ok') {
  const status = offlineOk ? 0 : EXIT.unavailable;
  writeArtifact({
    schema: 'assembly-agent/audit-policy@1',
    status: 'unavailable',
    generatedAt: new Date().toISOString(),
    threshold,
    command: reportPath ? `--report ${rel(resolve(reportPath))}` : `npm audit --json${registry ? ` --registry ${registry}` : ''}`,
    registry,
    exceptionFile: rel(exceptionsPath),
    reason: scanResult.reason,
    detail: scanResult.detail ?? null,
    vulnerabilities: null,
  });
  console.error(`AUDIT UNAVAILABLE — ${scanResult.reason}`);
  if (scanResult.detail) console.error(`  detail: ${scanResult.detail}`);
  console.error('  vulnerabilities: UNKNOWN — an unavailable scan is not "0 vulnerabilities".');
  console.error(`  artifact: ${rel(outPath)} (status: unavailable)`);
  if (offlineOk) console.error('  --offline-ok: exit 0 for offline triage; the scan did NOT run.');
  process.exit(status);
}

const { report } = scanResult;
const vulns = report.vulnerabilities ?? {};
const metadata = report.metadata ?? {};

function resolveAdvisories(vuln, affected, seen = new Set()) {
  const advisories = [];
  for (const via of vuln.via ?? []) {
    if (typeof via === 'string') {
      const next = vulns[via];
      if (next && !seen.has(via)) {
        seen.add(via);
        advisories.push(...resolveAdvisories(next, affected, seen));
      }
      continue;
    }
    const id = String(via.url ?? '').split('/').pop();
    if (!id) continue;
    advisories.push({ id, title: via.title ?? '', url: via.url ?? null, severity: via.severity ?? vuln.severity, vulnerableRange: via.range ?? vuln.range ?? null });
    const affectedPackages = affected.get(id) ?? new Set();
    if (via.name) affectedPackages.add(via.name);
    if (via.dependency) affectedPackages.add(via.dependency);
    affected.set(id, affectedPackages);
  }
  return advisories;
}

function describeFix(vuln, installed) {
  const fix = vuln.fixAvailable;
  if (fix === false || fix === undefined || fix === null) return { kind: 'none', description: 'no fix published for the installed version' };
  if (fix === true) return { kind: 'in-range', description: 'a fix is available inside the declared range (`npm audit fix`)', package: null, version: null };
  const direction = compareVersions(fix.version, installed) < 0 ? 'downgrade' : 'upgrade';
  const major = fix.isSemVerMajor ? ' (semver-major)' : '';
  return {
    kind: direction,
    package: fix.name,
    version: fix.version,
    isSemVerMajor: Boolean(fix.isSemVerMajor),
    description: `npm offers only a ${direction} of ${fix.name} to ${fix.version}${major}`,
  };
}

const affected = new Map();
const findings = [];
for (const name of Object.keys(vulns).sort()) {
  const vuln = vulns[name];
  const advisories = resolveAdvisories(vuln, affected);
  const runtime = runtimeNames.has(name) || (vuln.nodes ?? []).some((node) => anchorPackages(node).some((pkg) => runtimeNames.has(pkg)));
  const installed = installedVersionOf(name) ?? lockedVersionOf(name) ?? 'unknown';
  findings.push({
    package: name,
    installed,
    severity: vuln.severity,
    scope: runtime ? 'runtime' : 'development',
    direct: Boolean(vuln.isDirect),
    nodes: vuln.nodes ?? [],
    advisories,
    fix: describeFix(vuln, installed),
    exceptions: [],
    disposition: null,
  });
}

// Exception coverage is by advisory id: a chain entry (npm reports the packages
// that *carry* an advisory) is excepted when every advisory at its root is.
const exceptionById = new Map(exceptions.map((entry) => [entry.id, entry]));

for (const finding of findings) {
  for (const advisory of finding.advisories) {
    const exception = exceptionById.get(advisory.id);
    if (!exception) continue;
    const actual = [...(affected.get(advisory.id) ?? new Set([finding.package]))];
    if (!actual.includes(exception.package)) {
      problems.push(`${rel(exceptionsPath)}: exception ${advisory.id} names ${exception.package} but the advisory affects ${actual.join(', ')}`);
    }
  }
}
if (problems.length > 0) fail(problems, { exceptions });

for (const finding of findings) {
  const ids = finding.advisories.map((a) => a.id);
  const applied = ids.map((id) => exceptionById.get(id)).filter(Boolean);
  if (ids.length > 0 && applied.length === ids.length) {
    finding.disposition = 'excepted';
    finding.exceptions = applied;
  } else if (finding.scope === 'runtime') {
    finding.disposition = 'fail';
  } else if (severityRank(finding.severity) >= thresholdRank) {
    finding.disposition = 'fail';
  } else {
    finding.disposition = 'below-threshold';
  }
}

const failing = findings.filter((f) => f.disposition === 'fail');
const excepted = findings.filter((f) => f.disposition === 'excepted');
const belowThreshold = findings.filter((f) => f.disposition === 'below-threshold');
const runtimeFindings = findings.filter((f) => f.scope === 'runtime');
const staleExceptions = exceptions.filter((entry) => findings.every((f) => !f.advisories.some((a) => a.id === entry.id)));

const counts = { ...(metadata.vulnerabilities ?? {}) };
const generatedAt = new Date().toISOString();

// ── human summary ────────────────────────────────────────────────────────
const short = (text, width) => (String(text).length > width ? `${String(text).slice(0, width - 1)}…` : String(text));
console.log(`AUDIT POLICY — ${scanResult.command}${scanResult.registry ? ` (registry ${scanResult.registry})` : ''}`);
console.log(`  threshold: ${threshold} · exceptions: ${rel(exceptionsPath)} · artifact: ${rel(outPath)}`);
if (findings.length === 0) {
  console.log('  no advisories reported by npm audit for this lockfile.');
} else {
  console.log(`  ${'package'.padEnd(34)}${'installed'.padEnd(12)}${'severity'.padEnd(10)}${'scope'.padEnd(13)}${'disposition'.padEnd(17)}advisory / fix`);
  for (const finding of findings) {
    const advisories = finding.advisories.length > 0
      ? finding.advisories.map((a) => a.id).join(', ')
      : `${finding.nodes.map((n) => n.split('/').pop()).join(' → ')} (chain)`;
    console.log(
      `  ${short(finding.package, 33).padEnd(34)}${short(finding.installed, 11).padEnd(12)}${finding.severity.padEnd(10)}` +
      `${finding.scope.padEnd(13)}${finding.disposition.padEnd(17)}${advisories}`,
    );
    if (finding.fix.kind !== 'none' || finding.exceptions.length > 0) {
      console.log(`  ${' '.repeat(34)}fix: ${finding.fix.description}`);
    }
  }
}
for (const entry of exceptions) {
  const state = staleExceptions.includes(entry) ? 'STALE (no finding matches it)' : 'applied';
  console.log(`  exception ${entry.id} (${entry.package}) — ${state}, owner ${entry.owner}, review by ${entry.reviewBy}`);
  console.log(`    ${entry.reason}`);
}
console.log(
  `  ${findings.length} finding(s): ${failing.length} fail, ${excepted.length} excepted, ${belowThreshold.length} below threshold; ` +
  `${runtimeFindings.length} reaching a runtime dependency`,
);
console.log(`  npm audit severity counts: ${SEVERITIES.map((s) => `${s} ${counts[s] ?? 0}`).join(', ')}`);

writeArtifact({
  schema: 'assembly-agent/audit-policy@1',
  status: failing.length === 0 ? 'ok' : 'fail',
  generatedAt,
  threshold,
  command: scanResult.command,
  registry: scanResult.registry,
  registryVersion: report.auditReportVersion ?? null,
  exceptionFile: rel(exceptionsPath),
  runtimeDependencies: dependencies,
  counts,
  summary: { findings: findings.length, failing: failing.length, excepted: excepted.length, belowThreshold: belowThreshold.length, runtimeDependenciesAffected: runtimeFindings.length },
  exceptions: exceptions.map((entry) => ({ ...entry, status: staleExceptions.includes(entry) ? 'stale' : 'applied' })),
  findings,
  problems: [],
});

if (failing.length > 0) {
  console.error(`AUDIT POLICY FAIL — ${failing.length} finding(s) at or above threshold "${threshold}" without a specific exception:`);
  for (const finding of failing) {
    const advisories = finding.advisories.length > 0 ? finding.advisories.map((a) => a.id).join(', ') : '(chain of an unresolved advisory)';
    console.error(`  - ${finding.package}@${finding.installed} (${finding.severity}, ${finding.scope}): ${advisories} — ${finding.fix.description}`);
  }
  console.error('  Fix the dependency, or add a specific, owned, dated entry to ' + rel(exceptionsPath) + '.');
  process.exit(EXIT.fail);
}

if (staleExceptions.length > 0) {
  console.warn(`AUDIT POLICY WARN — ${staleExceptions.length} exception(s) no longer match any finding; remove them: ${staleExceptions.map((e) => e.id).join(', ')}`);
}
console.log(
  `AUDIT POLICY OK — no finding at or above "${threshold}" lacks an exception; ` +
  `${runtimeFindings.length} runtime ${runtimeFindings.length === 1 ? 'dependency' : 'dependencies'} affected.`,
);
