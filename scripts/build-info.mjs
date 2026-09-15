#!/usr/bin/env node
// build-info.mjs — deterministic build identity for the staged site (R04).
//
// Writes the build-info.json contract consumed by the site smoke checks:
//   { commit, wasmSha256, lockfileSha256,
//     toolchain: { node, wat2wasm, npm },
//     deps: { marked, dompurify, "highlight.js" } }
//
// No timestamps: identical inputs must produce byte-identical output so two
// builds of one commit compare equal. Dependency versions come from the
// lockfile (the installation of record), not from package.json ranges.
//
// Usage: node scripts/build-info.mjs [--out <file>] [--wasm <path>] [--lock <path>]

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

const outPath = resolve(arg('--out', join(repoRoot, '_site/build-info.json')));
const wasmPath = resolve(arg('--wasm', join(repoRoot, 'dist/agent.wasm')));
const lockPath = resolve(arg('--lock', join(repoRoot, 'package-lock.json')));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.trim();
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function versionOf(cmd, args = ['--version']) {
  try {
    return execFileSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const lockedVersion = (name) => lock.packages?.[`node_modules/${name}`]?.version ?? 'unknown';

const info = {
  commit: commit(),
  wasmSha256: sha256(readFileSync(wasmPath)),
  lockfileSha256: sha256(readFileSync(lockPath)),
  toolchain: {
    // Full node version (not just the major): CI pins an explicit release, so the
    // exact runtime is part of the artifact identity.
    node: process.version.replace(/^v/, ''),
    wat2wasm: versionOf(process.env.WAT2WASM || 'wat2wasm'),
    npm: versionOf(process.env.NPM || 'npm'),
  },
  deps: {
    marked: lockedVersion('marked'),
    dompurify: lockedVersion('dompurify'),
    'highlight.js': lockedVersion('@highlightjs/cdn-assets'),
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(info, null, 2)}\n`);
console.log(`BUILD-INFO wrote ${outPath}`);
