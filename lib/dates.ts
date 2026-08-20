// Date-range math shared by the routes and pages that query sessions by period.
// Kept separate from lib/format.ts, which is scoped to *formatting* helpers — range
// math is a different concern and mixing them makes both harder to follow.
//
// Timezone note: these build Date objects from LOCAL components, so on Vercel (UTC)
// a "month" or "week" boundary is a UTC boundary. That is the same UTC-vs-local
// hazard app/page.tsx documents; each caller decides how to handle the edge (the
// calendar pads its query ±1 day, the payments ledger accepts a ≤1-day skew).

// Parse a "YYYY-MM" month string into a half-open [start, end) range.
// Returns null for anything that isn't a real month, so callers can 400 on bad input
// instead of silently querying a garbage range (new Date(NaN) never throws).
export function monthBounds(month: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [year, mon] = month.split("-").map(Number);
  if (mon < 1 || mon > 12) return null;
  return { start: new Date(year, mon - 1, 1), end: new Date(year, mon, 1) };
}

// The half-open [start, end) week containing `anchor`. `startsOn` is 0 for Sunday
// (what the calendar grid uses) or 1 for Monday. The app anchors Sunday everywhere;
// the parameter exists so the choice is visible at the call site rather than buried.
export function weekBounds(anchor: Date, startsOn: 0 | 1): { start: Date; end: Date } {
  const offset = (anchor.getDay() - startsOn + 7) % 7;
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - offset);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  return { start, end };
}

// "YYYY-MM-DD" from a date's LOCAL components. Used as a bucketing key and for
// <input type="date"> values — never toISOString().slice(0,10), which would shift
// the day for anyone behind UTC.
export function toDateKey(d: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Parse a "YYYY-MM-DD" filter bound into a local Date, or null.
//
// Timezone caveat, deliberately not "fixed": the server runs in UTC, so this
// boundary is UTC midnight and can sit a few hours off the tutor's local midnight.
// The calendar's trick of padding the range ±1 day is WRONG here — a payments view
// must not show rows outside the range it claims to show — so the ≤1-day edge skew is
// accepted instead. Resolving presets client-side and putting full instants in the
// URL would be exact, at the cost of hand-editable URLs.
export function parseDateBound(raw: string | undefined): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  // Rejects real-looking-but-wrong input such as "2026-02-31", which Date rolls
  // forward to March 3 rather than failing.
  if (Number.isNaN(date.getTime())) return null;
  return date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}

// A "to" bound is inclusive of its whole day, so the exclusive bound handed to Prisma
// is the following midnight. Separate from parseDateBound so the asymmetry between the
// two ends of the range is visible at the call site.
export function exclusiveEndOfDay(bound: Date): Date {
  return new Date(bound.getFullYear(), bound.getMonth(), bound.getDate() + 1);
}

// How recently a student must have been seen to count as "active". Without this,
// students who finished months ago would sit in the attention list forever.
export const ACTIVE_WINDOW_DAYS = 60;

// `days` before `anchor`, snapped to local midnight. Used for the active-student
// window, where "seen in the last 60 days" is a question about whole days.
export function daysBefore(anchor: Date, days: number): Date {
  return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - days);
}

// The two windows behind the "This month" trend: the current month to date, and
// the same elapsed span at the start of the previous calendar month — so the
// comparison is against the SAME kind of number shown on the tile (month-to-date),
// not an unrelated window. Both spans start at their month's day 1 and run for the
// same length of time, which is what keeps the comparison honest — an unequal
// current-vs-prior length biases a trend in whichever direction the longer window
// runs.
//
// Edge case: if the current month is further into its span than the previous
// month is long (e.g. comparing Mar 29-31 against Feb), the prior window is
// capped at `monthStart` — i.e. all of the previous month. This is the same
// asymmetry every "vs last month" comparison accepts industry-wide; there is no
// clean equal-length answer when the two months have different lengths.
export function monthToDateWindows(now: Date): { monthStart: Date; priorStart: Date; priorEnd: Date } {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const elapsed = now.getTime() - monthStart.getTime();
  const priorEnd = new Date(Math.min(prevMonthStart.getTime() + elapsed, monthStart.getTime()));
  return { monthStart, priorStart: prevMonthStart, priorEnd };
}
