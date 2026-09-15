#!/usr/bin/env node
// incident.mjs — deduplicated incident reporting for the scheduled live checks (R09 §12.4).
//
// Identity is (service, failure class): at most one OPEN issue exists per identity, so a service that
// keeps failing updates its issue instead of opening a new one every run, and a recovery comments on
// that issue and closes it. Repeated failures increment an occurrence counter carried in the issue body.
//
// External text (diagnostic codes, detail strings, run URLs) is DATA: it is sanitised to a single
// bounded line, stripped of HTML-comment and workflow-command syntax, and never handed to a shell.
// This script performs no shell work at all — it talks to the GitHub REST API with fetch().
//
// Reporting is off unless explicitly enabled (--enable or INCIDENT_REPORTING=enabled) and the token has
// push permission on the repository; otherwise the run is a no-op with a printed explanation and a JSON
// record saying why.
//
// Usage:
//   node scripts/incident.mjs --service live-health --class deployment [--severity high]
//        [--codes a,b] [--detail "text"] [--run-url URL] [--sha SHA] [--recovery]
//        [--enable] [--dry-run] [--json artifacts/results/incident.json]
//
// Exit: 0 reported or deliberately skipped · 1 unexpected error · 2 usage · 3 report failed

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Longest accepted length for untrusted text in a report. */
export const SANITIZE_LIMIT = 300;

/** Failure classes the scheduled checks can report (stable identity components). */
export const FAILURE_CLASSES = ['deployment', 'application', 'catalog', 'worker-configuration', 'infrastructure', 'budget'];

const SEVERITIES = ['low', 'medium', 'high'];

const MARKER_PREFIX = 'ci-incident';

/**
 * Reduce untrusted text to a single bounded line of data: control characters and newlines removed,
 * HTML-comment syntax (which could forge an identity marker) and workflow-command syntax (`::x::`)
 * defanged, length capped. Empty input stays empty.
 */
export function sanitizeUntrusted(value) {
  if (value === undefined || value === null) return '';
  let text = String(value);
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' '); // newlines, tabs, CR, NUL, DEL
  // Every comment delimiter at once: `<!--`, the long form `--!>`, and `-->`
  // (the classic opener/closer pair). A filter that knows only `-->` lets
  // `--!>` through, and that is exactly the token an HTML-comment context
  // treats as a terminator.
  text = text.replace(/<!--|--!?>|--/g, ' ');
  text = text.replace(/::/g, ':');
  text = text.replace(/`/g, "'");
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > SANITIZE_LIMIT ? `${text.slice(0, SANITIZE_LIMIT - 1)}…` : text;
}

/** Normalise an identity component to `[a-z0-9-]`, so a crafted field cannot invent another identity. */
function slug(value, fallback) {
  const s = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || fallback;
}

/** Stable identity for a service/class pair. */
export function identityFor({ service, failureClass }) {
  const s = slug(service, 'unknown-service');
  const c = slug(failureClass, 'unknown-class');
  return { id: `${s}:${c}`, service: s, failureClass: c };
}

/** Read the identity marker out of an issue body, or null when it carries none. */
export function parseIssueBody(body) {
  const m = new RegExp(`<!--\\s*${MARKER_PREFIX}\\s+([^>]*?)-->`).exec(String(body ?? ''));
  if (!m) return null;
  const fields = {};
  for (const part of m[1].trim().split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
  }
  if (!fields.service || !fields.class) return null;
  return {
    id: `${fields.service}:${fields.class}`,
    service: fields.service,
    failureClass: fields.class,
    occurrences: Number.parseInt(fields.occurrences ?? '1', 10) || 1,
    severity: fields.severity ?? 'medium',
    firstSeen: fields.first_seen ?? '',
    lastSeen: fields.last_seen ?? '',
  };
}

function marker(identity, occurrences, severity, firstSeen, lastSeen) {
  return `<!-- ${MARKER_PREFIX} service=${identity.service} class=${identity.failureClass} occurrences=${occurrences} severity=${severity} first_seen=${firstSeen} last_seen=${lastSeen} -->`;
}

function detailsBlock(event) {
  const codes = (Array.isArray(event.codes) ? event.codes : []).map((c) => sanitizeUntrusted(c)).filter(Boolean);
  const detail = sanitizeUntrusted(event.detail);
  const lines = [];
  if (codes.length) lines.push(`- diagnostic codes: ${codes.map((c) => `\`${c}\``).join(', ')}`);
  if (event.runUrl) lines.push(`- run: ${sanitizeUntrusted(event.runUrl)}`);
  if (event.sha) lines.push(`- commit: \`${sanitizeUntrusted(event.sha)}\``);
  if (detail) {
    lines.push('');
    lines.push('Detail reported by the check (untrusted input, sanitised to one line):');
    lines.push('');
    lines.push(`> ${detail}`);
  }
  return lines.join('\n');
}

