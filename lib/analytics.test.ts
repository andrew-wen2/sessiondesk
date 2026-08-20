import { describe, it, expect } from "vitest";
import {
  monthSeries,
  weekSeries,
  bucketSum,
  bucketCount,
  topNWithOther,
  isBillable,
  niceMax,
  computeDashboardSeries,
  type ChartRow,
} from "./analytics";

const row = (over: Partial<ChartRow>): ChartRow => ({
  start: Date.now(),
  amount: 0,
  paid: false,
  status: "scheduled",
  studentId: "s1",
  durationMin: 60,
  ...over,
});

describe("monthSeries", () => {
  it("returns exactly `count` buckets, oldest first", () => {
    const now = new Date(2026, 7, 11); // Aug 11 2026
    const series = monthSeries(now, 12);
    expect(series.length).toBe(12);
    expect(series[0].label).toBe("Sep"); // Sep 2025, 11 months back
    expect(series[series.length - 1].label).toBe("Aug");
  });

  it("crosses the year boundary without a gap or repeat", () => {
    const now = new Date(2026, 1, 5); // Feb 2026
    const series = monthSeries(now, 4);
    // Nov 2025, Dec 2025, Jan 2026, Feb 2026 — contiguous, and each bucket's end
    // equals the next bucket's start.
    expect(series.map((b) => b.label)).toEqual(["Nov", "Dec", "Jan", "Feb"]);
    for (let i = 1; i < series.length; i++) {
      expect(series[i - 1].end).toBe(series[i].start);
    }
  });
});

describe("monthSeries / weekSeries partial buckets", () => {
  it("only the final bucket is partial", () => {
    const now = new Date(2026, 7, 11);
    for (const series of [monthSeries(now, 6), weekSeries(now, 6)]) {
      series.forEach((b, i) => {
        expect(b.partial).toBe(i === series.length - 1);
      });
    }
  });
});

describe("weekSeries", () => {
  it("is Sunday-anchored and stays 7 local days across DST", () => {
    // Nov 1 2026 is a Sunday; DST ends Nov 1 2026 in America/New_York. A week series
    // spanning that transition must still produce buckets that are exactly 7 LOCAL
    // days apart, even though the elapsed milliseconds differ by an hour.
    const now = new Date(2026, 10, 8); // the following Sunday
    const series = weekSeries(now, 2);
    expect(series.length).toBe(2);
    const [prior, current] = series;
    const priorStart = new Date(prior.start);
    const currentStart = new Date(current.start);
    expect(priorStart.getDay()).toBe(0);
    expect(currentStart.getDay()).toBe(0);
    expect(currentStart.getDate() - priorStart.getDate()).toBe(7);
  });
});

describe("bucketSum / bucketCount", () => {
  it("zero-fills empty buckets rather than omitting them", () => {
    const now = new Date(2026, 7, 11);
    const buckets = monthSeries(now, 3); // Jun, Jul, Aug
    const rows = [row({ start: buckets[2].start + 1000, amount: 90 })]; // only August
    const sums = bucketSum(rows, buckets, (r) => r.amount);
    expect(sums).toEqual([0, 0, 90]);
  });

  it("lands a row exactly on a bucket boundary in exactly one bucket", () => {
    const now = new Date(2026, 7, 11);
    const buckets = monthSeries(now, 2); // Jul, Aug
    const boundary = buckets[1].start; // Aug 1 00:00 — end of Jul, start of Aug
    const counts = bucketCount([row({ start: boundary })], buckets);
    expect(counts).toEqual([0, 1]);
  });
});

describe("isBillable", () => {
  it("excludes cancelled and future sessions, includes no-shows", () => {
    const now = Date.now();
    const past = now - 86_400_000;
    const future = now + 86_400_000;
    expect(isBillable(row({ start: past, status: "scheduled" }), now)).toBe(true);
    expect(isBillable(row({ start: past, status: "completed" }), now)).toBe(true);
    expect(isBillable(row({ start: past, status: "no_show" }), now)).toBe(true);
    expect(isBillable(row({ start: past, status: "cancelled" }), now)).toBe(false);
    expect(isBillable(row({ start: future, status: "scheduled" }), now)).toBe(false);
  });
});

describe("topNWithOther", () => {
  it("preserves the grand total when folding the tail", () => {
    const slices = [
      { key: "a", label: "A", value: 100 },
      { key: "b", label: "B", value: 80 },
      { key: "c", label: "C", value: 60 },
      { key: "d", label: "D", value: 40 },
      { key: "e", label: "E", value: 20 },
    ];
    const total = slices.reduce((a, s) => a + s.value, 0);
    const folded = topNWithOther(slices, 3);
    expect(folded.length).toBe(4); // top 3 + Other
    expect(folded[3].label).toBe("Other");
    expect(folded.reduce((a, s) => a + s.value, 0)).toBe(total);
  });

  it("drops zero/negative slices and skips Other when nothing remains", () => {
    const slices = [
      { key: "a", label: "A", value: 50 },
      { key: "b", label: "B", value: 0 },
    ];
    expect(topNWithOther(slices, 5).map((s) => s.key)).toEqual(["a"]);
  });
});

describe("niceMax", () => {
  it("rounds up to a 1/2/5 step and never returns 0", () => {
    expect(niceMax(0)).toBe(1); // all-zero series must not divide by zero
    expect(niceMax(47)).toBe(50);
    expect(niceMax(120)).toBe(200);
    expect(niceMax(1847)).toBeGreaterThanOrEqual(1847);
  });
});

describe("computeDashboardSeries", () => {
  it("is deterministic for the same rows and now", () => {
    // The whole hydration-safety story rests on this function returning identical
    // output given identical input, regardless of which process calls it — so calling
    // it twice with the same arguments must produce deep-equal results.
    const now = new Date(2026, 7, 11, 10, 0);
    const rows = [
      row({ start: new Date(2026, 6, 3, 15, 0).getTime(), amount: 90, paid: true }),
      row({ start: new Date(2026, 6, 10, 16, 0).getTime(), amount: 60, paid: false }),
      row({ start: new Date(2026, 7, 5, 15, 0).getTime(), amount: 70, status: "cancelled" }),
    ];
    const a = computeDashboardSeries(rows, now);
    const b = computeDashboardSeries(rows, now);
    expect(a).toEqual(b);
  });

  it("paid + unpaid per month equals billable revenue per month", () => {
    const now = new Date(2026, 7, 11);
    const rows = [
      row({ start: new Date(2026, 6, 3, 15, 0).getTime(), amount: 90, paid: true }),
      row({ start: new Date(2026, 6, 10, 16, 0).getTime(), amount: 60, paid: false }),
      row({
        start: new Date(2026, 6, 20, 16, 0).getTime(),
        amount: 40,
        paid: false,
        status: "cancelled",
      }),
    ];
    const s = computeDashboardSeries(rows, now);
    expect(s.monthly.length).toBe(12);
    expect(s.weekly.length).toBe(16);
    for (let i = 0; i < s.monthly.length; i++) {
      expect(s.paidByMonth[i] + s.unpaidByMonth[i]).toBe(s.revenueByMonth[i]);
    }
    // The cancelled row must not appear anywhere.
    const julIndex = s.monthly.findIndex((b) => b.label === "Jul");
    expect(s.revenueByMonth[julIndex]).toBe(90 + 60);
  });
});
