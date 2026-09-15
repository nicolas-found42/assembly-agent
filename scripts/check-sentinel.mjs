#!/usr/bin/env node
// check-sentinel.mjs — retained-output secret scan (R07).
//
//   node scripts/check-sentinel.mjs [root ...]
//
// The CI gate keeps reports, traces, screenshots and the staged site. This scan
// reads them back and fails when a retained line carries secret-shaped text:
//
//   * the campaign sentinel `SYNTHETIC-SECRET-SENTINEL-9f3c1a` (or its stem), or
//   * an `sk-or-v1-…` key-shaped string that is not the declared dummy.
//
// Roots default to `artifacts/`, `test-results/` and `_site/`; extra roots may
// be given as arguments (resolved against the working directory). A root that
// does not exist is "nothing to scan", not a failure — a developer machine may
// not have run the suite yet, and CI has no `test-results/` on a green run.
//
// One finding is expected rather than pathological: a *failing* browser run
// retains its traces and error contexts under `test-results/`, and Playwright
// writes the failing spec's own source into the trace — including the sentinel
// literal `test/browser/leak.spec.mjs` declares by design. A red browser class
// can therefore add a sentinel finding that quotes the spec instead of leaking
// anything. It is reported, not filtered: the literal really is retained, the
// class summary is written before this scan runs, and that class is already red,
// so the line states a cause rather than creating one. Retained traces outlive
// the run that wrote them, so a finding labelled with a trace on an otherwise
// green tree means the artifact belongs to an earlier failing run.
//
// ZIP archives (`.zip`, which is what a Playwright trace is) are opened with
// Node built-ins only: the end-of-central-directory record, the central
// directory, and each member — `zlib.inflateRawSync` for deflate (method 8),
// the stored bytes for method 0. Encrypted, ZIP64, unsupported-method and
// oversized members, and archives whose directory cannot be parsed, are
// reported line by line: coverage is never silently reduced.
//
// Coverage is accounted per root, so a reader can tell "nothing found" from
// "nothing looked at": scanned files (and archive members), what was not
// scanned and why (binary, oversized, symlink, excluded directory) and what was
// refused. Exits: 0 clean, 1 finding(s), 2 the scan could not complete (bad
// usage, an unreadable root/directory/file, or a retained archive that could
// not be inspected) — an incomplete scan never reads as clean.
//
// The walk is bounded: `node_modules/` and `.git/` are never descended into,
// symlinks are skipped instead of followed (so nothing outside a root is read),
// a plain file above 32 MiB is not read at all, and an archive member above
// 16 MiB is not inflated (`maxOutputLength` also rejects a lying header).

import { readdir, readFile, stat } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The synthetic secret every retained-output check is about (R07). */
const SENTINEL = 'SYNTHETIC-SECRET-SENTINEL-9f3c1a';
/** The stem alone is still the secret leaving the test boundary. */
const SENTINEL_STEM = 'SYNTHETIC-SECRET-SENTINEL';
/** The one dummy key the repo declares for tests (test/worker/chat.test.mjs,
 *  test/worker/vitest.config.mjs) — legitimate, so it is not a finding. */
const DECLARED_DUMMY = 'sk-or-v1-test-dummy-key-not-real';
/** `sk-or-v1-` + a key body: OpenRouter's own shape. */
const KEY_RE = /\bsk-or-v1-[A-Za-z0-9_-]{8,}\b/g;

const DEFAULT_ROOTS = ['artifacts', 'test-results', '_site'];
/** Never descend into these directory names, wherever they appear. */
const EXCLUDED_DIRS = new Set(['node_modules', '.git']);
/** Above this size a plain file is not read at all. */
const PLAIN_MAX_BYTES = 32 * 1024 * 1024;
/** Above this size an archive member is not inflated. */
const MEMBER_MAX_BYTES = 16 * 1024 * 1024;
/** Reported excerpt width per finding. */
const EXCERPT = 160;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const usage = (code = 0) => {
  (code === 0 ? console.log : console.error)(
    `usage: node scripts/check-sentinel.mjs [root ...]\n\n`
    + `  default roots: ${DEFAULT_ROOTS.join(', ')} (relative to the repository root)\n`
    + `  extra roots are added to the defaults and resolved against the working directory\n`
    + `  exit 0 clean · 1 sentinel or foreign sk-or-v1-… key retained · 2 the scan could not complete`,
  );
  process.exit(code);
};

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) usage(0);
if (argv.some((a) => a.startsWith('-'))) usage(2);

const roots = [
  ...DEFAULT_ROOTS.map((r) => join(ROOT, r)),
  ...argv.map((a) => resolve(a)),
];

const findings = [];    // { label, line, kind, excerpt } — secret-shaped text
const refused = [];     // { label, reason } — retained bytes that were not inspected
const unreadable = [];  // { label, reason } — the scan could not complete here

