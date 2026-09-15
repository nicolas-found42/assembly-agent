#!/usr/bin/env node
// site-inventory.mjs — sorted per-file digests + one tree digest (R04).
//
//   node scripts/site-inventory.mjs --write  [_site] [--out artifacts/site-inventory.json]
//   node scripts/site-inventory.mjs --verify [_site] [--in  artifacts/site-inventory.json]
//
// The inventory lives OUTSIDE the site directory so the digest has no
// self-reference. treeDigest = sha256 of the sorted "<path>  <sha256>\n" lines,
// so it is stable across machines and rebuilds of identical inputs.
//
// --verify recomputes the tree and compares it with the recorded inventory, and
// (when the site carries build-info.json) also re-checks that the staged WASM
// bytes are the ones the build reported. Any byte changed after testing — the
// promotion guard in R04 — fails here.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

const mode = process.argv.includes('--verify') ? 'verify' : process.argv.includes('--write') ? 'write' : null;
if (!mode) {
  console.error('usage: node scripts/site-inventory.mjs (--write|--verify) [siteDir] [--out|--in <inventory.json>]');
  process.exit(2);
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
// Drop flag values that were passed positionally (e.g. `--out artifacts/x.json`).
const siteDir = resolve(positional.find((a) => !a.endsWith('.json')) || join(repoRoot, '_site'));
const invPath = resolve(
  mode === 'write'
    ? arg('--out', join(repoRoot, 'artifacts/site-inventory.json'))
    : arg('--in', join(repoRoot, 'artifacts/site-inventory.json')),
);

/** Walk every file below root; refuse symlinks and non-regular entries. */
function walk(root) {
  const files = [];
  const problems = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        problems.push(`symlink in artifact tree: ${rel}`);
      } else if (st.isDirectory()) {
        visit(abs);
      } else if (st.isFile()) {
        files.push({ path: rel, sha256: sha256(readFileSync(abs)), bytes: st.size });
      } else {
        problems.push(`irregular file in artifact tree: ${rel}`);
      }
    }
  };
  visit(root);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, problems };
}

function treeDigest(files) {
  return sha256(files.map((f) => `${f.path}  ${f.sha256}\n`).join(''));
}

if (!existsSync(siteDir)) {
  console.error(`INVENTORY FAIL: site directory does not exist: ${siteDir}`);
  process.exit(1);
}

const { files, problems } = walk(siteDir);
if (problems.length) {
  for (const p of problems) console.error(`INVENTORY FAIL: ${p}`);
  process.exit(1);
}
const digest = treeDigest(files);
const totalBytes = files.reduce((n, f) => n + f.bytes, 0);

if (mode === 'write') {
  mkdirSync(dirname(invPath), { recursive: true });
  writeFileSync(invPath, `${JSON.stringify({ files, treeDigest: digest }, null, 2)}\n`);
  console.log(`INVENTORY wrote ${invPath} (${files.length} files, ${totalBytes} bytes, tree sha256:${digest})`);
  process.exit(0);
}

// ── verify ──────────────────────────────────────────────────────────────
if (!existsSync(invPath)) {
  console.error(`INVENTORY FAIL: recorded inventory not found: ${invPath} (run --write during the build)`);
  process.exit(1);
}

const recorded = JSON.parse(readFileSync(invPath, 'utf8'));
const failures = [];

const recordedByPath = new Map((recorded.files || []).map((f) => [f.path, f]));
const currentByPath = new Map(files.map((f) => [f.path, f]));

for (const f of recorded.files || []) {
  const now = currentByPath.get(f.path);
  if (!now) failures.push(`missing from site: ${f.path}`);
  else if (now.sha256 !== f.sha256) failures.push(`content changed after build: ${f.path}`);
  else if (now.bytes !== f.bytes) failures.push(`size changed after build: ${f.path}`);
}
for (const f of files) {
  if (!recordedByPath.has(f.path)) failures.push(`unexpected file in site: ${f.path}`);
}
if (recorded.treeDigest !== digest) failures.push(`tree digest mismatch: recorded ${recorded.treeDigest}, recomputed ${digest}`);

// The staged WASM must still be the bytes build-info.json reported.
const infoPath = join(siteDir, 'build-info.json');
if (existsSync(infoPath)) {
  const wasm = currentByPath.get('dist/agent.wasm');
  const reported = JSON.parse(readFileSync(infoPath, 'utf8')).wasmSha256;
  if (!wasm) failures.push('dist/agent.wasm is missing from the site');
  else if (wasm.sha256 !== reported) failures.push(`dist/agent.wasm does not match build-info.json wasmSha256 (${wasm.sha256} != ${reported})`);
}

if (failures.length) {
  console.error(`INVENTORY FAIL (${siteDir})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`INVENTORY OK (${files.length} files, ${totalBytes} bytes, tree sha256:${digest})`);
