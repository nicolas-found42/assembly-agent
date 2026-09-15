// live-health-budget.test.mjs — the documented probe budget variables are real, and validated offline.
//
// README documents LIVE_HEALTH_MAX_{REQUESTS,TOKENS,DURATION_MS,CONCURRENCY} as repository variables and
// .github/workflows/live-health.yml maps them into the probe step's env:, but only scripts/live-health.mjs
// decides what they mean. This suite spawns that CLI once per documented name and pins the contract the
// workflow relies on: a non-integer and a value above the hard ceiling are each a usage error (exit 2,
// EXIT.usage) raised while the arguments are parsed — before any site, Worker or catalog request is made.
// Nothing here touches the network: the offending value aborts the run first, which is why stdout must be
// empty (no check ran, no report was written) and the report path points into the OS temp dir, never at
// the campaign's artifacts/results/ evidence.
//
// RUN
//   node --test test/live-health-budget.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// name -> the hard ceiling scripts/live-health.mjs prints in its usage text and enforces in HARD_LIMITS.
const CEILINGS = {
  LIVE_HEALTH_MAX_REQUESTS: 1,
  LIVE_HEALTH_MAX_TOKENS: 128,
  LIVE_HEALTH_MAX_DURATION_MS: 60_000,
  LIVE_HEALTH_MAX_CONCURRENCY: 1,
};

/** Run the real CLI with exactly one budget variable set (the others are cleared, so the result does not
  *  depend on whatever the developer's shell exported). */
function runHealth(name, value) {
  const env = { ...process.env };
  for (const key of Object.keys(CEILINGS)) delete env[key];
  env[name] = value;
  env.LIVE_HEALTH_ENABLE_GENERATION = 'false'; // the non-generating mode is the cheapest net anyway
  return spawnSync(
    process.execPath,
    [
      'scripts/live-health.mjs', '--mode', 'health',
      '--base-url', 'https://example.invalid/', '--worker-url', 'https://example.invalid/',
      '--json', join(tmpdir(), `live-health-budget-${process.pid}.json`),
    ],
    { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30_000 },
  );
}

const failure = (res) => `exit ${res.status}${res.signal ? ` signal ${res.signal}` : ''}; stderr: ${res.stderr}`;

for (const [name, ceiling] of Object.entries(CEILINGS)) {
  test(`${name} rejects a non-integer with the usage error before any request`, () => {
    const res = runHealth(name, 'abc');

    assert.equal(res.status, 2, failure(res));
    assert.match(
      res.stderr,
      new RegExp(`LIVE-HEALTH usage error: ${name} must be a non-negative integer \\(got "abc"\\)`),
    );
    assert.match(res.stderr, /usage: node scripts\/live-health\.mjs/);
    assert.equal(res.stdout, '', 'no check may run, and no report be written, before the budget is validated');
  });

  test(`${name} rejects a value above the hard ceiling ${ceiling}`, () => {
    const res = runHealth(name, String(ceiling + 1));

    assert.equal(res.status, 2, failure(res));
    assert.match(
      res.stderr,
      new RegExp(`LIVE-HEALTH usage error: ${name}=${ceiling + 1} exceeds the hard ceiling ${ceiling}`),
    );
    assert.equal(res.stdout, '', 'no check may run, and no report be written, before the budget is validated');
  });
}

test('the usage text names every documented budget variable and its ceiling', () => {
  const res = spawnSync(process.execPath, ['scripts/live-health.mjs', '--help'], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000,
  });

  assert.equal(res.status, 0, failure(res));
  for (const [name, ceiling] of Object.entries(CEILINGS)) {
    assert.match(res.stdout, new RegExp(`${name}/${ceiling}`), `${name} is not documented in the usage text`);
  }
});