const totals = { files: 0, members: 0, archives: 0, notScanned: 0, refused: 0 };

/** Per-root coverage accounting. */
const makeStats = (root) => ({
  label: root.startsWith(ROOT + sep) ? relative(ROOT, root) : root,
  scanned: 0, members: 0, archives: 0, missing: false,
  kinds: { binary: 0, oversized: 0, symlink: 0, excluded: 0, vanished: 0, refused: 0, unreadable: 0 },
});
const statsFor = new Map(roots.map((root) => [root, makeStats(root)]));

// ── text scanning ───────────────────────────────────────────────────────
/** A bounded window around the match, so a minified vendor line stays readable. */
function excerpt(line) {
  const at = Math.min(
    ...[SENTINEL_STEM, 'sk-or-v1-'].map((n) => {
      const i = line.indexOf(n);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    }),
  );
  const start = at === Number.MAX_SAFE_INTEGER ? 0 : Math.max(0, at - 40);
  const text = line.slice(start, start + EXCERPT).trim();
  return `${start > 0 ? '…' : ''}${text}${start + EXCERPT < line.length ? '…' : ''}`;
}

/** Record every secret-shaped line of one decoded text (label = file or member). */
function scanText(text, label) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, '');
    if (line.includes(SENTINEL_STEM)) {
      findings.push({ label, line: i + 1, kind: 'synthetic sentinel', excerpt: excerpt(line) });
      continue;
    }
    for (const [match] of line.matchAll(KEY_RE)) {
      if (match === DECLARED_DUMMY) continue;  // the declared dummy is not a secret
      findings.push({ label, line: i + 1, kind: 'key-shaped string', excerpt: excerpt(line) });
      break;
    }
  }
}

// ── ZIP archives (Node built-ins only) ──────────────────────────────────
/**
 * Walk the central directory. Returns either `{ error }` (the archive cannot be
 * inspected as a whole) or `{ members, refusals }`; a member that cannot be
 * decoded is reported in `refusals` instead of being dropped.
 */
function parseZip(buf) {
  const first = Math.max(0, buf.length - (22 + 0xffff));  // the comment is at most 64 KiB
  let eocd = -1;
  for (let i = buf.length - 22; i >= first; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return { error: 'no end-of-central-directory record' };

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return { error: 'ZIP64 archive (the central directory is described by ZIP64 records)' };
  }
  if (cdOffset + cdSize > buf.length) return { error: 'the central directory runs past the end of the file' };

  const members = [];
  const refusals = [];
  let at = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL_SIG) {
      return { error: `central directory entry ${i + 1} of ${count} is malformed` };
    }
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const localOffset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;                                  // directory entry
    if (flags & 0x1) { refusals.push({ name, reason: 'encrypted member' }); continue; }
    if (compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      refusals.push({ name, reason: 'ZIP64 member' });
      continue;
    }
    if (method !== 0 && method !== 8) {
      refusals.push({ name, reason: `unsupported compression method ${method}` });
      continue;
    }
    if (size > MEMBER_MAX_BYTES) {
      refusals.push({ name, reason: `member is ${(size / 1048576).toFixed(1)} MiB, over the 16 MiB scan bound` });
      continue;
    }
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      refusals.push({ name, reason: 'malformed local header' });
      continue;
    }
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (start + compressed > buf.length) {
      refusals.push({ name, reason: 'member data runs past the end of the file' });
      continue;
    }
    members.push({ name, method, start, compressed });
  }
  return { members, refusals };
}

/** Decoded bytes of one member, or an Error to report as a refusal. */
function readMember(buf, member) {
  const raw = buf.subarray(member.start, member.start + member.compressed);
  if (member.method === 0) return raw;
  try {
    return inflateRawSync(raw, { maxOutputLength: MEMBER_MAX_BYTES });
  } catch (err) {
    throw new Error(err?.code === 'ERR_BUFFER_TOO_LARGE' || err?.code === 'ERR_OUT_OF_RANGE'
      ? 'inflates past the 16 MiB scan bound'
      : `cannot inflate (${err?.code || err?.message})`);
  }
}

function scanZip(buf, label, stats) {
  const zip = parseZip(buf);
  if (zip.error) {
    refused.push({ label, reason: zip.error });
    stats.kinds.refused += 1;
    return;
  }
  stats.archives += 1;
  totals.archives += 1;
  for (const member of zip.members) {
    let data;
    try {
      data = readMember(buf, member);
    } catch (err) {
      refused.push({ label: `${label}!${member.name}`, reason: String(err.message || err) });
      stats.kinds.refused += 1;
      continue;
    }
    stats.members += 1;
    totals.members += 1;
    // Decoded as text either way: ASCII runs survive UTF-8 replacement, so a
    // key-shaped string inside a binary member is still found.
    scanText(data.toString('utf8'), `${label}!${member.name}`);
  }
  for (const refusal of zip.refusals) {
    refused.push({ label: `${label}!${refusal.name}`, reason: refusal.reason });
    stats.kinds.refused += 1;
  }
}

