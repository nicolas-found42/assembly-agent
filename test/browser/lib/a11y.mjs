// lib/a11y.mjs — axe scans for the browser suite.
//
// Two levels, matching the rule the legacy manual harness used:
//   * critical/serious violations always fail the spec;
//   * moderate/minor violations are compared against the reviewed baseline in
//     test/browser/a11y-baseline.json, so a new low-impact finding is caught
//     without re-litigating the ones already reviewed.
//
// axe-core comes from the installed @axe-core/playwright package — never a CDN.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';

/** Same rule set the legacy harness scanned with (test/a11y.browser.mjs). */
export const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export const BLOCKING = ['critical', 'serious'];
export const BASELINE_PATH = fileURLToPath(new URL('../a11y-baseline.json', import.meta.url));

/**
 * Run axe on the current page state.
 * @param {import('@playwright/test').Page} page
 * @param {{include?: string[], exclude?: string[]}} [options]
 * @returns {Promise<{violations: object[], ids: string[], byImpact: Record<string, string[]>}>}
 */
export async function scan(page, options = {}) {
  let builder = new AxeBuilder({ page }).withTags(TAGS);
  for (const selector of options.include || []) builder = builder.include(selector);
  for (const selector of options.exclude || []) builder = builder.exclude(selector);
  const results = await builder.analyze();
  const violations = results.violations || [];
  return {
    violations,
    ids: violations.map((v) => v.id).sort(),
    byImpact: {
      critical: violations.filter((v) => v.impact === 'critical').map((v) => v.id),
      serious: violations.filter((v) => v.impact === 'serious').map((v) => v.id),
      moderate: violations.filter((v) => v.impact === 'moderate').map((v) => v.id),
      minor: violations.filter((v) => v.impact === 'minor').map((v) => v.id),
    },
  };
}

/** Readable report: id(impact) x nodes @ selector. */
export function report(violations) {
  if (!violations.length) return 'no violations';
  return violations.map((v) => {
    const targets = v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ');
    return `${v.id} (${v.impact}) ×${v.nodes.length} — ${v.help}\n      ${targets}\n      ${v.helpUrl}`;
  }).join('\n');
}

/** Fail on critical/serious; return the whole result for the caller to inspect. */
export async function expectNoBlocking(page, label, options = {}) {
  const result = await scan(page, options);
  const blocking = result.violations.filter((v) => BLOCKING.includes(v.impact));
  if (blocking.length) {
    throw new Error(`axe ${label}: ${blocking.length} critical/serious violation(s)\n    ${report(blocking)}`);
  }
  return result;
}

export function loadBaseline() {
  const raw = readFileSync(BASELINE_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed?.version !== 1 || typeof parsed.scans !== 'object') {
    throw new Error(`${BASELINE_PATH}: expected {version: 1, scans: {...}}`);
  }
  return parsed;
}

/**
 * Compare one scan's moderate/minor findings against the reviewed baseline.
 * @returns {{added: string[], removed: string[]}} findings not in the baseline
 */
export function diffBaseline(result, label, baseline = loadBaseline()) {
  const reviewed = new Set([...(baseline.scans[label]?.moderate || []), ...(baseline.scans[label]?.minor || [])]);
  const current = [...result.byImpact.moderate, ...result.byImpact.minor];
  const added = current.filter((id) => !reviewed.has(id));
  const removed = [...reviewed].filter((id) => !current.includes(id));
  return { added, removed };
}

/** Fail when a scan produced moderate/minor findings the baseline never saw. */
export function expectNoNewLowImpact(result, label, baseline = loadBaseline()) {
  const { added } = diffBaseline(result, label, baseline);
  if (added.length) {
    const detail = report(result.violations.filter((v) => added.includes(v.id)));
    throw new Error(
      `axe ${label}: ${added.length} new moderate/minor violation(s) not in a11y-baseline.json: `
      + `${added.join(', ')}\n    ${detail}\n    `
      + 'Fix the finding, or review it and record it in test/browser/a11y-baseline.json.',
    );
  }
}

/** Records every moderate/minor id of a scan into the baseline file.
 *  Writing is opt-in (A11Y_BASELINE_WRITE=1) so a green run never blesses new
 *  findings silently. */
export function recordBaseline(results) {
  if (process.env.A11Y_BASELINE_WRITE !== '1') {
    throw new Error('set A11Y_BASELINE_WRITE=1 to rewrite test/browser/a11y-baseline.json');
  }
  const scans = {};
  for (const [label, result] of Object.entries(results)) {
    scans[label] = {
      moderate: result.byImpact.moderate,
      minor: result.byImpact.minor,
    };
  }
  const payload = {
    version: 1,
    note: 'Reviewed moderate/minor axe findings per scan (tags wcag2a/2aa/21a/21aa/22aa). '
      + 'A scan may not add ids; fix the finding or review it and record it here.',
    scans,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}
