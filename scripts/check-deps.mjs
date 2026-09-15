#!/usr/bin/env node
// check-deps.mjs — the dependency-lock / vendoring consistency check (R03).
//
//   node scripts/check-deps.mjs [--site <dir>] [--vendor-map <file>]
//
// A runtime dependency can drift from the lockfile in five different places, and
// each one has its own failure mode. This check connects them in one run:
//
//   1. package.json "dependencies" vs package-lock.json — every runtime
//      dependency is resolved in the lockfile and installed at the locked version.
//   2. the staged site vs that lockfile — _site/build-info.json must name THIS
//      lockfile and the locked versions of the three staged libraries, so a stale
//      _site/ cannot be tested and promoted as if it were current.
//   3. _site/vendor/** and _site/assets/fonts/** vs the installed packages — the
//      <src>:<dst> VENDOR_MAP in scripts/build-site.sh is the single source of
//      truth, and every staged byte must equal the byte inside the package the
//      lockfile installed. A staged file whose source package is not a declared
//      runtime dependency fails as an undeclared runtime dependency.
//   4. index.html and styles.css vs the staged assets — the page may reference no
//      external origin, must reference exactly the staged vendor/font assets, and
//      must carry no hard-coded library version (versions live in the lockfile).
//   5. THIRD_PARTY_NOTICES.md vs the vendored packages — every staged library and
//      font has a section naming its upstream package, installed version and
//      license.
//
// Failures are collected and printed per class; the process exits 1 if any were
// found. A missing staged site is a single "run `npm run build` first" message.
//
// Flags:
//   --site <dir>         staged site to inspect (default: <repo>/_site)
//   --vendor-map <file>  read the map from this file instead of
//                        scripts/build-site.sh. A file without the VENDOR_MAP
//                        heredoc is taken as the map itself. Used by the
//                        fault-injection drills (see §6 of docs/ci-campaign-report.md).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 || !process.argv[i + 1] ? fallback : process.argv[i + 1];
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node scripts/check-deps.mjs [--site <dir>] [--vendor-map <file>]');
  process.exit(0);
}

const siteDir = resolve(arg('--site', join(repoRoot, '_site')));
const mapPath = resolve(arg('--vendor-map', join(repoRoot, 'scripts/build-site.sh')));

const problems = [];
const fail = (message) => problems.push(message);
const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const relRepo = (path) => path.startsWith(`${repoRoot}/`) ? path.slice(repoRoot.length + 1) : path;

