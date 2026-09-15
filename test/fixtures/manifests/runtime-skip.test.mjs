// ci-guards fixture (negative case, driven by test/ci-guards.test.mjs): an unintended
// runtime skip. `{ skip: true }` is invisible to the runner's textual scan (which
// matches the modifier forms), so the summary the reporter prints is the only thing
// that can fail this entry.
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('this one runs', () => {
  assert.equal(1, 1);
});

test('this one does not', { skip: true }, () => {
  assert.equal(1, 1);
});
