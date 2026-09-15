// cross-browser/playwright.config.mjs — the `scheduled-browser` class entry.
//
// Same suite, same specs, same servers as the required `browser` class: what
// differs is which engines run it, and that selection is the class's own
// `--project=firefox --project=webkit` flags (scripts/run-tests.mjs appends them
// for scheduled-browser). This file is the second, distinct suite path the
// manifest needs for that class (test/manifest.json rejects a path listed twice)
// — it must not fork the suite, so everything but three fields is re-exported
// from the single shared config.
//
// The three fields that cannot be inherited as-is:
//   * testDir — Playwright resolves a relative testDir against the CONFIG FILE,
//     so the shared config's '.' would point here instead of test/browser/.
//   * projects — the shared config declares chromium only (the required class
//     runs with no --project flag and would otherwise run every project); the
//     engines the cross-browser class selects must be declared here.
//   * reporter — the two classes must not overwrite each other's JSON report.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { devices } from '@playwright/test';
import base from '../playwright.config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..', '..');

export default {
  ...base,
  testDir: path.join(here, '..'),
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(root, 'artifacts', 'results', 'scheduled-browser-playwright.json') }],
  ],
};