/** Every file below root, as site-relative paths. */
function walkFiles(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(join(root, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** The vendored `<source under node_modules>:<staged path>` map. */
function readVendorMap(path) {
  if (!existsSync(path)) {
    console.error(`CHECK-DEPS FAIL: vendor map not found at ${relRepo(path)}`);
    process.exit(1);
  }
  const text = readFileSync(path, 'utf8');
  const heredoc = text.match(/VENDOR_MAP=\$\(cat <<'EOF'\n([\s\S]*?)\nEOF\n\)/);
  const body = heredoc ? heredoc[1] : text;
  if (!heredoc && !/node_modules\//.test(text)) {
    console.error(`CHECK-DEPS FAIL: cannot find VENDOR_MAP in ${relRepo(path)}`);
    process.exit(1);
  }
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const cut = line.indexOf(':');
      return { src: line.slice(0, cut), dst: line.slice(cut + 1) };
    });
}

/** `node_modules/@scope/pkg/lib/x.js` -> `@scope/pkg`. */
function packageOf(src) {
  const parts = src.split('/');
  if (parts[0] !== 'node_modules') return null;
  return parts[1].startsWith('@') ? `${parts[1]}/${parts[2]}` : parts[1];
}

/** `## <title>` sections of a Markdown file, ignoring headings inside ````` fences. */
function markdownSections(text) {
  const sections = [];
  let current = null;
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^`{4,}/.test(line)) fenced = !fenced;
    const heading = fenced ? null : line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = { title: heading[1], body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }
  return sections.map((s) => ({ title: s.title, body: s.body.join('\n') }));
}

/** SPDX id -> the strings a notice section may use to name that license. */
const LICENSE_ALIASES = {
  'MIT': ['MIT'],
  'MPL-2.0': ['MPL-2.0', 'Mozilla Public License'],
  'Apache-2.0': ['Apache-2.0', 'Apache License'],
  'BSD-3-Clause': ['BSD-3-Clause', 'BSD 3-Clause'],
  'OFL-1.1': ['OFL-1.1', 'SIL Open Font License'],
  'ISC': ['ISC'],
};

// A single library version literal must never live in the page: versions come
// from package-lock.json, so a copy in index.html is drift waiting to happen.
const VERSION_PATTERNS = [
  [/\b\d+\.\d+\.\d+\b/g, 'a hard-coded version literal'],
  [/[?&#](?:v|version)=\d+(?:\.\d+)*/gi, 'a version query/fragment on an asset reference'],
  [/\b[A-Za-z][\w.-]*@\d+\.\d+/g, 'a package@version reference'],
];

// ── 0. the staged site must exist before anything else is diagnosable ────
if (!existsSync(join(siteDir, 'index.html'))) {
  console.error(`CHECK-DEPS FAIL: no staged site at ${relRepo(siteDir)} — run \`npm run build\` first.`);
  process.exit(1);
}

