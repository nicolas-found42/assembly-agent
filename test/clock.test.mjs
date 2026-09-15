// clock.test.mjs — contract tests for js/clock.js.
// Fixtures pin the parts of "what time is it" that a UTC string cannot answer:
// the UTC/local date mismatch, midnight (never "24:00:00"), both 2026 US DST
// transitions, the non-whole-hour +05:30 offset, the fallback path when Intl
// has no usable timezone, the invalid-clock marker, and the runtime seam that
// keeps the module unfrozen. All local-time cases force their timezone through
// the seam so the expectations hold on any machine.
// Run: node --test test/clock.test.mjs
import assert from 'node:assert/strict';
import { runtimeContext, setClockSeam, clockLine } from '../js/clock.js';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{2}:\d{2}:\d{2}$/;

/** Read the clock at a fixed instant in a fixed IANA zone. */
const at = (iso, timezone) => {
  setClockSeam(() => ({ now: new Date(iso), timezone }));
  return runtimeContext();
};

// ── device clock (no seam) ──────────────────────────────────────
{
  setClockSeam(null);
  const before = Date.now();
  const ctx = runtimeContext();
  const after = Date.now();

  assert.equal(ctx.source, 'device', 'device clock is the default source');
  assert.match(ctx.utc, ISO_UTC, 'utc is a whole-second ISO instant');
  assert.match(ctx.localDate, ISO_DATE, 'localDate is YYYY-MM-DD');
  assert.match(ctx.localTime, ISO_TIME, 'localTime is HH:MM:SS');
  assert.equal(typeof ctx.tzAvailable, 'boolean', 'tzAvailable is a boolean');

  const instant = Date.parse(ctx.utc);
  assert.ok(instant >= before - 1000 && instant <= after + 1000, 'device reading is the current instant');
  if (ctx.tzAvailable) {
    assert.equal(typeof ctx.timezone, 'string', 'available timezone is an IANA name');
    assert.match(ctx.offset, /^[+-]\d{2}:\d{2}$/, 'offset is ±HH:MM');
    assert.equal(ctx.fallback, false, 'resolved timezone is not a fallback');
  }
  console.log('ok  : device clock shape');
}

// ── UTC/local mismatch and midnight in America/New_York ─────────
{
  // 10:30:45Z → 06:30:45 EDT: same date, different clock (the contract example).
  const ctx = at('2026-09-15T10:30:45Z', 'America/New_York');
  assert.equal(ctx.utc, '2026-09-15T10:30:45Z');
  assert.equal(ctx.timezone, 'America/New_York');
  assert.equal(ctx.localDate, '2026-09-15');
  assert.equal(ctx.localTime, '06:30:45');
  assert.equal(ctx.offset, '-04:00');
  assert.equal(ctx.tzAvailable, true);
  assert.equal(ctx.fallback, false);
  assert.equal(ctx.source, 'seam');
  console.log('ok  : UTC/local mismatch resolved via Intl');

  // 02:00Z is still the previous local evening: the UTC date is NOT the local date.
  const late = at('2026-09-15T02:00:00Z', 'America/New_York');
  assert.equal(late.localDate, '2026-09-14', 'local date trails the UTC date');
  assert.equal(late.localTime, '22:00:00');
  assert.notEqual(late.localDate, late.utc.slice(0, 10), 'sliding the UTC string would be wrong here');
  console.log('ok  : UTC date differs from local date');

  // Midnight is 00:00:00, never 24:00:00.
  const midnight = at('2026-09-15T04:00:00Z', 'America/New_York');
  assert.equal(midnight.localDate, '2026-09-15');
  assert.equal(midnight.localTime, '00:00:00');
  assert.equal(midnight.offset, '-04:00');
  console.log('ok  : midnight stays 00:00:00');
}

