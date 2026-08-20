// Time-bucketing for the dashboard charts. Pure — no Prisma, no React — so the
// server page and the client chart components can call the SAME functions and agree.
// That symmetry is the point: the charts render server-side first, then re-bucket in
// the viewer's timezone after mount, and any divergence between the two paths would
// show up as a hydration mismatch. One implementation, two callers.
//
// Kept out of lib/dates.ts, whose header scopes it to *range* math — turning a range
// into a series of buckets and folding rows into them is a different concern.
//
// Timezone: every bucket boundary is built from LOCAL date components, so on the
// server (Vercel runs UTC) buckets are UTC-aligned and in the browser they are the
// tutor's. That is exactly why the charts re-run these functions after mount.

import { weekBounds } from "./dates";
import { countsAsTaught, normalizeStatus } from "./session-status";

// One time bucket. Half-open [start, end): a session starting exactly on `end`
// belongs to the next bucket, never to both.
export type Bucket = {
  key: string; // stable identity for React keys and lookups
  start: number; // epoch ms
  end: number; // epoch ms, exclusive
  label: string; // axis label
  // The final bucket of a live series is still filling. Charts must render it
  // differently — an in-progress month always reads as a collapse otherwise.
  partial: boolean;
};

// The minimal session shape the charts need. Deliberately structural rather than the
// Prisma type: the client receives `start` as epoch ms (smaller over the wire and
// already parsed), the server has Dates, and both satisfy this.
export type ChartRow = {
  start: number;
  amount: number;
  paid: boolean;
  status: string;
  studentId: string;
  durationMin: number;
};

const MONTH_LABEL = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad2 = (n: number) => String(n).padStart(2, "0");

