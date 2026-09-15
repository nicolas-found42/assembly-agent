// ci-guards fixture (negative case, driven by test/ci-guards.test.mjs): an accidental
// focused test. The runner's source scan must reject the entry from its text alone,
// before spawning anything, so the marker file below must never appear — it is the
// proof of non-execution, and it is the only thing this module does when it runs.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

export const MARKER = path.join(tmpdir(), 'ci-guards-only-fixture.marker');

writeFileSync(MARKER, 'ran\n');

test.only('would hide every other test in the file', () => { });