// ── DST spring forward (2026-03-08 02:00 EST → 03:00 EDT) ───────
{
  const before = at('2026-03-08T06:59:00Z', 'America/New_York');
  assert.equal(before.localTime, '01:59:00');
  assert.equal(before.offset, '-05:00', 'EST before the jump');

  const after = at('2026-03-08T07:00:00Z', 'America/New_York');
  assert.equal(after.localTime, '03:00:00', 'the 02:00 hour does not exist locally');
  assert.equal(after.offset, '-04:00', 'EDT after the jump');
  assert.equal(after.localDate, '2026-03-08');
  console.log('ok  : spring-forward transition');
}

// ── DST fall back (2026-11-01 02:00 EDT → 01:00 EST) ────────────
{
  // The same wall clock reads 01:30 twice, one hour apart, with different offsets.
  const first = at('2026-11-01T05:30:00Z', 'America/New_York');
  const second = at('2026-11-01T06:30:00Z', 'America/New_York');
  assert.equal(first.localTime, '01:30:00');
  assert.equal(second.localTime, '01:30:00', 'the repeated hour keeps the same wall clock');
  assert.equal(first.offset, '-04:00', 'EDT for the first 01:30');
  assert.equal(second.offset, '-05:00', 'EST for the second 01:30');
  assert.notEqual(first.utc, second.utc, 'two distinct instants');
  console.log('ok  : fall-back transition');
}

// ── non-whole-hour offset: Asia/Kolkata +05:30 ──────────────────
{
  const ctx = at('2026-09-15T10:30:45Z', 'Asia/Kolkata');
  assert.equal(ctx.timezone, 'Asia/Kolkata');
  assert.equal(ctx.offset, '+05:30', 'half-hour offset survives');
  assert.equal(ctx.localTime, '16:00:45');
  assert.equal(ctx.localDate, '2026-09-15');

  const rolled = at('2026-09-14T20:00:00Z', 'Asia/Kolkata');
  assert.equal(rolled.localDate, '2026-09-15', 'local date rolls forward with the half-hour offset');
  assert.equal(rolled.localTime, '01:30:00');
  console.log('ok  : Asia/Kolkata +05:30');
}

// ── fallback: no usable timezone ────────────────────────────────
{
  // Explicit null zone (device without Intl timezone support).
  const none = at('2026-09-15T10:30:45Z', null);
  assert.equal(none.timezone, null);
  assert.equal(none.offset, null);
  assert.equal(none.tzAvailable, false, 'tzAvailable marks the missing zone');
  assert.equal(none.fallback, true, 'fallback is marked, not hidden');
  assert.equal(none.localDate, '2026-09-15', 'date/time fall back to the UTC wall clock');
  assert.equal(none.localTime, '10:30:45');
  assert.equal(none.utc, '2026-09-15T10:30:45Z');

  // Unknown IANA name is the same outcome as a missing one.
  const bogus = at('2026-09-15T10:30:45Z', 'Nowhere/Nope');
  assert.equal(bogus.timezone, null);
  assert.equal(bogus.tzAvailable, false);
  assert.equal(bogus.fallback, true);
  assert.equal(bogus.localTime, '10:30:45');

  const line = clockLine(none);
  assert.ok(line.includes('timezone unavailable'), 'clockLine names the fallback');
  assert.ok(line.endsWith('Clock source: seam.'), 'clockLine names the source');
  console.log('ok  : unavailable timezone falls back to UTC and is marked');
}

// ── invalid clock values ────────────────────────────────────────
{
  setClockSeam(() => new Date(NaN));
  const nan = runtimeContext();
  assert.equal(nan.unavailable, true, 'NaN clock is explicitly unavailable');
  assert.equal(nan.utc, null);
  assert.equal(nan.localDate, null);
  assert.equal(nan.localTime, null);
  assert.equal(nan.offset, null);
  assert.equal(typeof nan.reason, 'string', 'a reason is attached');
  assert.match(clockLine(nan), /unavailable/, 'clockLine refuses to invent a time');

  setClockSeam(() => new Date(8.64e15 + 1)); // one ms past the Date range
  const outOfRange = runtimeContext();
  assert.equal(outOfRange.unavailable, true, 'out-of-range Date is explicitly unavailable');
  assert.equal(outOfRange.utc, null);

  // A throwing seam degrades to the device clock instead of breaking the turn.
  setClockSeam(() => { throw new Error('boom'); });
  const recovered = runtimeContext();
  assert.equal(recovered.source, 'device');
  assert.match(recovered.utc, ISO_UTC, 'device clock still readable');
  console.log('ok  : invalid clock marker, out-of-range, throwing seam');
}