// The last `count` calendar months, oldest first, ending on the month containing
// `now` — which is therefore partial.
export function monthSeries(now: Date, count: number): Bucket[] {
  const out: Bucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    // Month arithmetic via the Date constructor, which normalizes overflow: month
    // -1 of 2026 is December 2025. That is what makes the year boundary free.
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    out.push({
      key: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}`,
      start: start.getTime(),
      end: end.getTime(),
      label: MONTH_LABEL[start.getMonth()],
      partial: i === 0,
    });
  }
  return out;
}

// The last `count` Sunday-anchored weeks, oldest first, ending on the week
// containing `now`. Reuses weekBounds so "week" means the same thing here as it
// does on the calendar grid and in the This-week tile.
export function weekSeries(now: Date, count: number): Bucket[] {
  const { start: thisWeek } = weekBounds(now, 0);
  const out: Bucket[] = [];
  for (let i = count - 1; i >= 0; i--) {
    // Stepping by calendar days rather than by 7*86_400_000: a DST week is 23 or 25
    // hours short/long, and fixed-millisecond arithmetic would drift the anchor off
    // Sunday for every week after the transition.
    const start = new Date(
      thisWeek.getFullYear(),
      thisWeek.getMonth(),
      thisWeek.getDate() - i * 7
    );
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    out.push({
      key: `w${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`,
      start: start.getTime(),
      end: end.getTime(),
      label: `${MONTH_LABEL[start.getMonth()]} ${start.getDate()}`,
      partial: i === 0,
    });
  }
  return out;
}

// Does this row count toward taught/billable totals? The array mirror of
// countsAsTaught — cancelled never counts, and a future session hasn't happened yet.
// A no-show DOES count: the slot was held and it is billable.
export function isBillable(row: ChartRow, now: number): boolean {
  return countsAsTaught(normalizeStatus(row.status), new Date(row.start), now);
}

// Fold rows into buckets, summing `valueOf`.
//
// ZERO-FILLED, always: a bucket with no rows returns 0, never a missing entry. A gap
// in a time series reads as "no data" when the truth is "no revenue", and a line
// chart that skips the empty months silently redraws the trend.
export function bucketSum(
  rows: ChartRow[],
  buckets: Bucket[],
  valueOf: (r: ChartRow) => number
): number[] {
  const out = new Array<number>(buckets.length).fill(0);
  for (const row of rows) {
    const i = bucketIndex(buckets, row.start);
    if (i >= 0) out[i] += valueOf(row);
  }
  return out;
}

export function bucketCount(rows: ChartRow[], buckets: Bucket[]): number[] {
  return bucketSum(rows, buckets, () => 1);
}

// Binary search over the (sorted, contiguous) buckets. Linear scan would be fine at
// these sizes; this is here because the half-open comparison is the part that's easy
// to get wrong, and having it in exactly one place is what the boundary check pins.
function bucketIndex(buckets: Bucket[], at: number): number {
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (at < buckets[mid].start) hi = mid - 1;
    else if (at >= buckets[mid].end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// Sessions per weekday (0=Sun) per hour, in LOCAL time. Returns a dense 7 x 24 grid
// so the renderer never has to handle a hole.
//
// This is the one chart that is not merely skewed by UTC bucketing but outright
// wrong: a 5pm ET session is 21:00 UTC, which plots in the wrong row and — for
// evening sessions — the wrong column too.
export function heatmapGrid(rows: ChartRow[], now: number): number[][] {
  const grid: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const row of rows) {
    if (!isBillable(row, now)) continue;
    const d = new Date(row.start);
    grid[d.getDay()][d.getHours()] += 1;
  }
  return grid;
}

// The rows of the heatmap worth drawing: the smallest hour range that contains every
// session, padded to at least a working day so an empty grid isn't one cell tall.
export function heatmapHourRange(grid: number[][]): { from: number; to: number } {
  let from = 24;
  let to = -1;
  for (let h = 0; h < 24; h++) {
    for (let d = 0; d < 7; d++) {
      if (grid[d][h] > 0) {
        if (h < from) from = h;
        if (h > to) to = h;
      }
    }
  }
  if (to < from) return { from: 9, to: 20 }; // no data yet — show a plausible day
  return { from: Math.min(from, 20), to: Math.max(to, from + 3) };
}

export type Slice = { key: string; label: string; value: number };

// Sort descending and fold everything past `n` into a single "Other".
//
// Charts cap their series count rather than generating more hues; here the cap also
// keeps the bar chart readable. The fold must preserve the grand total — a
// composition chart whose parts don't sum to the whole is a lie.
export function topNWithOther(slices: Slice[], n: number): Slice[] {
  const sorted = [...slices].filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  if (sorted.length <= n) return sorted;
  const head = sorted.slice(0, n);
  const tail = sorted.slice(n);
  const rest = tail.reduce((a, s) => a + s.value, 0);
  return rest > 0 ? [...head, { key: "__other", label: "Other", value: rest }] : head;
}

// A "nice" axis maximum — the next 1/2/5 x 10^k at or above `max`, so gridlines land
// on round numbers instead of 1,847. Returns 1 for an all-zero series so callers can
// divide by it without producing NaN in an SVG path.
export function niceMax(max: number): number {
  if (!Number.isFinite(max) || max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const pow = Math.pow(10, exp);
  const frac = max / pow;
  const step = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return step * pow;
}

// Compact money for axis ticks and dense labels: 1250 → "$1.3k". Full figures keep
// their exact value elsewhere; this is only ever a tick or a bar label.
export function compactMoney(n: number): string {
  if (Math.abs(n) >= 1000) {
    const k = n / 1000;
    return `$${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return `$${Math.round(n)}`;
}

// Every series the dashboard charts plot, bucketed from one pass over `rows`.
//
// This is the ONE function both the server page and the client chart component
// call — the server calls it once (Node, UTC) to produce the seed that SSRs and
// matches the first client render bit-for-bit; a client-only `useEffect` (never
// during render) calls it again with the SAME rows and `now`, this time evaluated
// in the browser's local zone, and swaps the state. Nothing here reads the clock —
// `now` always arrives as an argument — so the function itself is exactly as
// deterministic in Node as it is in a browser; only the *caller's* timezone differs.
export type DashboardSeries = {
  monthly: Bucket[];
  revenueByMonth: number[];
  weekly: Bucket[];
  sessionsByWeek: number[];
  heatmap: number[][];
  heatmapRange: { from: number; to: number };
  paidByMonth: number[];
  unpaidByMonth: number[];
};

export function computeDashboardSeries(rows: ChartRow[], now: Date): DashboardSeries {
  const nowMs = now.getTime();
  const monthly = monthSeries(now, 12);
  const weekly = weekSeries(now, 16);
  const billable = rows.filter((r) => isBillable(r, nowMs));
  const paidRows = billable.filter((r) => r.paid);
  const unpaidRows = billable.filter((r) => !r.paid);
  const heatmap = heatmapGrid(rows, nowMs);
  return {
    monthly,
    revenueByMonth: bucketSum(billable, monthly, (r) => r.amount),
    weekly,
    sessionsByWeek: bucketCount(billable, weekly),
    heatmap,
    heatmapRange: heatmapHourRange(heatmap),
    paidByMonth: bucketSum(paidRows, monthly, (r) => r.amount),
    unpaidByMonth: bucketSum(unpaidRows, monthly, (r) => r.amount),
  };
}
