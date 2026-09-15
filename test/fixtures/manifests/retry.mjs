// ci-guards fixture (negative case, driven by test/ci-guards.test.mjs): a pass that
// leaned on a retry. Shaped like the TAP footer `node --test --test-retry` emits, so
// the entry would look green — exit 0 and a valid marker — if the runner's retry
// guard were removed. Nothing here asserts anything, on purpose.
console.log('# retried 2');
console.log('ALL RETRY-FIXTURE PASS');
