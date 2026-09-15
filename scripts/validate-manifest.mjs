#!/usr/bin/env node
/**
 * scripts/validate-manifest.mjs — test classification gate (campaign R01).
 *
 * Contract (see the campaign "Fixed contracts" in tasks/assembly-agent-ci-implementation-prompt.md):
 *   - `test/manifest.json` declares `{ version: 1, classes, entries }`.
 *   - `classes` is the frozen list below; it is not derived from the entries.
 *   - Every runnable entry point under `test/` must be listed exactly once with
 *     kind "test" (plus class + run) or kind "suite" (delegating to a tool config).
 *   - kind: test | helper | fixture | suite. `class` is required iff the kind is
 *     test or suite. `run`: node-test | script | vitest-config | playwright.
 *   - The `live` class holds operational probes. A probe (flagged `live`/`probe`)
 *     must be class "live" and must never sit in a required class
 *     (offline | worker | browser), so live discovery cannot leak into the gate.
 *   - Files under a tool-suite directory (`test/browser/**`, `test/worker/**`) are
 *     covered by that suite's manifest entry, so they are exempt from the
 *     "every .mjs must be listed" rule — but the suite entry itself must be listed
 *     once the suite exists (the runner refuses a class with zero entries).
 *
 * Enforcement:
 *   - unlisted runnable `.mjs` under test/ (excluding suite internals)  -> fail, naming the file
 *   - duplicate entries (normalized path)                               -> fail
 *   - nonexistent paths / missing tool config                           -> fail
 *   - kind/class/run mismatches and unknown run values                  -> fail
 *   - live probe in a required class                                    -> fail
 *   - node-test entry with no test/assertion construct (zero-test)      -> fail
 *   - script entry that cannot print an `ALL ... PASS` marker           -> fail
 *   - helper listed but imported by no listed test entry                -> fail
 *
 * Exit 0 and print exactly `MANIFEST OK (N tests, M helpers, K fixtures)` on success.
 * Exit 1 with one line per problem (each naming the offending path) on failure.
 *
 * Usage: `node scripts/validate-manifest.mjs [--manifest test/manifest.json]`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST_PATH = path.join(ROOT, 'test/manifest.json');

// `--manifest <path>` validates an alternate manifest (used by the campaign's
// negative tests, which must never edit the real test/manifest.json).
const manifest_flag = process.argv.indexOf('--manifest');
const ACTIVE_MANIFEST = manifest_flag === -1
  ? MANIFEST_PATH
  : path.resolve(ROOT, process.argv[manifest_flag + 1] ?? '');

// Frozen contract values (do not derive these from the manifest).
const CLASSES = ['offline', 'worker', 'browser', 'scheduled-browser', 'live'];
const REQUIRED_CLASSES = ['offline', 'worker', 'browser'];
const KINDS = ['test', 'helper', 'fixture', 'suite'];
const RUNS = ['node-test', 'script', 'vitest-config', 'playwright'];
const SUITE_RUNS = ['playwright', 'vitest-config'];
// Exempt from "every .mjs must be listed": internals of a delegated tool suite.
const SUITE_DIRS = ['test/browser', 'test/worker'];

// Same marker contract the runner enforces at runtime (see run-tests.mjs for why
// the empty qualifier is allowed: the campaign regex cannot match `ALL PASS`).
const MARKER_RE = /ALL(?: [A-Z0-9 :.-]+)? PASS/;
// Same zero-test guard the runner enforces for node --test entries.
const TEST_CONSTRUCT_RE = /\b(?:test|it|describe)\s*\(|node:assert|assert\s*[.(]/;

const problems = [];
const fail = (msg) => problems.push(msg);
const rel = (p) => path.relative(ROOT, p) || '.';
const inSuiteDir = (p) => SUITE_DIRS.some((d) => p === d || p.startsWith(`${d}/`));

function readManifest() {
  let raw;
  const label = rel(ACTIVE_MANIFEST);
  try {
    raw = readFileSync(ACTIVE_MANIFEST, 'utf8');
  } catch (error) {
    fail(`${label}: cannot read (${error.code ?? error.message})`);
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`${label}: invalid JSON (${error.message})`);
    return null;
  }
}

function normalize(p) {
  return p.replace(/\/+$/, '');
}

/** Every .mjs under test/, skipping symlinked dirs and delegated suite internals. */
function collectTestModules(dir, out = []) {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, dirent.name);
    const r = rel(abs);
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      if (inSuiteDir(r)) continue;
      collectTestModules(abs, out);
    } else if (dirent.isFile() && dirent.name.endsWith('.mjs')) {
      out.push(r);
    }
  }
  return out;
}

