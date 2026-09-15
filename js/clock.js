// clock.js — the turn's time context, resolved from the device clock.
//
// The local date and time always come from Intl.DateTimeFormat in the IANA
// timezone that Intl itself reports (resolvedOptions().timeZone), never from
// slicing the UTC string: a UTC string is the same instant, not the user's
// wall clock, and slicing it silently invents a date across midnight and
// across both DST transitions. The clock is read on every call — the module is
// never frozen at import, and setClockSeam() swaps the source at runtime so
// tests are deterministic without monkey-patching Date.
//
// Failure modes are explicit, never guessed:
// - no usable timezone (no Intl, no resolved zone, or an unknown IANA name):
//   tzAvailable:false, timezone:null, offset:null, date/time fall back to the
//   UTC wall clock and the context carries fallback:true.
// - invalid clock value (NaN or out-of-range Date): unavailable:true plus null
//   date/time fields, so a caller can say "time unknown" instead of lying.
//
// Seam contract: setClockSeam(fn) where fn() returns
//   - a Date                       → that instant, device timezone, source 'seam'
//   - { now?, timezone?, ...fields } → overrides; timezone:null forces the
//     fallback path, any context field (utc/localDate/...) wins verbatim
//   - null / a throwing fn          → device clock, source 'device'
// setClockSeam(null) restores the device clock.

const ISO_MS_RE = /\.\d{3}Z$/;
// Fields an override may set verbatim. `timezone` is absent on purpose:
// buildContext already resolved spec.timezone, and an unusable name must stay
// null (fallback) rather than be echoed back as if it were real.
const CONTEXT_FIELDS = [
 'utc', 'localDate', 'localTime', 'offset',
 'source', 'tzAvailable', 'fallback', 'unavailable', 'reason',
];

const pad = (n) => String(n).padStart(2, '0');

/** Active seam, or null for the device clock. */
let seam = null;

/**
 * setClockSeam(fn|null) — install a test seam, or restore the device clock.
 * Anything that is not a function (including null) restores the device clock.
 */
export function setClockSeam(fn) {
 seam = typeof fn === 'function' ? fn : null;
}

/** The IANA zone the device reports, or null when Intl cannot say. */
function deviceTimezone() {
 try {
  if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return null;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof tz === 'string' && tz ? tz : null;
 } catch {
  return null;
 }
}

/** True when Intl accepts the zone name (unknown names throw RangeError). */
function usableTimezone(tz) {
 if (typeof tz !== 'string' || !tz) return false;
 try {
  new Intl.DateTimeFormat('en-US', { timeZone: tz });
  return true;
 } catch {
  return false;
 }
}

/**
 * Wall-clock fields for `date` in `tz`, via Intl only. hourCycle h23 keeps
 * midnight at "00" (hour12:false can still yield "24" on some engines).
 */
function localParts(date, tz) {
 const dtf = new Intl.DateTimeFormat('en-US', {
  timeZone: tz,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
 });
 const raw = {};
 for (const { type, value } of dtf.formatToParts(date)) raw[type] = value;
 const parts = {
  year: Number(raw.year), month: Number(raw.month), day: Number(raw.day),
  hour: Number(raw.hour), minute: Number(raw.minute), second: Number(raw.second),
 };
 parts.date = `${raw.year}-${raw.month}-${raw.day}`;
 parts.time = `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
 return parts;
}

/** Offset string ('-04:00', '+05:30') of `tz` at the instant `date`. */
function offsetString(date, parts) {
 const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
 const minutes = Math.round((asUTC - date.getTime()) / 60000);
 const abs = Math.abs(minutes);
 return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Base context for one instant; `timezone` undefined means "ask the device". */
function buildContext(date, timezone, source) {
 if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
  return {
   utc: null, localDate: null, localTime: null,
   timezone: null, offset: null, source,
   tzAvailable: false, fallback: true, unavailable: true,
   reason: 'invalid clock value',
  };
 }
 const utc = date.toISOString().replace(ISO_MS_RE, 'Z');
 const zone = timezone === undefined ? deviceTimezone() : timezone;
 if (!usableTimezone(zone)) {
  const parts = localParts(date, 'UTC');
  return {
   utc, localDate: parts.date, localTime: parts.time,
   timezone: null, offset: null, source,
   tzAvailable: false, fallback: true,
  };
 }
 const parts = localParts(date, zone);
 return {
  utc, localDate: parts.date, localTime: parts.time,
  timezone: zone, offset: offsetString(date, parts), source,
  tzAvailable: true, fallback: false,
 };
}

/**
 * runtimeContext() — the current time context, recomputed on every call.
 *
 * { utc:'2026-09-15T10:30:45Z', localDate:'2026-09-15', localTime:'06:30:45',
 *   timezone:'America/New_York'|null, offset:'-04:00'|null,
 *   source:'device'|'seam', tzAvailable:boolean, fallback:boolean,
 *   [unavailable:true, reason:string] }
 */
export function runtimeContext() {
 let override = null;
 let readError = false;
 if (seam) {
  try {
   override = seam();
  } catch {
   override = null;
   readError = true;
  }
 }
 const spec = override && typeof override === 'object' && !(override instanceof Date) ? override : null;
 const now = override instanceof Date ? override
  : spec && spec.now instanceof Date ? spec.now
   : new Date();
 const usedSeam = Boolean(seam) && !readError && override != null;
 const source = spec && spec.source !== undefined ? spec.source : (usedSeam ? 'seam' : 'device');

 const ctx = buildContext(now, spec ? spec.timezone : undefined, source);
 if (spec) {
  for (const key of CONTEXT_FIELDS) {
   if (spec[key] !== undefined) ctx[key] = spec[key];
  }
  // An explicit wall clock replaces the synthesized unavailability marker.
  if (spec.utc !== undefined || spec.localDate !== undefined || spec.localTime !== undefined) {
   delete ctx.unavailable;
   delete ctx.reason;
  }
 }
 return ctx;
}

/**
 * clockLine(ctx) — one human-readable line for the model prompt. Pass a
 * context to render a stored one; omit it to read the clock now.
 */
export function clockLine(ctx) {
 const c = ctx && typeof ctx === 'object' ? ctx : runtimeContext();
 const source = c.source ?? 'device';
 if (c.unavailable) {
  return `Current date and time: unavailable (${c.reason ?? 'invalid clock value'}). Clock source: ${source}.`;
 }
 const local = `${c.localDate ?? 'unknown'} ${c.localTime ?? 'unknown'}`;
 const zone = c.timezone
  ? `${c.offset ? `UTC${c.offset} ` : ''}${c.timezone}`
  : 'UTC wall clock, timezone unavailable';
 return `Current date and time: ${local} (${zone}), UTC ${c.utc ?? 'unknown'}. Clock source: ${source}.`;
}