/**
 * Decide what to do for one event. Pure: the API layer performs whatever the plan says.
 * `event.kind` is 'failure' or 'recovery'; `existing` is a parsed open issue with the same identity.
 */
export function planIncident(event, existing) {
  const identity = event.identity;
  const severity = SEVERITIES.includes(event.severity) ? event.severity : 'medium';
  const now = event.now;
  // Identity is the whole point of the dedup contract: an open issue for another service or another
  // failure class is not this incident, whatever the caller passed in.
  const open = existing && existing.id === identity.id ? existing : null;

  if (event.kind === 'recovery') {
    if (!open) {
      return { action: 'noop', identity, reason: `no open incident for ${identity.id} — nothing to recover` };
    }
    const body = [
      marker(identity, open.occurrences, severity, open.firstSeen || now, now),
      '',
      `**Recovered** — \`${identity.service}\` passed its \`${identity.failureClass}\` check.`,
      '',
      `- occurrences while open: ${open.occurrences}`,
      `- recovered at: ${now}`,
      detailsBlock(event),
      '',
      'Closing this incident. A further failure opens a new issue for the same identity.',
    ].join('\n');
    return {
      action: 'recover',
      identity,
      comment: `Recovered: \`${identity.service}\` \`${identity.failureClass}\` check passed (${open.occurrences} occurrence${open.occurrences === 1 ? '' : 's'}).`,
      issueUpdate: { state: 'closed', state_reason: 'completed', body },
    };
  }

  if (open) {
    const occurrences = open.occurrences + 1;
    const firstSeen = open.firstSeen || now;
    const body = [
      marker(identity, occurrences, severity, firstSeen, now),
      '',
      `**Repeat failure** — \`${identity.service}\` failed its \`${identity.failureClass}\` check again.`,
      '',
      `- occurrences: ${occurrences}`,
      `- first seen: ${firstSeen}`,
      `- last seen: ${now}`,
      detailsBlock(event),
    ].join('\n');
    return {
      action: 'repeat',
      identity,
      occurrences,
      comment: `Repeat #${occurrences} for \`${identity.id}\` at ${now}.`,
      issueUpdate: { body },
    };
  }

  const body = [
    marker(identity, 1, severity, now, now),
    '',
    `**Incident** — the scheduled check \`${identity.service}\` reported a \`${identity.failureClass}\` failure.`,
    '',
    `- identity: \`${identity.id}\``,
    `- severity: ${severity}`,
    `- first seen: ${now}`,
    `- occurrences: 1`,
    detailsBlock(event),
    '',
    'The next failing run comments here instead of opening a second issue; a passing run closes it.',
  ].join('\n');
  return {
    action: 'create',
    identity,
    issue: { title: `[${MARKER_PREFIX}][${severity}] ${identity.service} — ${identity.failureClass} failure`, body, labels: [MARKER_PREFIX] },
  };
}

/**
 * Decide whether this run may write anything. Pure; `permission` is the repository permission probe
 * result (true/false), `undefined` while it is still unknown.
 */
export function decideRun({ enabled, dryRun, token, repo, permission }) {
  if (!enabled) return { proceed: false, outcome: 'not-enabled', reason: 'reporting is disabled (pass --enable or set INCIDENT_REPORTING=enabled)' };
  if (dryRun) return { proceed: false, outcome: 'dry-run', reason: 'dry run: nothing is created or updated' };
  if (!token) return { proceed: false, outcome: 'no-token', reason: 'no GitHub token in GITHUB_TOKEN/GH_TOKEN: cannot report' };
  if (!repo) return { proceed: false, outcome: 'no-repo', reason: 'GITHUB_REPOSITORY/--repo is not set: cannot report' };
  if (permission === false) return { proceed: false, outcome: 'no-permission', reason: `token has no push permission on ${repo}: reporting is a no-op` };
  if (permission === undefined) return { proceed: true, outcome: 'probing-permission', reason: 'checking repository permission' };
  return { proceed: true, outcome: 'reporting', reason: `reporting to ${repo}` };
}

