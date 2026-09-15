#!/usr/bin/env node
// serve-site.mjs — local static server for the staged production artifact (R02/R04).
//
//   node scripts/serve-site.mjs [--root _site] [--base /assembly-agent] [--port 0]
//
// Contract:
//   * binds 127.0.0.1 only;
//   * prints exactly `READY http://127.0.0.1:<port>/assembly-agent/` once serving;
//   * a requested port that is already taken is a hard failure — the server never
//     silently reuses (or falls back to) another process's port;
//   * serves files only below --root and only under --base; anything else is 404,
//     directories are never listed, symlinks and traversal are refused;
//   * application/wasm for .wasm;
//   * SIGTERM/SIGINT close the listener and exit cleanly.

import { createServer } from 'node:http';
import { createReadStream, statSync, realpathSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node scripts/serve-site.mjs [--root _site] [--base /assembly-agent] [--port 0]');
  process.exit(0);
}

const rootArg = arg('--root', '_site');
let root;
try {
  root = realpathSync(resolve(repoRoot, rootArg));
} catch {
  console.error(`serve-site: root not found: ${resolve(repoRoot, rootArg)} (build it with \`npm run build\`)`);
  process.exit(1);
}
if (!statSync(root).isDirectory()) {
  console.error(`serve-site: --root must be a directory, got ${root}`);
  process.exit(1);
}

const rawBase = arg('--base', '/assembly-agent').trim();
if (!rawBase.startsWith('/') || rawBase.includes('..')) {
  console.error(`serve-site: --base must be an absolute path without "..", got "${rawBase}"`);
  process.exit(2);
}
const base = rawBase === '/' ? '' : rawBase.replace(/\/+$/, '');

const port = Number(arg('--port', '0'));
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`serve-site: --port must be an integer in 0..65535, got "${arg('--port', '0')}"`);
  process.exit(2);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function fail(res, code, message) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`${code} ${message}\n`);
}

/** Map a request path to a file below root, or null when it must not be served. */
function resolveRequest(urlPath) {
  if (!urlPath.startsWith(base + '/') && urlPath !== base && urlPath !== `${base}/`) return null;

  let rel;
  try {
    rel = decodeURIComponent(urlPath.slice(base.length));
  } catch {
    return null; // malformed percent-encoding
  }
  if (rel.includes('\0') || rel.includes('\\')) return null;

  const segments = rel.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) return null;
  if (!segments.length) segments.push('index.html');

  const abs = resolve(root, ...segments);
  if (abs !== root && !abs.startsWith(root + sep)) return null;

  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return null; // never follow links out of the artifact
  if (st.isDirectory()) return null;

  // Belt and braces: the real path must still live under the real root.
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    return null;
  }
  if (real !== root && !real.startsWith(root + sep)) return null;
  return real;
}

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 method not allowed\n');
    return;
  }

  const urlPath = (req.url || '/').split('?')[0].split('#')[0];
  const file = urlPath.startsWith(base) || base === '' ? resolveRequest(urlPath) : null;
  if (!file) {
    fail(res, 404, 'not found');
    return;
  }

  let size;
  try {
    size = statSync(file).size;
  } catch {
    fail(res, 404, 'not found');
    return;
  }

  const ext = file.slice(file.lastIndexOf('.'));
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': String(size),
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`serve-site: port ${port} is already in use — refusing to reuse another server`);
  } else {
    console.error(`serve-site: ${err.message}`);
  }
  process.exit(1);
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
  void signal;
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(port, '127.0.0.1', () => {
  console.log(`READY http://127.0.0.1:${server.address().port}${base}/`);
});
