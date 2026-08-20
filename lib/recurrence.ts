// Recurring-session expansion. A repeating slot is materialized into real Session
// rows sharing a seriesId — there is no RRULE stored anywhere, and Google Calendar
// gets ordinary single events (lib/gcal.ts emits no recurrence).
//
// WHY EXPANSION RUNS IN THE BROWSER, not on the server:
// stepping by 7*24*60*60*1000 ms shifts the wall-clock hour across a DST transition
// (a 5pm series silently becomes 4pm in November). The correct primitive is stepping
// LOCAL calendar days — new Date(y, m, d + 7*k, hh, mm) — but that uses the *process*
// timezone, and Vercel runs in UTC, which would reintroduce the identical bug for any
// tutor not on UTC. The browser already owns local→instant conversion here
// (AddSessionModal does `new Date(\`${date}T${time}\`).toISOString()`), so expansion
// happens there, where "local" means the tutor's own zone. The server re-validates the
// resulting instants with parseOccurrences below rather than trusting the array.

import type { Parsed } from "@/lib/validation";

export type Repeat = "none" | "weekly" | "biweekly";

// Hard ceiling on one series. Bounds the create request, the GCal fan-out, and the
// "this and all future" bulk update. A year of weekly sessions is 52.
export const MAX_OCCURRENCES = 52;

// Widest span parseOccurrences will accept, as a sanity bound independent of the
// count (52 occurrences can't legitimately stretch past ~a year and change).
const MAX_SPAN_DAYS = 400;

const STEP_DAYS: Record<Repeat, number> = { none: 0, weekly: 7, biweekly: 14 };

// Expand a start date/time + repeat rule into local-time occurrence instants.
//
// `untilYMD` is INCLUSIVE: an occurrence landing exactly on that date is kept. The
// comparison is against the end of that local day, not an instant — comparing an
// occurrence instant to a bare date is the classic off-by-one here.
//
// Returns [] when the inputs don't parse or when `until` falls before the start date;
// the caller surfaces that as a validation message rather than saving nothing.
// Truncates at MAX_OCCURRENCES — the caller tells the user it capped.
export function expandLocal(
  dateYMD: string,
  timeHM: string,
  repeat: Repeat,
  untilYMD: string
): Date[] {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYMD);
  const tm = /^(\d{2}):(\d{2})$/.exec(timeHM);
  if (!dm || !tm) return [];

  const [, ys, ms_, ds] = dm;
  const [, hs, mins] = tm;
  const y = Number(ys);
  const mo = Number(ms_) - 1;
  const d = Number(ds);
  const hh = Number(hs);
  const mi = Number(mins);
  if (hh > 23 || mi > 59) return [];

  const first = new Date(y, mo, d, hh, mi);
  // Round-trip check: new Date(2026, 1, 30) silently rolls into March.
  if (first.getFullYear() !== y || first.getMonth() !== mo || first.getDate() !== d) return [];

  const step = STEP_DAYS[repeat];
  if (step === 0) return [first];

  const um = /^(\d{4})-(\d{2})-(\d{2})$/.exec(untilYMD);
  if (!um) return [];
  // End of the `until` day in local time, so an occurrence on that date is included
  // regardless of its time.
  const untilEnd = new Date(Number(um[1]), Number(um[2]) - 1, Number(um[3]), 23, 59, 59, 999);
  if (untilEnd.getTime() < first.getTime()) return [];

  const out: Date[] = [];
  for (let k = 0; out.length < MAX_OCCURRENCES; k++) {
    // Step in calendar days, re-deriving the wall-clock time each iteration, so the
    // occurrence stays at hh:mm on both sides of a DST transition.
    const occ = new Date(y, mo, d + step * k, hh, mi);
    if (occ.getTime() > untilEnd.getTime()) break;
    out.push(occ);
  }
  return out;
}

// Server-side guard on the POSTed occurrence array. The client computed these in its
// own timezone and we can't re-derive them here (see the header), so validate shape
// and bounds instead of recomputing: real array, 1..MAX_OCCURRENCES entries, every
// entry a parseable instant, strictly increasing, spanning no more than MAX_SPAN_DAYS.
export function parseOccurrences(raw: unknown): Parsed<Date[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_OCCURRENCES) {
    return { ok: false };
  }

  const out: Date[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" && typeof entry !== "number") return { ok: false };
    const d = new Date(entry);
    if (Number.isNaN(d.getTime())) return { ok: false };
    // Strictly increasing — rejects duplicates and out-of-order arrays.
    if (out.length && d.getTime() <= out[out.length - 1].getTime()) return { ok: false };
    out.push(d);
  }

  const spanMs = out[out.length - 1].getTime() - out[0].getTime();
  if (spanMs > MAX_SPAN_DAYS * 24 * 60 * 60 * 1000) return { ok: false };

  return { ok: true, value: out };
}