function parseArgs(argv) {
  const args = {
    service: '', failureClass: '', severity: 'high', codes: [], detail: '',
    runUrl: process.env.GITHUB_RUN_URL ?? '', sha: process.env.GITHUB_SHA ?? '',
    recovery: false, enable: false, dryRun: false,
    json: resolve('artifacts/results/incident.json'),
    repo: process.env.GITHUB_REPOSITORY ?? '',
  };
  const take = (i) => {
    if (i + 1 >= argv.length) throw new Error(`missing value for ${argv[i]}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--service') { args.service = take(i); i += 1; }
    else if (arg === '--class') { args.failureClass = take(i); i += 1; }
    else if (arg === '--severity') { args.severity = take(i); i += 1; }
    else if (arg === '--codes') { args.codes = take(i).split(',').map((c) => sanitizeUntrusted(c)).filter(Boolean); i += 1; }
    else if (arg === '--detail') { args.detail = sanitizeUntrusted(take(i)); i += 1; }
    else if (arg === '--run-url') { args.runUrl = sanitizeUntrusted(take(i)); i += 1; }
    else if (arg === '--sha') { args.sha = sanitizeUntrusted(take(i)); i += 1; }
    else if (arg === '--repo') { args.repo = sanitizeUntrusted(take(i)); i += 1; }
    else if (arg === '--json') { args.json = resolve(take(i)); i += 1; }
    else if (arg === '--recovery') args.recovery = true;
    else if (arg === '--enable') args.enable = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (process.env.INCIDENT_REPORTING === 'enabled') args.enable = true;
  return args;
}

const USAGE = `usage: node scripts/incident.mjs --service <name> --class <${FAILURE_CLASSES.join('|')}>
       [--severity ${SEVERITIES.join('|')}] [--codes a,b] [--detail text] [--run-url URL] [--sha SHA]
       [--recovery] [--enable] [--dry-run] [--json path]

Reporting is a no-op with an explanation unless --enable (or INCIDENT_REPORTING=enabled) is set and the
token has push permission on the repository.`;

export function writeRecord(path, record) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    return true;
  } catch (err) {
    console.warn(`INCIDENT warn: could not write ${path} (${sanitizeUntrusted(err?.message)})`);
    return false;
  }
}

function apiHeaders(token) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'assembly-agent-incident-reporter',
  };
}

async function api(base, token, path, init = {}) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...apiHeaders(token), ...(init.headers ?? {}) } });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body: keep status only */ }
  return { status: res.status, json };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`INCIDENT usage error: ${sanitizeUntrusted(err?.message)}`);
    console.error(USAGE);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!args.service || !args.failureClass) {
    console.error('INCIDENT usage error: --service and --class are required');
    console.error(USAGE);
    process.exit(2);
  }

  const identity = identityFor({ service: args.service, failureClass: args.failureClass });
  const now = new Date().toISOString();
  const event = {
    kind: args.recovery ? 'recovery' : 'failure',
    identity,
    severity: args.severity,
    codes: args.codes,
    detail: args.detail,
    runUrl: args.runUrl,
    sha: args.sha,
    now,
  };

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  const base = process.env.GITHUB_API_URL || 'https://api.github.com';
  const record = {
    schema: 'incident/1',
    at: now,
    identity: identity.id,
    service: identity.service,
    failureClass: identity.failureClass,
    severity: event.severity,
    kind: event.kind,
    repository: args.repo || null,
    outcome: null,
    reason: null,
    action: null,
    issue: null,
    occurrences: null,
  };

  let decision = decideRun({ enabled: args.enable, dryRun: args.dryRun, token, repo: args.repo });
  if (decision.proceed) {
    // Permission probe: the reporter writes issues only where the token can already push.
    const repoInfo = await api(base, token, `/repos/${args.repo}`);
    if (repoInfo.status !== 200) {
      Object.assign(record, { outcome: 'probe-failed', reason: `repository probe returned ${repoInfo.status}` });
      writeRecord(args.json, record);
      console.log(`INCIDENT no-op: repository probe for ${args.repo} returned ${repoInfo.status}`);
      process.exit(0);
    }
    const perms = repoInfo.json?.permissions ?? {};
    decision = decideRun({ enabled: args.enable, dryRun: args.dryRun, token, repo: args.repo, permission: Boolean(perms.push || perms.admin) });
  }

  Object.assign(record, { outcome: decision.outcome, reason: decision.reason });
  if (!decision.proceed) {
    const plan = planIncident(event, null);
    record.action = 'none';
    writeRecord(args.json, record);
    console.log(`INCIDENT no-op: ${decision.reason}`);
    console.log(`INCIDENT would report ${identity.id} (${event.kind}, severity ${event.severity}) as "${plan.action}"`);
    process.exit(0);
  }

  // Dedup: at most one open incident per identity.
  const openList = await api(base, token, `/repos/${args.repo}/issues?state=open&labels=${MARKER_PREFIX}&per_page=100`);
  if (openList.status !== 200) {
    Object.assign(record, { outcome: 'list-failed', reason: `issue list returned ${openList.status}` });
    writeRecord(args.json, record);
    console.error(`INCIDENT failed: could not list open incidents (HTTP ${openList.status})`);
    process.exit(3);
  }
  const existingIssue = (openList.json ?? [])
    .map((issue) => ({ issue, parsed: parseIssueBody(issue.body) }))
    .find((entry) => entry.parsed && entry.parsed.id === identity.id) ?? null;

  const plan = planIncident(event, existingIssue?.parsed ?? null);
  record.action = plan.action;
  record.occurrences = plan.occurrences ?? existingIssue?.parsed?.occurrences ?? null;

  if (plan.action === 'noop') {
    record.reason = plan.reason;
    writeRecord(args.json, record);
    console.log(`INCIDENT no-op: ${plan.reason}`);
    process.exit(0);
  }

  if (plan.action === 'create') {
    const created = await api(base, token, `/repos/${args.repo}/issues`, {
      method: 'POST',
      body: JSON.stringify(plan.issue),
    });
    if (created.status !== 201) {
      record.outcome = 'create-failed';
      record.reason = `issue create returned ${created.status}`;
      writeRecord(args.json, record);
      console.error(`INCIDENT failed: issue create returned HTTP ${created.status}`);
      process.exit(3);
    }
    record.issue = { number: created.json.number, htmlUrl: created.json.html_url };
    record.occurrences = 1;
    writeRecord(args.json, record);
    console.log(`INCIDENT created #${created.json.number} for ${identity.id}: ${created.json.html_url}`);
    process.exit(0);
  }

  const number = existingIssue.issue.number;
  const commented = await api(base, token, `/repos/${args.repo}/issues/${number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: plan.comment }),
  });
  if (commented.status !== 201) {
    record.outcome = `${plan.action}-comment-failed`;
    record.reason = `comment returned ${commented.status}`;
    writeRecord(args.json, record);
    console.error(`INCIDENT failed: comment on #${number} returned HTTP ${commented.status}`);
    process.exit(3);
  }
  const updated = await api(base, token, `/repos/${args.repo}/issues/${number}`, {
    method: 'PATCH',
    body: JSON.stringify(plan.issueUpdate),
  });
  if (updated.status !== 200) {
    record.outcome = `${plan.action}-update-failed`;
    record.reason = `issue update returned ${updated.status}`;
    writeRecord(args.json, record);
    console.error(`INCIDENT failed: update of #${number} returned HTTP ${updated.status}`);
    process.exit(3);
  }
  record.issue = { number, htmlUrl: updated.json.html_url };
  record.outcome = plan.action === 'repeat' ? `repeat-${record.occurrences}` : 'recovered';
  writeRecord(args.json, record);
  console.log(
    plan.action === 'repeat'
      ? `INCIDENT repeat #${record.occurrences} recorded on #${number} (${identity.id})`
      : `INCIDENT recovery recorded and #${number} closed (${identity.id})`,
  );
  process.exit(0);
}

// Only run when executed as a program; the pure helpers above are imported by the test suite.
// Only run when executed as a program; the pure helpers above are imported by the test suite.
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
  main().catch((err) => {
    console.error(`INCIDENT failed: ${sanitizeUntrusted(err?.message)}`);
    process.exit(1);
  });
}