function resolveToolConfig(entry, tool) {
  if (typeof entry.config === 'string' && entry.config) return normalize(entry.config);
  const p = normalize(String(entry.path ?? ''));
  const abs = path.join(ROOT, p);
  const defaultName = tool === 'playwright' ? 'playwright.config.mjs' : 'vitest.config.mjs';
  if (!p.endsWith('.mjs') && existsSync(abs)) return `${p}/${defaultName}`;
  if (/\.config\.[cm]?js$/.test(p)) return p;
  return `${path.dirname(p)}/${defaultName}`;
}

function validateEntries(manifest) {
  if (!Array.isArray(manifest.entries)) {
    fail('test/manifest.json: entries must be an array');
    return { entries: [], listed: new Set() };
  }

  const entries = manifest.entries;
  const listed = new Set();
  const seen = new Map();

  entries.forEach((entry, i) => {
    const label = `entries[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`${label}: entry must be an object`);
      return;
    }
    const rawPath = entry.path;
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      fail(`${label}: missing "path"`);
      return;
    }
    if (path.isAbsolute(rawPath) || rawPath.split('/').includes('..')) {
      fail(`${rawPath}: path must be repository-relative and must not escape the repository`);
      return;
    }
    const p = normalize(rawPath);
    const where = p;
    const abs = path.join(ROOT, p);

    const key = p;
    if (seen.has(key)) {
      fail(`${where}: duplicate manifest entry (already listed as entries[${seen.get(key)}])`);
      return;
    }
    seen.set(key, i);
    // A manifest path is "listed" even if its other checks fail, so the
    // unclassified-file scan reports only genuinely missing entries.
    listed.add(p);

    const isLive = entry.live === true || entry.probe === true;
    const kind = entry.kind;
    if (!KINDS.includes(kind)) {
      fail(`${where}: unknown kind "${kind}" (expected one of ${KINDS.join(', ')})`);
      return;
    }

    if (isLive && entry.class !== 'live') {
      fail(
        `${where}: live probe must be class "live", not "${entry.class}" — operational probes are excluded from required discovery`,
      );
    }
    if (entry.class !== undefined && entry.class !== null && !CLASSES.includes(entry.class)) {
      fail(`${where}: unknown class "${entry.class}" (expected one of ${CLASSES.join(', ')})`);
      return;
    }
    if (REQUIRED_CLASSES.includes(entry.class) && isLive) {
      fail(`${where}: live probe listed in required class "${entry.class}"`);
    }

    if (kind === 'helper' || kind === 'fixture') {
      if (entry.class !== undefined && entry.class !== null) {
        fail(`${where}: kind "${kind}" must not declare a class`);
      }
      if (entry.run !== undefined && entry.run !== null) {
        fail(`${where}: kind "${kind}" must not declare a run`);
      }
      if (!existsSync(abs)) fail(`${where}: path does not exist`);
      return;
    }

    // kind === 'test' | 'suite'
    if (entry.class === undefined || entry.class === null) {
      fail(`${where}: kind "${kind}" requires a class`);
      return;
    }
    if (typeof entry.run !== 'string' || !RUNS.includes(entry.run)) {
      fail(`${where}: kind "${kind}" requires run to be one of ${RUNS.join(', ')}`);
      return;
    }
    if (kind === 'suite' && !SUITE_RUNS.includes(entry.run)) {
      fail(`${where}: suite run must be one of ${SUITE_RUNS.join(', ')} (got "${entry.run}")`);
      return;
    }
    if (kind === 'test' && !rawPath.endsWith('.mjs') && entry.run !== 'playwright') {
      fail(`${where}: test entries must point at a .mjs file`);
      return;
    }

    if (!existsSync(abs)) {
      fail(`${where}: path does not exist`);
      return;
    }
    const stats = statSync(abs);
    if (kind === 'suite' && !stats.isDirectory()) {
      fail(`${where}: kind "suite" must point at a directory`);
      return;
    }
    if (kind === 'test' && !stats.isFile()) {
      fail(`${where}: kind "test" must point at a file`);
      return;
    }

    if (entry.run === 'playwright' || entry.run === 'vitest-config') {
      const config = resolveToolConfig(entry, entry.run);
      if (!existsSync(path.join(ROOT, config))) {
        fail(`${where}: ${entry.run} config not found (expected ${config})`);
        return;
      }
    }

    if (kind === 'test') {
      const source = readFileSync(abs, 'utf8');
      if (entry.run === 'node-test' && !TEST_CONSTRUCT_RE.test(source)) {
        fail(`${where}: node-test entry contains no test or assertion construct (zero-test guard)`);
        return;
      }
      if (entry.run === 'script' && !MARKER_RE.test(source)) {
        fail(
          `${where}: script entry cannot print an "ALL ... PASS" marker — it is not a verified standalone runner (misclassified)`,
        );
        return;
      }
    }
  });

  // Helpers must actually be used by a listed entry (otherwise the classification is wrong).
  const testSources = entries
    .filter((e) => e && e.kind === 'test' && typeof e.path === 'string' && existsSync(path.join(ROOT, e.path)))
    .map((e) => readFileSync(path.join(ROOT, normalize(e.path)), 'utf8'))
    .join('\n');
  for (const entry of entries) {
    if (!entry || entry.kind !== 'helper' || typeof entry.path !== 'string') continue;
    const p = normalize(entry.path);
    const base = path.basename(p);
    if (!testSources.includes(base)) {
      fail(`${p}: kind "helper" but no listed test entry imports it (misclassified)`);
    }
  }

  return { entries, listed };
}

function findUnclassified(manifestEntries, listed) {
  const modules = collectTestModules(path.join(ROOT, 'test'));
  const listedDirs = manifestEntries
    .filter((e) => e && typeof e.path === 'string' && (e.kind === 'fixture' || e.kind === 'helper' || e.kind === 'suite'))
    .map((e) => normalize(e.path));

  for (const file of modules) {
    if (listed.has(file) || listed.has(normalize(file))) continue;
    if (listedDirs.some((d) => file === d || file.startsWith(`${d}/`))) continue;
    fail(
      `${file}: unclassified runnable test file — add it to test/manifest.json (kind "test" with class + run, or kind "helper"/"fixture")`,
    );
  }
}

const manifest = readManifest();
let counts = { tests: 0, helpers: 0, fixtures: 0 };

const manifestLabel = rel(ACTIVE_MANIFEST);
if (manifest) {
  if (manifest.version !== 1) fail(`${manifestLabel}: version must be 1 (got ${JSON.stringify(manifest.version)})`);
  if (!Array.isArray(manifest.classes) || manifest.classes.join(',') !== CLASSES.join(',')) {
    fail(`${manifestLabel}: classes must be exactly [${CLASSES.join(', ')}]`);
  }
  const { entries, listed } = validateEntries(manifest);
  findUnclassified(entries, listed);
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.kind === 'test' || entry.kind === 'suite') counts.tests += 1;
    else if (entry.kind === 'helper') counts.helpers += 1;
    else if (entry.kind === 'fixture') counts.fixtures += 1;
  }
}

if (problems.length > 0) {
  console.error(`MANIFEST FAIL (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

const classes = manifest.entries.reduce((acc, e) => {
  if (e && typeof e.class === 'string') acc.set(e.class, (acc.get(e.class) ?? 0) + 1);
  return acc;
}, new Map());
console.log(`MANIFEST OK (${counts.tests} tests, ${counts.helpers} helpers, ${counts.fixtures} fixtures)`);
console.log(`  classes: ${[...classes].map(([c, n]) => `${c}=${n}`).join(' ') || '(none)'}`);
