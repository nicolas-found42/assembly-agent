#!/usr/bin/env node
/**
 * scripts/toolchain.mjs — the declared tool pins and the versions actually in
 * use (R06/R07).
 *
 *   npm run toolchain                        # report + write artifacts/results/toolchain.json
 *   node scripts/toolchain.mjs --pin node    # print one declared pin
 *   node scripts/toolchain.mjs --json <path> # write the JSON elsewhere
 *
 * The PINS below are the single declaration for workflow use. ci.yml asks for the
 * Node pin (`--pin node`) instead of restating a version, and
 * scripts/install-toolchain.sh asks for the WABT pin; no other file hard-codes
 * either value. The runner image cannot be templated into `runs-on`, so it is
 * declared here and the resolved runner is checked against it through `$ImageOS`
 * on GitHub-hosted runners.
 *
 * The report is a comparison, not an assertion: the pinned value and the resolved
 * value are both printed (and stored) so drift is visible with its evidence.
 * Exit status:
 *   * nonzero when a required tool (node, npm, wat2wasm, wasm-validate) is
 *     missing anywhere — you cannot build without them;
 *   * nonzero in CI (GITHUB_ACTIONS=true) when any pinned tool, the runner image,
 *     or the required Chromium install resolves differently from its pin;
 *   * locally a mismatch is reported and non-fatal: a developer's Node or a
 *     Homebrew WABT is not the CI pin and is not expected to be.
 *
 * `npm run toolchain` is the workflow's single source for tool/browser versions
 * (scripts/ci-summary.mjs reads the JSON it writes).
 *
 * Update procedure — change the constant, never a copy:
 *   node      https://nodejs.org/dist/index.json — newest Active LTS patch; then
 *             re-run this script and the offline suite on that exact release.
 *   wabt      https://github.com/WebAssembly/wabt/releases — newest release; add
 *             its per-platform asset digests to scripts/install-toolchain.sh.
 *   runner    actions/runner-images README — a GA Ubuntu image (preview images
 *             are excluded); keep RUNNER_IMAGE_OS in step.
 * Hosted-runner variability that remains: the image version (apt contents, the
 * preinstalled Node, browser system libraries) moves weekly within the named
 * image, so `ImageVersion` is recorded in the report rather than assumed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const PINS = {
  node: '24.21.0',
  wabt: '1.0.41',
  runnerImage: 'ubuntu-24.04',
};

// `$ImageOS` value GitHub-hosted runners export for the declared image.
const RUNNER_IMAGE_OS = { 'ubuntu-24.04': 'ubuntu24' };

// Chromium is the browser the required class is specified around; ci.yml installs
// every project the browser config declares, and a missing browser shows up as a
// suite failure. Keep this list to what the required class is specified to need.
const REQUIRED_BROWSERS = ['chromium'];
// Without these the repository cannot build or test at all.
const REQUIRED_TOOLS = ['node', 'npm', 'wat2wasm', 'wasm-validate'];

const USAGE = `usage: node scripts/toolchain.mjs [--pin <${Object.keys(PINS).join('|')}>] [--json <path>] [--help]

reports declared pins vs. resolved node/npm/WABT/Playwright/browser/Wrangler/workerd versions
and writes artifacts/results/toolchain.json (override with --json).`;

function usage(code = 0) {
  (code === 0 ? console.log : console.error)(USAGE);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { pin: null, json: join(ROOT, 'artifacts', 'results', 'toolchain.json') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pin') {
      args.pin = argv[i + 1];
      if (!args.pin) usage(2);
      i += 1;
    } else if (argv[i] === '--json') {
      args.json = resolve(argv[i + 1] ?? '');
      if (!argv[i + 1]) usage(2);
      i += 1;
    } else if (argv[i] === '--help' || argv[i] === '-h') usage(0);
    else usage(2);
  }
  return args;
}

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const firstLine = (text) => (text ? text.split(/\r?\n/)[0] : null);

function which(cmd) {
  if (cmd.includes('/')) return cmd;
  return firstLine(run('which', [cmd]));
}

function packageVersion(name) {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function packageJson(name) {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

// playwright-core/browsers.json is the launcher's own registry of the browser
// revisions it will start (playwright/browsers.json does not carry it).
function browsersJson() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
  } catch {
    return null;
  }
}

function toolVersion(command, args = ['--version']) {
  const version = firstLine(run(command, args));
  return { version: version || null, path: which(command) };
}

// Playwright browser expectations come from the installed playwright-core's
// browsers.json; "installed" is the on-disk revision directory the launcher needs.
function playwrightReport() {
  const version = packageVersion('playwright-core') ?? packageVersion('playwright');
  const browsersJsonDoc = browsersJson();
  const cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH
    || (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
      : join(homedir(), '.cache', 'ms-playwright'));
  const entries = Array.isArray(browsersJsonDoc?.browsers) ? browsersJsonDoc.browsers : [];
  const browsers = entries
    .filter((b) => b.installByDefault !== false)
    .map((b) => {
      const dirName = `${String(b.name).replace(/-/g, '_')}-${b.revision}`;
      return {
        name: b.name,
        revision: b.revision ?? null,
        browserVersion: b.browserVersion ?? null,
        required: REQUIRED_BROWSERS.includes(b.name),
        installed: existsSync(join(cacheDir, dirName)),
        dir: join(cacheDir, dirName),
      };
    });
  return { version, cacheDir, browsers };
}

const WORKERD_PLATFORM = {
  'linux-x64': 'linux-64',
  'linux-arm64': 'linux-arm64',
  'darwin-x64': 'darwin-64',
  'darwin-arm64': 'darwin-arm64',
  'win32-x64': 'windows-64',
};

function workerdReport() {
  const version = packageVersion('workerd');
  const platformKey = WORKERD_PLATFORM[`${process.platform}-${process.arch}`];
  const binaryPackage = platformKey ? `@cloudflare/workerd-${platformKey}` : null;
  const binaryVersion = binaryPackage
    ? firstLine(run(join(ROOT, 'node_modules', binaryPackage, 'bin', 'workerd'), ['--version']))?.split(/\s+/).pop() ?? null
    : null;
  return { version, binaryPackage, binaryVersion };
}

function resolveAll() {
  const node = { version: process.version.replace(/^v/, ''), execPath: process.execPath, pinned: PINS.node, match: null };
  node.match = node.version === PINS.node;

  const npm = { version: run(process.env.NPM || 'npm', ['--version']) };
  const wat2wasm = { ...toolVersion(process.env.WAT2WASM || 'wat2wasm'), pinned: PINS.wabt };
  wat2wasm.match = wat2wasm.version === PINS.wabt;
  const wasmValidate = { ...toolVersion(process.env.WASM_VALIDATE || 'wasm-validate'), pinned: PINS.wabt };
  wasmValidate.match = wasmValidate.version === PINS.wabt;

  const playwright = playwrightReport();
  const wrangler = { version: packageVersion('wrangler') };
  const workerd = workerdReport();

  const imageOS = process.env.ImageOS || null;
  const expectedImageOS = RUNNER_IMAGE_OS[PINS.runnerImage] ?? null;
  const runner = {
    imageOS,
    imageVersion: process.env.ImageVersion || null,
    pinnedImageOS: expectedImageOS,
    match: imageOS && expectedImageOS ? imageOS === expectedImageOS : null,
  };

  const resolved = { node, npm, wabt: { wat2wasm, wasmValidate }, playwright, wrangler, workerd };
  const missing = [];
  const drift = [];

  if (!node.version) missing.push('node');
  if (node.version && !node.match) drift.push(`node ${node.version} != pin ${PINS.node}`);
  if (!npm.version) missing.push('npm');
  for (const [name, tool] of [['wat2wasm', wat2wasm], ['wasm-validate', wasmValidate]]) {
    if (!tool.version) missing.push(name);
    else if (!tool.match) drift.push(`${name} ${tool.version} != pin ${PINS.wabt}`);
  }
  if (!playwright.version) drift.push('playwright is not installed (npm ci)');
  for (const browser of playwright.browsers) {
    if (browser.required && !browser.installed) drift.push(`browser ${browser.name} ${browser.revision} is not installed`);
  }
  if (wrangler.version === null) drift.push('wrangler is not installed (npm ci)');
  if (runner.match === false) drift.push(`runner image ${imageOS} != pin ${PINS.runnerImage}`);

  return { missing, drift, resolved, runner };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.pin) {
    if (!(args.pin in PINS)) usage(2);
    console.log(PINS[args.pin]);
    return;
  }

  const ci = process.env.GITHUB_ACTIONS === 'true';
  const { missing, drift, resolved, runner } = resolveAll();
  const report = {
    generatedBy: 'scripts/toolchain.mjs',
    environment: { ci, platform: process.platform, arch: process.arch },
    pins: { ...PINS, runnerImageOS: RUNNER_IMAGE_OS[PINS.runnerImage] ?? null },
    resolved,
    runner: { ...runner, expectedImageOS: RUNNER_IMAGE_OS[PINS.runnerImage] ?? null },
    requiredBrowsers: REQUIRED_BROWSERS,
    missing,
    drift,
  };

  console.log(`TOOLCHAIN ci=${ci} platform=${process.platform} arch=${process.arch}`);
  for (const [name, value] of Object.entries(PINS)) console.log(`PIN ${name} ${value}`);
  console.log(`RESOLVED node ${resolved.node.version} path=${resolved.node.execPath} pin=${PINS.node} match=${resolved.node.match}`);
  console.log(`RESOLVED npm ${resolved.npm.version ?? 'missing'}`);
  for (const [name, tool] of [['wat2wasm', resolved.wabt.wat2wasm], ['wasm-validate', resolved.wabt.wasmValidate]]) {
    console.log(`RESOLVED ${name} ${tool.version ?? 'missing'} path=${tool.path ?? 'missing'} pin=${PINS.wabt} match=${tool.match}`);
  }
  console.log(`RESOLVED playwright ${resolved.playwright.version ?? 'missing'} cache=${resolved.playwright.cacheDir}`);
  for (const b of resolved.playwright.browsers) {
    console.log(`RESOLVED browser ${b.name} revision=${b.revision} version=${b.browserVersion ?? ''} installed=${b.installed} required=${b.required}`);
  }
  console.log(`RESOLVED wrangler ${resolved.wrangler.version ?? 'missing'}`);
  console.log(`RESOLVED workerd ${resolved.workerd.version ?? 'missing'} binary=${resolved.workerd.binaryVersion ?? 'missing'}`);
  console.log(`RUNNER imageOS=${runner.imageOS ?? 'none'} imageVersion=${runner.imageVersion ?? 'none'} pin=${PINS.runnerImage} match=${runner.match ?? 'n/a'}`);

  mkdirSync(dirname(args.json), { recursive: true });
  writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`TOOLCHAIN JSON ${args.json}`);

  for (const item of missing) console.log(`TOOLCHAIN MISSING ${item}`);
  for (const item of drift) console.log(`TOOLCHAIN DRIFT ${item}`);

  const fatal = missing.length > 0 || (ci && drift.length > 0);
  console.log(`TOOLCHAIN ${fatal ? 'FAIL' : 'OK'} (missing=${missing.length} drift=${drift.length} ci=${ci})`);
  process.exit(fatal ? 1 : 0);
}

main();
