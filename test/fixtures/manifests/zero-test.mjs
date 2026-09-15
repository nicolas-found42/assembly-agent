// ci-guards fixture (negative case, driven by test/ci-guards.test.mjs): a node --test
// entry that declares no test and no assertion. Node >= 22 synthesizes a file-level
// test for it, so `node --test` exits 0 and reports `tests 1`; only the runner's
// source-based zero-test guard rejects the entry. Nothing here runs on purpose.