const pkgPath = join(repoRoot, 'package.json');
const lockPath = join(repoRoot, 'package-lock.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const dependencies = pkg.dependencies ?? {};
const devDependencies = pkg.devDependencies ?? {};
let lock = null;
if (!existsSync(lockPath)) fail('package-lock.json is missing');
else lock = JSON.parse(readFileSync(lockPath, 'utf8'));

const lockedVersion = (name) => lock?.packages?.[`node_modules/${name}`]?.version ?? null;
const installedPath = (name) => join(repoRoot, 'node_modules', name, 'package.json');
const installedManifest = (name) => (existsSync(installedPath(name)) ? JSON.parse(readFileSync(installedPath(name), 'utf8')) : null);
const installedVersion = (name) => installedManifest(name)?.version ?? null;
const installedLicense = (name) => installedManifest(name)?.license ?? null;

// ── 1. package.json "dependencies" vs the lockfile and node_modules ──────
if (lock && Object.keys(dependencies).length === 0) fail('package.json declares no runtime dependencies (the staged site vendors three libraries)');
for (const name of Object.keys(dependencies).sort()) {
  const locked = lockedVersion(name);
  if (!locked) {
    fail(`runtime dependency ${name} is declared in package.json but not resolved in package-lock.json`);
    continue;
  }
  const installed = installedVersion(name);
  if (installed === null) fail(`${name} is not installed in node_modules (run npm ci)`);
  else if (installed !== locked) fail(`${name}: node_modules has ${installed} but the lockfile locks ${locked} (run npm ci)`);
}

// ── 2. the staged site must be the artifact of THIS lockfile ─────────────
const infoPath = join(siteDir, 'build-info.json');
if (!existsSync(infoPath)) {
  fail(`build-info.json is missing from ${relRepo(siteDir)} — run \`npm run build\` first`);
} else {
  const info = JSON.parse(readFileSync(infoPath, 'utf8'));
  const lockDigest = existsSync(lockPath) ? sha256File(lockPath) : null;
  if (lockDigest && info.lockfileSha256 !== lockDigest) {
    fail(`the staged site was built from a different lockfile (build-info ${String(info.lockfileSha256).slice(0, 12)}… vs ${lockDigest.slice(0, 12)}…) — run \`npm run build\``);
  }
  const recorded = { marked: 'marked', dompurify: 'dompurify', 'highlight.js': '@highlightjs/cdn-assets' };
  for (const [key, name] of Object.entries(recorded)) {
    const locked = lockedVersion(name);
    if (info.deps?.[key] === undefined) fail(`build-info.json does not record deps.${key} for ${name}`);
    else if (locked && info.deps[key] !== locked) fail(`build-info.json records ${key} ${info.deps[key]} but the lockfile locks ${name}@${locked} (stale \`_site\`, run \`npm run build\`)`);
  }
}

// ── 3. staged vendor bytes vs the installed packages ─────────────────────
const vendorMap = readVendorMap(mapPath);
const stagedPaths = new Set();
const noticesPackages = new Map();

for (const { src, dst } of vendorMap) {
  if (!src || !dst) {
    fail(`malformed vendor map entry: "${src}:${dst}"`);
    continue;
  }
  if (stagedPaths.has(dst)) fail(`duplicate staged path in the vendor map: ${dst}`);
  stagedPaths.add(dst);

  const name = packageOf(src);
  if (!name) {
    fail(`vendored source is not an installed package path: ${src}`);
  } else if (!(name in dependencies)) {
    const where = name in devDependencies ? ' (it is only a devDependency)' : '';
    fail(`undeclared runtime dependency: ${dst} is staged from ${name}, which is not in package.json "dependencies"${where}`);
  } else if (!noticesPackages.has(name)) {
    const version = installedVersion(name);
    noticesPackages.set(name, version ?? lockedVersion(name) ?? 'unknown');
  }

  const absSrc = join(repoRoot, src);
  const absDst = join(siteDir, dst);
  if (!existsSync(absSrc)) {
    fail(`required vendored source is missing: ${src} (run npm ci)`);
    continue;
  }
  if (!existsSync(absDst)) {
    fail(`missing staged vendored file: ${dst} — the vendor map stages it but it is not in ${relRepo(siteDir)} (run \`npm run build\`)`);
    continue;
  }
  const [srcDigest, dstDigest] = [sha256File(absSrc), sha256File(absDst)];
  if (srcDigest !== dstDigest) {
    fail(`vendored bytes differ from the installed package: ${dst} (${dstDigest.slice(0, 12)}… vs ${src} ${srcDigest.slice(0, 12)}…)`);
  }
}

for (const dir of ['vendor', 'assets']) {
  const abs = join(siteDir, dir);
  if (!existsSync(abs)) continue;
  for (const file of walkFiles(abs)) {
    const staged = `${dir}/${file}`;
    if (!stagedPaths.has(staged)) fail(`unexpected file in the staged site: ${staged} (not declared by the vendor map)`);
  }
}

// ── 4. index.html / styles.css vs the staged assets ──────────────────────
const htmlPath = join(siteDir, 'index.html');
const cssPath = join(siteDir, 'styles.css');
const html = readFileSync(htmlPath, 'utf8');
const htmlLines = html.split('\n');

for (const [i, line] of htmlLines.entries()) {
  if (/https?:\/\//.test(line) || /(?:src|href)\s*=\s*["']\/\//i.test(line)) {
    fail(`index.html:${i + 1} references an external origin: ${line.trim()}`);
  }
}

const referenced = new Set();
for (const match of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
  const raw = match[1];
  const local = raw.replace(/[?#].*$/, '').replace(/^\.\//, '');
  referenced.add(local);
  if (!existsSync(join(siteDir, local))) fail(`index.html references ${raw}, which is not in the staged site`);
}
for (const match of html.matchAll(/["']\.\/([\w./-]+\.js)["']/g)) {
  const local = match[1];
  referenced.add(local);
  if (!existsSync(join(siteDir, local))) fail(`index.html imports ./${local}, which is not in the staged site`);
}
for (const dst of stagedPaths) {
  if (dst.startsWith('vendor/') && !referenced.has(dst)) fail(`staged vendored asset is not referenced by index.html: ${dst}`);
}

for (const [i, line] of htmlLines.entries()) {
  const found = new Set();
  for (const [re, what] of VERSION_PATTERNS) {
    for (const match of line.matchAll(re)) found.add(`${match[0]} (${what})`);
  }
  if (found.size > 0) fail(`index.html:${i + 1} hard-codes a library version: ${[...found].join(', ')} — versions live in package-lock.json`);
}

const cssReferenced = new Set();
if (!existsSync(cssPath)) {
  fail('styles.css is missing from the staged site');
} else {
  const css = readFileSync(cssPath, 'utf8');
  const cssLines = css.split('\n');
  for (const [i, line] of cssLines.entries()) {
    if (/https?:\/\//.test(line) || /url\(\s*["']?\/\//.test(line)) fail(`styles.css:${i + 1} references an external origin: ${line.trim()}`);
  }
  for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    const local = match[1].replace(/[?#].*$/, '').replace(/^\.\//, '');
    cssReferenced.add(local);
    if (/^[a-z]+:/i.test(local)) continue;
    if (!existsSync(join(siteDir, local))) fail(`styles.css references ${match[1]}, which is not in the staged site`);
  }
  for (const dst of stagedPaths) {
    if (dst.startsWith('assets/fonts/') && !cssReferenced.has(dst)) fail(`staged font is not referenced by styles.css: ${dst}`);
  }
}

// ── 5. THIRD_PARTY_NOTICES.md covers every vendored package ──────────────
const noticesPaths = [join(siteDir, 'THIRD_PARTY_NOTICES.md')];
const sourceNotices = join(repoRoot, 'THIRD_PARTY_NOTICES.md');
if (existsSync(sourceNotices)) noticesPaths.push(sourceNotices);

for (const noticesPath of noticesPaths) {
  const label = relRepo(noticesPath);
  if (!existsSync(noticesPath)) {
    fail(`${label} is missing (the staged site must state the licenses of what it redistributes)`);
    continue;
  }
  const sections = markdownSections(readFileSync(noticesPath, 'utf8'));
  for (const [name, version] of noticesPackages) {
    const own = sections.filter((s) => `${s.title}\n${s.body}`.includes(`npmjs.com/package/${name}`));
    if (own.length === 0) {
      fail(`${label} has no notice section for ${name}@${version} (expected an upstream URL https://www.npmjs.com/package/${name})`);
      continue;
    }
    const body = own.map((s) => `${s.title}\n${s.body}`).join('\n');
    if (!body.includes(version)) fail(`${label} names ${name} but not the installed version ${version}`);
    const license = installedLicense(name);
    const tokens = String(license ?? '').replace(/[()]/g, ' ').split(/\s+(?:OR|AND)\s+/i).map((t) => t.trim()).filter(Boolean);
    const named = tokens.length > 0 && tokens.some((token) => (LICENSE_ALIASES[token] ?? [token]).some((alias) => body.includes(alias)));
    if (!named) fail(`${label} does not state the license (${license ?? 'undeclared'}) of ${name}@${version}`);
    const text = own.map((s) => s.body.replace(/^```+.*$/gm, '')).join('\n').replace(/\s+/g, ' ').trim();
    if (text.length < 200) fail(`${label} carries no license text for ${name}@${version}`);
  }
}

// ── verdict ──────────────────────────────────────────────────────────────
if (problems.length > 0) {
  console.error(`CHECK-DEPS FAIL (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const stagedCount = [...stagedPaths].length;
const lockName = `package-lock.json (${String(lock?.lockfileVersion)})`;
console.log(
  `CHECK-DEPS OK — ${Object.keys(dependencies).length} runtime dependencies locked in ${lockName}, ` +
  `${stagedCount} staged asset${stagedCount === 1 ? '' : 's'} byte-identical to node_modules, ` +
  `index.html self-hosted with no version literals, ${noticesPackages.size} notice section(s) complete`,
);
