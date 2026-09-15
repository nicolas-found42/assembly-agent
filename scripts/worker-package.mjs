#!/usr/bin/env node
// worker-package.mjs — local packaging/dry-run validation for the Worker (R09 §12.2).
//
// Compiles worker/api-chat.js exactly as a deployment would (Wrangler's own bundler) into a record of what
// would be deployed: source + configuration digests, the compiled bundle's per-file digests and a combined
// digest. It never contacts production and needs no Cloudflare credentials — `deploy --dry-run` compiles
// and runs the pre-upload checks locally, and any Cloudflare credential variable in the environment is
// removed from the child process, so a stray flag cannot authenticate. The run is rejected unless Wrangler
// reports that it exited before uploading.
//
// Flags used are the ones the installed Wrangler documents (`wrangler deploy --help`, 4.131.2):
//   --dry-run, --outdir, --config.
//
// Usage: node scripts/worker-package.mjs [--json artifacts/results/worker-package.json]
//                                       [--outdir artifacts/worker-package] [--quiet]

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECRET_NAME = 'OPENROUTER_KEY';
const CREDENTIAL_VARS = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_EMAIL',
  'CF_API_TOKEN',
  'CF_ACCOUNT_ID',
  'CLOUDFLARE_API_USER_SERVICE_KEY',
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function argOf(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fileDigest = (path) => sha256(readFileSync(path));

/** Top-level `key = "value"` entries of wrangler.toml, for the deployment record only. */
function configIdentity(configPath) {
  const text = readFileSync(configPath, 'utf8');
  const value = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(text);
    if (!m) throw new Error(`wrangler configuration is missing a top-level ${key}`);
    return m[1];
  };
  return { name: value('name'), main: value('main'), compatibilityDate: value('compatibility_date') };
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** treeDigest over `<path>  <sha256>` lines (same shape as scripts/site-inventory.mjs). */
function treeDigest(files, base) {
  return sha256(files.map((f) => `${relative(base, f)}  ${fileDigest(f)}\n`).sort().join(''));
}

/**
 * Compile the Worker without deploying it. Returns the record written by the CLI.
 * `quiet` suppresses the child's stdout passthrough (tests use it).
 */
export function packageWorker({ jsonPath, outdir, quiet } = {}) {
  const configPath = join(root, 'wrangler.toml');
  const out = resolve(outdir ?? join(root, 'artifacts/worker-package'));
  const recordPath = resolve(jsonPath ?? join(root, 'artifacts/results/worker-package.json'));
  const wranglerBin = join(root, 'node_modules', '.bin', 'wrangler');
  if (!existsSync(wranglerBin)) throw new Error(`wrangler is not installed at ${wranglerBin} — run npm ci`);

  const identity = configIdentity(configPath);
  const mainPath = resolve(root, identity.main);
  if (!mainPath.startsWith(root) || !existsSync(mainPath)) {
    throw new Error(`wrangler.toml main=${identity.main} does not resolve to a file inside the repository`);
  }

  // A previous bundle must not be able to contribute to this run's digest.
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const env = { ...process.env };
  for (const name of CREDENTIAL_VARS) delete env[name];
  // No telemetry egress, and never merge a developer's .env into the compiled configuration.
  env.WRANGLER_SEND_METRICS = 'false';
  env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';

  const args = ['deploy', '--dry-run', '--outdir', out, '--config', configPath];
  let stdout;
  try {
    stdout = execFileSync(wranglerBin, args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const detail = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    throw new Error(`wrangler deploy --dry-run failed:\n${detail || err.message}`);
  }
  if (!quiet) process.stdout.write(stdout);

  // Prove the run stopped before uploading rather than assuming it did.
  if (!/--dry-run: exiting now/.test(stdout)) {
    throw new Error('wrangler did not report a dry run — refusing to record a package from an upload path');
  }

  const bundleFiles = walk(out).filter((f) => /\.(?:js|mjs)$/.test(f) && !f.endsWith('.map'));
  if (!bundleFiles.length) throw new Error(`wrangler produced no bundle in ${out}`);

  const record = {
    schema: 'worker-package/1',
    dryRun: true,
    wrangler: execFileSync(wranglerBin, ['--version'], { cwd: root, env, encoding: 'utf8' }).trim(),
    credentialsInScope: CREDENTIAL_VARS.filter((name) => process.env[name]),
    worker: identity,
    secretNames: [SECRET_NAME],
    source: {
      path: identity.main,
      bytes: statSync(mainPath).size,
      sha256: fileDigest(mainPath),
    },
    config: { path: 'wrangler.toml', sha256: fileDigest(configPath) },
    bundle: {
      outdir: relative(root, out),
      files: bundleFiles.map((f) => ({
        path: relative(out, f),
        bytes: statSync(f).size,
        sha256: fileDigest(f),
      })),
      digest: treeDigest(bundleFiles, out),
    },
  };

  mkdirSync(dirname(recordPath), { recursive: true });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  if (!quiet) {
    console.log(`WORKER-PACKAGE ok  ${record.worker.name}  digest ${record.bundle.digest.slice(0, 16)}…`);
    console.log(`WORKER-PACKAGE source ${record.source.path} sha256 ${record.source.sha256.slice(0, 16)}…`);
    console.log(`WORKER-PACKAGE config wrangler.toml sha256 ${record.config.sha256.slice(0, 16)}…`);
    console.log('WORKER-PACKAGE no Cloudflare credentials in scope; nothing was uploaded');
    console.log(`WORKER-PACKAGE wrote ${relative(root, recordPath)}`);
  }
  return record;
}

// Only run when executed as a program (a copy under another name must still work).
// Only run when executed as a program; a renamed or symlinked copy must still work.
function isMainModule() {
  // Symlinked/renamed copies must still work: Node resolves the main module realpath, so /tmp/x.mjs
  // and /private/tmp/x.mjs have to compare equal.
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    packageWorker({ jsonPath: argOf('--json', undefined), outdir: argOf('--outdir', undefined), quiet: false });
  } catch (err) {
    console.error(`WORKER-PACKAGE FAIL: ${err.message}`);
    process.exit(1);
  }
}
