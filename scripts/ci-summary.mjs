#!/usr/bin/env node
/**
 * scripts/ci-summary.mjs — machine-readable result summary + Markdown job summary
 * (R07).
 *
 *   npm run ci:summary                     # Markdown to $GITHUB_STEP_SUMMARY, JSON to artifacts/results/summary.json
 *   node scripts/ci-summary.mjs --deploy-url <url> --deploy-commit <sha> --deploy-result deployed
 *   node scripts/ci-summary.mjs --out -     # print the Markdown to stdout even under Actions
 *
 * Inputs (every one optional — a failed run must still produce a summary):
 *   artifacts/results/*.json     run-tests.mjs class reports, the Playwright JSON
 *                                report, scripts/toolchain.mjs, and the
 *                                audit/dependency/worker/live reports
 *   artifacts/site-inventory.json  the staged-site manifest (per-file + tree digests)
 *   _site/build-info.json          the site's own identity (commit, wasm/lockfile digests, deps)
 *   test/manifest.json             which classes and entries the run was supposed to cover
 *
 * It is deliberately builtins-only: the post-deploy job runs it without an npm
 * install, so it can never be the reason a report is missing.
 *
 * Reporting policy — the distinction the summary must never collapse:
 *   product regression   a suite ran and tests failed, or a test-executing command
 *                        exited nonzero after producing results;
 *   infrastructure/setup a required command never produced a result (spawn error,
 *                        missing file, no tests at all);
 *   security/policy      a policy report (audit, dependency, lint) failed;
 *   provider/deployment  a live or deployment report failed, quoting its own status;
 *   optional not run     a report this workflow intentionally does not produce
 *                        (scheduled/live classes, Worker packaging);
 *   evidence gap         a required report is missing or empty.
 * A missing or empty report is never rendered as a pass. The gate itself decides
 * the exit status of the run; this script's only failure exit is "could not write
 * the summary".
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_RESULTS_DIR = join(ROOT, 'artifacts', 'results');
const INVENTORY_PATH = join(ROOT, 'artifacts', 'site-inventory.json');
const BUILD_INFO_PATH = join(ROOT, '_site', 'build-info.json');
const MANIFEST_PATH = join(ROOT, 'test', 'manifest.json');

// The required classes are frozen by the campaign contract; everything else is
// optional here and reported as such rather than as a failure.
const REQUIRED_CLASSES = ['offline', 'worker', 'browser'];
const OPTIONAL_CLASSES = ['scheduled-browser', 'live'];

const USAGE = `usage: node scripts/ci-summary.mjs [--json <path>] [--results <dir>] [--out <path|->]
       [--deploy-url <url>] [--deploy-commit <sha>] [--deploy-result <state>] [--deploy-tip <sha>]
       [--reports <a,b>] [--commands <c1;c2>] [--help]

reads <results>/*.json (default artifacts/results) + artifacts/site-inventory.json + _site/build-info.json and
writes artifacts/results/summary.json plus a Markdown summary ($GITHUB_STEP_SUMMARY when present, stdout otherwise)`;

function usage(code = 0) {
  (code === 0 ? console.log : console.error)(USAGE);
  process.exit(code);
}

function parseArgs(argv) {
  const env = process.env;
  const args = {
    json: join(DEFAULT_RESULTS_DIR, 'summary.json'),
    results: DEFAULT_RESULTS_DIR,
    out: env.GITHUB_STEP_SUMMARY || '-',
    deploy: {
      url: env.DEPLOY_URL || null,
      commit: env.DEPLOY_COMMIT || null,
      result: env.DEPLOY_RESULT || null,
      tip: env.DEPLOY_TIP || null,
    },
    reports: (env.CI_REPORT_ARTIFACTS || '').split(',').map((s) => s.trim()).filter(Boolean),
    commands: (env.CI_SUMMARY_COMMANDS || '').split(';').map((s) => s.trim()).filter(Boolean),
  };
  const take = (i) => {
    const value = argv[i + 1];
    if (!value) usage(2);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { args.json = resolve(take(i)); i += 1; }
    else if (arg === '--results') { args.results = resolve(take(i)); i += 1; }
    else if (arg === '--out') { args.out = take(i); i += 1; }
    else if (arg === '--deploy-url') { args.deploy.url = take(i); i += 1; }
    else if (arg === '--deploy-commit') { args.deploy.commit = take(i); i += 1; }
    else if (arg === '--deploy-result') { args.deploy.result = take(i); i += 1; }
    else if (arg === '--deploy-tip') { args.deploy.tip = take(i); i += 1; }
    else if (arg === '--reports') { args.reports = take(i).split(',').map((s) => s.trim()).filter(Boolean); i += 1; }
    else if (arg === '--commands') { args.commands = take(i).split(';').map((s) => s.trim()).filter(Boolean); i += 1; }
    else if (arg === '--help' || arg === '-h') usage(0);
    else usage(2);
  }
  return args;
}

function readJson(path) {
  if (!existsSync(path)) return { state: 'missing' };
  try {
    return { state: 'ok', doc: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { state: 'unreadable', error: String(error.message) };
  }
}

const reasonLine = (text) => (typeof text === 'string' ? text.split(/\r?\n/)[0].slice(0, 200) : null);
const sum = (list) => list.reduce((total, n) => total + (typeof n === 'number' ? n : 0), 0);
const shortSha = (sha) => (typeof sha === 'string' && sha.length >= 8 ? sha.slice(0, 12) : sha || null);

// ── event context ────────────────────────────────────────────────────────
function eventContext() {
  const env = process.env;
  const ctx = {
    event: env.GITHUB_EVENT_NAME || null,
    ref: env.GITHUB_REF || null,
    sha: env.GITHUB_SHA || null,
    workflow: env.GITHUB_WORKFLOW || null,
    job: env.GITHUB_JOB || null,
    repository: env.GITHUB_REPOSITORY || null,
    runId: env.GITHUB_RUN_ID || null,
    runAttempt: env.GITHUB_RUN_ATTEMPT || null,
    runUrl: env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : null,
    pullRequest: null,
    pushedCommit: null,
    mergeRef: null,
  };
  const payload = env.GITHUB_EVENT_PATH ? readJson(env.GITHUB_EVENT_PATH) : { state: 'missing' };
  if (payload.state === 'ok') {
    const event = payload.doc;
    if (event.pull_request) {
      ctx.pullRequest = {
        number: event.number ?? event.pull_request.number ?? null,
        headSha: event.pull_request.head?.sha ?? null,
        baseSha: event.pull_request.base?.sha ?? null,
        mergeCommitSha: event.pull_request.merge_commit_sha ?? env.GITHUB_SHA ?? null,
      };
      ctx.mergeRef = env.GITHUB_SHA || ctx.pullRequest.mergeCommitSha;
    }
    ctx.pushedCommit = event.after ?? event.head_commit?.id ?? null;
  }
  return ctx;
}

// ── report readers ───────────────────────────────────────────────────────
function readManifest() {
  const { state, doc } = readJson(MANIFEST_PATH);
  if (state !== 'ok') return { state, expected: {}, classes: [] };
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  const expected = {};
  for (const entry of entries) {
    if (!entry.class) continue;
    expected[entry.class] = (expected[entry.class] ?? 0) + 1;
  }
  return { state: 'ok', expected, classes: doc.classes ?? [] };
}

function classifyEntry(entry) {
  const failed = typeof entry.failed === 'number' ? entry.failed : 0;
  const tests = typeof entry.tests === 'number' ? entry.tests : null;
  const reason = reasonLine(entry.reason);
  if (entry.ok) return 'pass';
  if (typeof entry.exit === 'number' && entry.exit !== 0 && failed > 0) return 'product';
  if (reason && /retry|flak/i.test(reason)) return 'flaky';
  if (tests === null || tests === 0 || entry.exit === null || entry.exit === undefined || /spawn|ENOENT|not found|missing|timeout/i.test(reason ?? '')) {
    return 'infrastructure';
  }
  return 'product';
}

function readSuite(file, doc) {
  const entries = Array.isArray(doc.entries) ? doc.entries : [];
  const commands = [...new Set(entries.map((e) => e.cmd).filter(Boolean))];
  const failedEntries = entries.filter((e) => !e.ok);
  return {
    name: doc.class,
    file,
    ok: doc.ok === true,
    status: doc.ok === true ? (entries.length === 0 ? 'empty' : 'pass') : 'fail',
    totalTests: typeof doc.totalTests === 'number' ? doc.totalTests : sum(entries.map((e) => e.tests)),
    passed: sum(entries.map((e) => e.passed)),
    failed: sum(entries.map((e) => e.failed)),
    skipped: sum(entries.map((e) => e.skipped)),
    durationMs: typeof doc.durationMs === 'number' ? doc.durationMs : null,
    entryCount: entries.length,
    commands,
    failures: failedEntries.map((e) => ({ path: e.path, kind: classifyEntry(e), reason: reasonLine(e.reason), exit: e.exit ?? null })),
  };
}

// Playwright's JSON reporter: config.projects, suites[].specs[].tests[].
function collectPlaywrightSpecs(node, out = []) {
  for (const suite of node.suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        out.push({
          title: spec.title,
          file: spec.file ?? suite.file ?? null,
          tags: Array.isArray(spec.tags) ? spec.tags : [],
          ok: spec.ok === true,
          project: test.projectName ?? null,
          status: test.status ?? null,
          attachments: results.flatMap((r) => (r.attachments ?? []).map((a) => a.name || a.contentType || 'attachment')),
        });
      }
    }
    collectPlaywrightSpecs(suite, out);
  }
  return out;
}

function readPlaywright(file, doc) {
  const specs = collectPlaywrightSpecs(doc);
  const projects = new Map();
  const bump = (name, key) => {
    const current = projects.get(name) ?? { project: name, expected: 0, unexpected: 0, flaky: 0, skipped: 0 };
    current[key] += 1;
    projects.set(name, current);
  };
  for (const spec of specs) {
    const name = spec.project ?? '(default project)';
    if (spec.status === 'expected') bump(name, 'expected');
    else if (spec.status === 'unexpected') bump(name, 'unexpected');
    else if (spec.status === 'flaky') bump(name, 'flaky');
    else bump(name, 'skipped');
  }
  const hasTag = (spec, tag) => spec.tags.includes(tag);
  const categories = (tag, pattern) => specs.filter((s) => hasTag(s, tag) || pattern.test(s.title ?? ''));
  const outcomeOf = (list) => ({
    tests: list.length,
    failed: list.filter((s) => s.status === 'unexpected').length,
    flaky: list.filter((s) => s.status === 'flaky').length,
    titles: list.filter((s) => s.status === 'unexpected').map((s) => s.title),
  });
  const a11y = categories('a11y', /a11y|accessib|axe|contrast|focus|keyboard|aria|announce/i);
  const visual = categories('visual', /visual|snapshot|screenshot|pixel|image|diff/i);
  const tagCounts = {};
  for (const spec of specs) for (const tag of spec.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
  const attachmentCounts = {};
  for (const spec of specs) {
    if (spec.ok) continue;
    for (const name of spec.attachments) attachmentCounts[name] = (attachmentCounts[name] ?? 0) + 1;
  }
  return {
    file,
    version: doc.config?.version ?? null,
    stats: doc.stats ?? null,
    configuredProjects: (doc.config?.projects ?? []).map((p) => p.name),
    projects: [...projects.values()],
    tags: tagCounts,
    specs: specs.length,
    summary: { a11y: outcomeOf(a11y), visual: outcomeOf(visual) },
    failing: specs.filter((s) => !s.ok).map((s) => ({ project: s.project, title: s.title, status: s.status })),
    attachments: attachmentCounts,
  };
}

function readSite() {
  const inventory = readJson(INVENTORY_PATH);
  const buildInfo = readJson(BUILD_INFO_PATH);
  if (inventory.state !== 'ok' && buildInfo.state !== 'ok') return null;
  const files = inventory.state === 'ok' && Array.isArray(inventory.doc.files) ? inventory.doc.files : [];
  const wasm = files.find((f) => f.path === 'dist/agent.wasm') ?? null;
  return {
    manifestState: inventory.state,
    files: files.length || null,
    totalBytes: files.length ? sum(files.map((f) => f.bytes)) : null,
    treeDigest: inventory.state === 'ok' ? inventory.doc.treeDigest ?? null : null,
    wasmBytes: wasm?.bytes ?? null,
    wasmSha256: wasm?.sha256 ?? null,
    buildInfo: buildInfo.state === 'ok' ? buildInfo.doc : null,
    buildInfoState: buildInfo.state,
  };
}

const SECURITY_REPORTS = /audit|deps|dependenc|policy|lint|codeql|zizmor|actionlint/i;
const DEPLOYMENT_REPORTS = /live-health|worker-deploy|deploy/i;
const PROVIDER_HINTS = /provider|network|rate.?limit|upstream|unavailable|outage|5\d\d/i;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const event = eventContext();
  const manifest = readManifest();

  const files = existsSync(args.results)
    ? readdirSync(args.results).filter((f) => f.endsWith('.json') && f !== 'summary.json').sort()
    : [];

  const suites = [];
  const playwright = [];
  const toolchain = [];
  const other = [];
  const unreadable = [];

  for (const file of files) {
    const { state, doc, error } = readJson(join(args.results, file));
    if (state !== 'ok') {
      unreadable.push({ file, state, error: error ?? null });
      continue;
    }
    if (doc && typeof doc.class === 'string' && Array.isArray(doc.entries)) suites.push(readSuite(file, doc));
    else if (doc && doc.stats && Array.isArray(doc.suites)) playwright.push(readPlaywright(file, doc));
    else if (doc && doc.pins && doc.resolved) toolchain.push({ file, ...doc });
    else other.push({ file, doc });
  }

  // ── findings ───────────────────────────────────────────────────────────
  const findings = { product: [], infrastructure: [], flaky: [], security: [], provider: [], evidenceGaps: [], optional: [] };
  const suiteByName = new Map(suites.map((s) => [s.name, s]));

  for (const name of REQUIRED_CLASSES) {
    const suite = suiteByName.get(name);
    const expectedEntries = manifest.expected[name] ?? null;
    if (!suite) {
      findings.evidenceGaps.push(`required class '${name}' produced no report (${relative(ROOT, join(args.results, `${name}.json`))})`);
      continue;
    }
    if (suite.entryCount === 0 || suite.totalTests === 0) {
      findings.evidenceGaps.push(`required class '${name}' reported zero entries/tests (empty report)`);
    }
    if (expectedEntries !== null && suite.entryCount !== expectedEntries) {
      findings.evidenceGaps.push(`required class '${name}' reported ${suite.entryCount} entries, manifest lists ${expectedEntries}`);
    }
    for (const failure of suite.failures) {
      const line = `${name}: ${failure.path} — ${failure.reason ?? `exit ${failure.exit}`}`;
      const bucket = findings[failure.kind] ?? findings.product;
      bucket.push(line);
    }
  }
  for (const name of OPTIONAL_CLASSES) {
    const suite = suiteByName.get(name);
    if (!suite) {
      findings.optional.push(`class '${name}' not run in this workflow (scheduled/live classes are separate workflows)`);
      continue;
    }
    if (suite.entryCount === 0) findings.evidenceGaps.push(`class '${name}' reported an empty report`);
    for (const failure of suite.failures) findings.provider.push(`${name}: ${failure.path} — ${failure.reason ?? `exit ${failure.exit}`}`);
  }

  for (const report of other) {
    const ok = report.doc.ok;
    const status = report.doc.status ?? report.doc.code ?? report.doc.result ?? null;
    const reason = reasonLine(report.doc.reason ?? report.doc.error ?? report.doc.summary ?? report.doc.detail);
    if (ok === false) {
      const line = `${report.file}${status ? ` [${status}]` : ''}: ${reason ?? 'reported failure'}`;
      if (SECURITY_REPORTS.test(report.file)) findings.security.push(line);
      else if (DEPLOYMENT_REPORTS.test(report.file) || PROVIDER_HINTS.test(reason ?? '')) findings.provider.push(line);
      else findings.product.push(line);
    } else if (ok === undefined && report.doc.error) {
      findings.infrastructure.push(`${report.file}: ${reasonLine(report.doc.error)}`);
    }
  }
  for (const item of unreadable) findings.infrastructure.push(`${item.file}: ${item.state}${item.error ? ` (${item.error})` : ''}`);

  const failed = findings.product.length + findings.infrastructure.length + findings.flaky.length
    + findings.security.length + findings.provider.length;
  const result = failed > 0 ? 'fail' : findings.evidenceGaps.length > 0 ? 'incomplete' : 'pass';

  const reports = {
    suites: suites.map((s) => ({ name: s.name, ok: s.ok, entries: s.entryCount, tests: s.totalTests, failed: s.failed, file: s.file })),
    playwright: playwright.map((p) => ({ file: p.file, specs: p.specs, stats: p.stats })),
    other: other.map((o) => ({
      file: o.file,
      ok: o.doc.ok ?? null,
      status: o.doc.status ?? o.doc.code ?? null,
      reason: reasonLine(o.doc.reason ?? o.doc.error ?? o.doc.detail ?? o.doc.summary),
    })),
    unreadable,
    uploaded: args.reports,
  };

  const site = readSite();
  const hasDeployment = Boolean(args.deploy.url || args.deploy.commit || args.deploy.result);
  const smokeReport = hasDeployment ? readJson(join(args.results, 'live-health-postdeploy.json')) : { state: 'missing' };
  const model = {
    generatedBy: 'scripts/ci-summary.mjs',
    event,
    result,
    toolchain: toolchain[0] ?? null,
    suites,
    playwright,
    site,
    reports,
    findings,
    deployment: hasDeployment ? { ...args.deploy, smoke: smokeReport.state === 'ok' ? smokeReport.doc : null } : null,
    commands: args.commands,
  };

  mkdirSync(dirname(args.json), { recursive: true });
  writeFileSync(args.json, `${JSON.stringify(model, null, 2)}\n`);

  const markdown = render(model);
  if (args.out === '-') console.log(markdown);
  else writeFileSync(args.out, `${markdown}\n`, { flag: 'a' });
  console.log(`SUMMARY ${result.toUpperCase()} (failing findings: ${failed}, evidence gaps: ${findings.evidenceGaps.length}) → ${args.json}`);
}

// ── Markdown ─────────────────────────────────────────────────────────────
function render(model) {
  const { event, findings } = model;
  const lines = [];
  const push = (...items) => lines.push(...items);
  const cell = (v) => (v === null || v === undefined || v === '' ? '—' : String(v).replace(/\|/g, '\\|'));

  const heading = event.event ? `${cell(event.event)} ${cell(shortSha(event.sha))}` : 'local run (no GitHub context)';
  push(`## Verification summary — ${heading}`, '');
  push(`**Result: ${model.result.toUpperCase()}**`, '');
  push('| context | value |', '| --- | --- |');
  push(`| tested commit | \`${cell(shortSha(event.sha))}\` |`);
  push(`| event / ref | ${cell(event.event)} / \`${cell(event.ref)}\` |`);
  if (event.pullRequest) {
    push(`| tested merge ref | \`${cell(shortSha(event.mergeRef))}\` (PR #${cell(event.pullRequest.number)}) |`);
    push(`| PR head | \`${cell(shortSha(event.pullRequest.headSha))}\` (merge target base \`${cell(shortSha(event.pullRequest.baseSha))}\`) |`);
  }
  if (event.pushedCommit) push(`| pushed commit | \`${cell(shortSha(event.pushedCommit))}\` |`);
  push(`| workflow / job | ${cell(event.workflow)} / ${cell(event.job)} |`);
  if (event.runUrl) push(`| run | [${cell(event.runId)} attempt ${cell(event.runAttempt)}](${event.runUrl}) |`);
  push('');

  // Toolchain
  const tc = model.toolchain?.resolved;
  push('### Toolchain', '');
  if (!tc) {
    push('_No `artifacts/results/toolchain.json`: tool versions were not recorded by this run._', '');
  } else {
    push('| tool | pinned | resolved |', '| --- | --- | --- |');
    push(`| Node | ${cell(model.toolchain.pins?.node)} | ${cell(tc.node?.version)} (${cell(tc.node?.execPath)}) |`);
    push(`| npm | — | ${cell(tc.npm?.version)} |`);
    push(`| WABT wat2wasm | ${cell(model.toolchain.pins?.wabt)} | ${cell(tc.wabt?.wat2wasm?.version)} (${cell(tc.wabt?.wat2wasm?.path)}) |`);
    push(`| WABT wasm-validate | ${cell(model.toolchain.pins?.wabt)} | ${cell(tc.wabt?.wasmValidate?.version)} |`);
    push(`| Playwright | — | ${cell(tc.playwright?.version)} |`);
    push(`| Wrangler / workerd | — | ${cell(tc.wrangler?.version)} / ${cell(tc.workerd?.version)} (binary ${cell(tc.workerd?.binaryVersion)}) |`);
    push(`| runner image | ${cell(model.toolchain.pins?.runnerImage)} | ${cell(model.toolchain.runner?.imageOS ?? 'not a GitHub runner')}${model.toolchain.runner?.imageVersion ? ` (${model.toolchain.runner.imageVersion})` : ''} |`);
    const browsers = tc.playwright?.browsers ?? [];
    const requiredBrowser = browsers.find((b) => b.required);
    if (requiredBrowser) {
      const optional = browsers.filter((b) => !b.required && b.installed).map((b) => b.name);
      push(`| browser | — | ${cell(requiredBrowser.name)} ${cell(requiredBrowser.browserVersion)} (revision ${cell(requiredBrowser.revision)}, installed=${requiredBrowser.installed})${optional.length ? `; also installed: ${optional.map((n) => cell(n)).join(', ')}` : ''} |`);
    }
    push('');
    const drift = model.toolchain.drift ?? [];
    const missing = model.toolchain.missing ?? [];
    if (drift.length || missing.length) {
      push(`Toolchain deviations: ${[...missing.map((m) => `missing ${m}`), ...drift].map((d) => `\`${cell(d)}\``).join(', ')}`, '');
    }
  }
  if (model.commands.length) {
    push('Commands executed by this workflow:', '');
    for (const command of model.commands) push(`- \`${command}\``);
    push('');
  }

  // Suites
  push('### Suites', '');
  push('| suite | result | entries | tests | passed | failed | skipped | time | report |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const suite of model.suites) {
    push(`| ${cell(suite.name)} | ${suite.ok ? (suite.status === 'empty' ? '**empty report**' : 'pass') : '**fail**'} | ${cell(suite.entryCount)} | ${cell(suite.totalTests)} | ${cell(suite.passed)} | ${cell(suite.failed)} | ${cell(suite.skipped)} | ${suite.durationMs === null ? '—' : `${(suite.durationMs / 1000).toFixed(1)}s`} | \`${cell(suite.file)}\` |`);
  }
  for (const name of REQUIRED_CLASSES) {
    if (!model.suites.some((s) => s.name === name)) push(`| ${cell(name)} | **missing report** | — | — | — | — | — | — | evidence gap |`);
  }
  push('');
  for (const suite of model.suites) {
    if (suite.commands.length) push(`- \`${suite.name}\` ran: ${suite.commands.map((c) => `\`${cell(c)}\``).join(', ')}`);
  }
  const flaky = model.suites.flatMap((s) => s.failures.filter((f) => f.kind === 'flaky').map((f) => `${s.name}: ${f.path}`));
  if (flaky.length) push(`- retry-only (flaky) passes rejected by the runner: ${flaky.map((f) => `\`${cell(f)}\``).join(', ')}`);
  push('');

  // Browser coverage / a11y / visual
  if (model.playwright.length) {
    push('### Browser coverage, accessibility, visual', '');
    for (const report of model.playwright) {
      const stats = report.stats ?? {};
      push(`\`${cell(report.file)}\`: ${report.specs} specs — expected ${cell(stats.expected)}, unexpected ${cell(stats.unexpected)}, flaky ${cell(stats.flaky)}, skipped ${cell(stats.skipped)}; configured projects: ${report.configuredProjects.length ? report.configuredProjects.map((p) => `\`${cell(p)}\``).join(', ') : 'not recorded'}`, '');
      push('| project | expected | unexpected | flaky | skipped |', '| --- | --- | --- | --- | --- |');
      for (const project of report.projects) {
        push(`| ${cell(project.project)} | ${project.expected} | ${project.unexpected} | ${project.flaky} | ${project.skipped} |`);
      }
      push('');
      const a11y = report.summary.a11y;
      const visual = report.summary.visual;
      const categoryLine = (label, value) => `${label}: ${value.tests} matching test(s) (match by @tag or title keyword), ${value.failed} failing${value.flaky ? `, ${value.flaky} flaky` : ''}${value.titles.length ? ` (${value.titles.map((t) => `\`${cell(t)}\``).join(', ')})` : ''}`;
      push(`- ${categoryLine('accessibility', a11y)}`);
      push(`- ${categoryLine('visual comparison', visual)}`);
      const tags = Object.entries(report.tags ?? {});
      if (tags.length) push(`- tags observed: ${tags.map(([tag, count]) => `${cell(tag)} ${count}`).join(', ')}`);
      const attachments = Object.entries(report.attachments);
      if (attachments.length) push(`- failure diagnostics: ${attachments.map(([name, count]) => `${count} ${name}`).join(', ')}`);
      push('');
    }
  } else {
    push('### Browser coverage, accessibility, visual', '', '_No Playwright JSON report found in `artifacts/results/`._', '');
  }

  // Site artifact
  push('### Site artifact', '');
  if (!model.site) {
    push('_No `artifacts/site-inventory.json` or `_site/build-info.json`: the site was not built or staging failed._', '');
  } else {
    const site = model.site;
    const info = site.buildInfo ?? {};
    push('| field | value |', '| --- | --- |');
    push(`| staged files | ${cell(site.files)} (${cell(site.totalBytes)} bytes) |`);
    push(`| content digest | \`${cell(site.treeDigest)}\` |`);
    push(`| wasm | ${cell(site.wasmBytes)} bytes, sha256 \`${cell(site.wasmSha256)}\` |`);
    push(`| build-info commit | \`${cell(shortSha(info.commit))}\` |`);
    push(`| lockfile sha256 | \`${cell(info.lockfileSha256)}\` |`);
    if (info.deps) push(`| locked deps | ${Object.entries(info.deps).map(([k, v]) => `${k} ${v}`).join(', ')} |`);
    push('');
  }

  // Findings
  const sections = [
    ['Product regressions', findings.product],
    ['Infrastructure / setup failures', findings.infrastructure],
    ['Flaky retry-only passes', findings.flaky],
    ['Security / policy failures', findings.security],
    ['Provider or deployment failures', findings.provider],
    ['Evidence gaps (not a pass)', findings.evidenceGaps],
    ['Optional operations not run here', findings.optional],
  ];
  const nonEmpty = sections.filter(([, items]) => items.length);
  if (nonEmpty.length) {
    push('### Findings', '');
    for (const [title, items] of nonEmpty) {
      push(`**${title}**`, '');
      for (const item of items) push(`- ${item}`);
      push('');
    }
  }

  // Deployment
  if (model.deployment) {
    const d = model.deployment;
    push('### Deployment', '');
    push('| field | value |', '| --- | --- |');
    push(`| result | ${cell(d.result ?? 'not recorded')} |`);
    push(`| deployed commit | \`${cell(shortSha(d.commit))}\` |`);
    push(`| site URL | ${cell(d.url)} |`);
    if (d.tip) push(`| main tip after publication | \`${cell(shortSha(d.tip))}\` |`);
    push('');
    if (d.smoke) {
      push(`Post-deployment smoke: ${cell(d.smoke.status ?? d.smoke.code ?? 'recorded')} — ${cell(reasonLine(d.smoke.reason ?? d.smoke.detail ?? d.smoke.summary) ?? 'no reason recorded')}`, '');
    }
  }

  // Evidence
  push('### Reports', '');
  if (model.reports.uploaded.length) push(`Uploaded artifacts: ${model.reports.uploaded.map((r) => `\`${cell(r)}\``).join(', ')}`, '');
  else push('_No report artifact names were supplied to this summary._', '');
  if (model.reports.other.length) {
    push('', '| policy / operational report | result | detail |', '| --- | --- | --- |');
    for (const report of model.reports.other) {
      const outcome = report.ok === true ? 'pass' : report.ok === false ? '**fail**' : 'recorded';
      push(`| \`${cell(report.file)}\` | ${outcome} | ${cell(report.status ?? '')}${report.reason ? ` ${cell(report.reason)}` : ''} |`);
    }
  }
  if (model.reports.unreadable.length) {
    push('', `Unreadable reports: ${model.reports.unreadable.map((r) => `\`${cell(r.file)}\` (${cell(r.state)})`).join(', ')}`);
  }
  push('');

  return lines.join('\n');
}

main();