// ── seam injection: the context is not frozen at import ─────────
{
  setClockSeam(() => new Date('2026-09-15T10:30:45Z'));
  const a = runtimeContext();
  setClockSeam(() => new Date('2026-09-15T22:15:00Z'));
  const b = runtimeContext();
  assert.equal(a.source, 'seam', 'a Date seam is still a seam');
  assert.notEqual(a.utc, b.utc, 'two seam values produce two readings');
  assert.notEqual(a.localTime, b.localTime, 'and two different local times');

  setClockSeam(null);
  const device = runtimeContext();
  assert.equal(device.source, 'device', 'null restores the device clock');
  assert.match(device.utc, ISO_UTC);
  console.log('ok  : seam is read per call, module stays unfrozen');
}

// ── full context override wins verbatim ─────────────────────────
{
  setClockSeam(() => ({
    utc: '2026-01-02T03:04:05Z',
    localDate: '2026-01-01',
    localTime: '22:04:05',
    timezone: 'America/New_York',
    offset: '-05:00',
    source: 'override',
    tzAvailable: true,
    fallback: false,
  }));
  const ctx = runtimeContext();
  assert.equal(ctx.utc, '2026-01-02T03:04:05Z');
  assert.equal(ctx.localDate, '2026-01-01');
  assert.equal(ctx.localTime, '22:04:05');
  assert.equal(ctx.timezone, 'America/New_York');
  assert.equal(ctx.offset, '-05:00');
  assert.equal(ctx.source, 'override');
  assert.equal(ctx.unavailable, undefined, 'an explicit clock clears the unavailable marker');
  setClockSeam(null);
  console.log('ok  : full context override is honoured verbatim');
}

// ── clockLine shape ─────────────────────────────────────────────
{
  setClockSeam(() => ({ now: new Date('2026-09-15T10:30:45Z'), timezone: 'America/New_York' }));
  const line = clockLine(); // no argument -> reads the clock now
  assert.equal(line.includes('\n'), false, 'single line');
  assert.ok(line.includes('2026-09-15 06:30:45'), 'local wall clock present');
  assert.ok(line.includes('UTC-04:00'), 'offset present');
  assert.ok(line.includes('America/New_York'), 'timezone present');
  assert.ok(line.includes('2026-09-15T10:30:45Z'), 'UTC instant present');
  assert.ok(line.endsWith('Clock source: seam.'), 'source note ends the line');

  const explicit = clockLine({
    utc: '2026-09-15T10:30:45Z', localDate: '2026-09-15', localTime: '06:30:45',
    timezone: 'America/New_York', offset: '-04:00', source: 'device',
    tzAvailable: true, fallback: false,
  });
  assert.ok(explicit.endsWith('Clock source: device.'), 'device source note');
  assert.ok(explicit.includes('2026-09-15 06:30:45'), 'renders a passed context');

  setClockSeam(null);
  assert.ok(clockLine().endsWith('Clock source: device.'), 'default device line');
  console.log('ok  : clockLine');
}

// ── zero imports check (clock.js must be pure) ──────────────────
{
  const src = (await import('node:fs')).readFileSync(new URL('../js/clock.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('import '), 'clock.js ZERO imports: no import statement');
  assert.ok(!src.includes("from '"), 'clock.js ZERO imports: no from clause');
  console.log('ok  : clock.js zero imports');
}

console.log('ALL CLOCK PASS');