// ── files ───────────────────────────────────────────────────────────────
async function scanFile(path, label, stats) {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    if (err?.code === 'ENOENT') { stats.kinds.vanished += 1; return; }
    unreadable.push({ label, reason: String(err?.code || err?.message) });
    stats.kinds.unreadable += 1;
    return;
  }
  if (info.size > PLAIN_MAX_BYTES) { stats.kinds.oversized += 1; return; }
  let buf;
  try {
    buf = await readFile(path);
  } catch (err) {
    if (err?.code === 'ENOENT') { stats.kinds.vanished += 1; return; }
    unreadable.push({ label, reason: String(err?.code || err?.message) });
    stats.kinds.unreadable += 1;
    return;
  }
  if (path.endsWith('.zip')) { scanZip(buf, label, stats); return; }
  if (buf.indexOf(0) !== -1) { stats.kinds.binary += 1; return; }
  stats.scanned += 1;
  totals.files += 1;
  scanText(buf.toString('utf8'), label);
}

/** Depth-first walk of one root; never follows a symlink, never enters node_modules/.git. */
async function walk(root, stats) {
  let info;
  try {
    info = await stat(root);
  } catch (err) {
    if (err?.code === 'ENOENT') { stats.missing = true; return; }
    unreadable.push({ label: stats.label, reason: String(err?.code || err?.message) });
    stats.kinds.unreadable += 1;
    return;
  }
  if (info.isFile()) { await scanFile(root, root, stats); return; }
  if (!info.isDirectory()) {
    unreadable.push({ label: stats.label, reason: 'not a regular file or directory' });
    stats.kinds.unreadable += 1;
    return;
  }

  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === 'ENOENT') continue;                 // a concurrent run removed it
      unreadable.push({ label: `${dir}${sep}`, reason: String(err?.code || err?.message) });
      stats.kinds.unreadable += 1;
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) { stats.kinds.symlink += 1; continue; }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) stats.kinds.excluded += 1;
        else stack.push(path);
        continue;
      }
      if (!entry.isFile()) { stats.kinds.unreadable += 1; continue; }
      await scanFile(path, path, stats);
    }
  }
}

const started = Date.now();
for (const root of roots) await walk(root, statsFor.get(root));

// ── report ──────────────────────────────────────────────────────────────
for (const f of findings) console.log(`${f.label}:${f.line}  ${f.kind}: ${f.excerpt}`);
for (const r of refused) console.log(`${r.label}  REFUSED: ${r.reason}`);
for (const u of unreadable) console.log(`${u.label}  UNREADABLE: ${u.reason}`);

for (const root of roots) {
  const s = statsFor.get(root);
  if (s.missing) { console.log(`  ${s.label.padEnd(18)} not present`); continue; }
  const notScanned = Object.entries(s.kinds)
    .filter(([name, n]) => n > 0 && name !== 'refused' && name !== 'unreadable');
  const parts = [
    `scanned ${s.scanned} file(s)`,
    s.archives ? `+ ${s.archives} archive(s) / ${s.members} member(s)` : '',
    `not scanned ${notScanned.reduce((total, [, n]) => total + n, 0)}`
      + `${notScanned.length ? ` (${notScanned.map(([name, n]) => `${name} ${n}`).join(', ')})` : ''}`,
    `refused ${s.kinds.refused}`,
    s.kinds.unreadable ? `unreadable ${s.kinds.unreadable}` : '',
  ].filter(Boolean);
  console.log(`  ${s.label.padEnd(18)} ${parts.join(', ')}`);
}

const seconds = ((Date.now() - started) / 1000).toFixed(2);
const coverage = `${totals.files} file(s)${totals.members ? ` + ${totals.members} archive member(s)` : ''} scanned, `
  + `${refused.length} refused, across ${roots.length} root(s) (${seconds}s)`;

if (findings.length) {
  const files = new Set(findings.map((f) => f.label));
  console.log(`SENTINEL FAIL — ${findings.length} finding(s) in ${files.size} file(s); ${coverage}`);
  process.exit(1);
}
if (refused.length || unreadable.length) {
  console.log(`SENTINEL INCOMPLETE — nothing secret-shaped was found, but `
    + `${refused.length} retained archive member/archive(s) and ${unreadable.length} path(s) could not be inspected; ${coverage}`);
  process.exit(2);
}
console.log(`SENTINEL OK — no sentinel or foreign sk-or-v1 key in ${coverage}`);
process.exit(0);
