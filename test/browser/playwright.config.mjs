// playwright.config.mjs — the browser suite (manifest class "browser").
//
//   npm run test:browser                       -> run-tests.mjs --class browser
//   npx playwright test --config test/browser/playwright.config.mjs
//   npx playwright test --config test/browser/playwright.config.mjs --project=firefox --project=webkit
//
// The suite runs against the STAGED artifact in _site/, served the same way the
// promotion guard serves it (scripts/serve-site.mjs at /assembly-agent/), with a
// local fixture server standing in for the Worker proxy and every external
// origin (test/browser/fixture-server.mjs). Nothing reaches the internet.
//
// Deliberate choices:
//   * workers 1 / fullyParallel false — the app owns real ports and a shared
//     _site/, and the fixture server keeps one request log;
//   * retries 0 — a flake must surface, never be papered over;
//   * forbidOnly — a stray .only fails the run instead of silently shrinking it;
//   * reuseExistingServer false everywhere — the harness never adopts a server
//     it did not start (scripts/serve-site.mjs refuses a taken port by design).

import { defineConfig, devices } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL, FIXTURE_ORIGIN, FIXTURE_PORT, SITE_ORIGIN, SITE_PORT } from './lib/ports.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const siteDir = path.join(root, '_site');
const BUILD_HINT = 'Run `npm run build` to stage the production artifact in _site/, then run `npm run test:browser` again.';

// ── preflight: the artifact under test must exist AND be current ───────────
// Testing a stale _site/ would report green on code nobody is shipping, so the
// app's own files are compared byte for byte with the working tree.
function preflight() {
  const required = ['index.html', 'styles.css', 'dist/agent.wasm',
    'vendor/marked.min.js', 'vendor/purify.min.js', 'vendor/highlight.min.js'];
  const missing = required.filter((rel) => !existsSync(path.join(siteDir, rel)));
  if (missing.length) {
    throw new Error(`_site/ is missing or incomplete (${missing.join(', ')}). ${BUILD_HINT}`);
  }

  const stale = [];
  const stagedJs = readdirSync(path.join(siteDir, 'js')).filter((f) => f.endsWith('.js')).sort();
  const sourceJs = readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js')).sort();
  for (const name of sourceJs) if (!stagedJs.includes(name)) stale.push(`js/${name} (not staged)`);
  for (const name of stagedJs) {
    if (!sourceJs.includes(name)) { stale.push(`js/${name} (no source)`); continue; }
    if (!readFileSync(path.join(root, 'js', name)).equals(readFileSync(path.join(siteDir, 'js', name)))) {
      stale.push(`js/${name} (stale bytes)`);
    }
  }
  for (const rel of ['index.html', 'styles.css']) {
    if (!readFileSync(path.join(root, rel)).equals(readFileSync(path.join(siteDir, rel)))) stale.push(`${rel} (stale bytes)`);
  }
  if (stale.length) {
    throw new Error(`_site/ does not match the working tree: ${stale.join(', ')}. ${BUILD_HINT}`);
  }
}

preflight();

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.mjs',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30000,
  forbidOnly: true,
  expect: { timeout: 5000 },
  // Absolute: Playwright resolves these two against the config file, and the
  // contracted locations are repo-root test-results/ and artifacts/.
  outputDir: path.join(root, 'test-results', 'browser'),
  // Baselines live with the spec that owns them (committed under test/browser/),
  // separated per project and platform so engines never compare across each other.
  snapshotPathTemplate: '{testDir}/__snapshots__/{testFilePath}/{arg}{-projectName}{-snapshotSuffix}{ext}',
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(root, 'artifacts', 'results', 'browser-playwright.json') }],
  ],
  use: {
    baseURL: BASE_URL,
    // Evidence for the first failing attempt only; no retries means there is no
    // "second attempt" to waste a trace on.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: [
    {
      // cwd is explicit: Playwright defaults it to the config's directory, and
      // both commands are repository-root-relative (they read _site/ and scripts/).
      cwd: root,
      command: `node scripts/serve-site.mjs --root _site --base /assembly-agent --port ${SITE_PORT}`,
      url: `${SITE_ORIGIN}/assembly-agent/`,
      reuseExistingServer: false,
      timeout: 30000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      cwd: root,
      command: `node test/browser/fixture-server.mjs --port ${FIXTURE_PORT}`,
      url: `${FIXTURE_ORIGIN}/__fixture/health`,
      reuseExistingServer: false,
      timeout: 30000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
  // The required `browser` class runs chromium alone: the frozen runner invokes
  // it with no --project flag, and Playwright then runs every declared project.
  // firefox and webkit are declared by the scheduled cross-browser entry point
  // (test/browser/cross-browser/playwright.config.mjs), which selects them with
  // --project=firefox --project=webkit and must not make the required check
  // depend on two more engines being installed.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
