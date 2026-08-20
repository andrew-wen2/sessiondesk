import { describe, it, expect } from "vitest";
import {
  monthBounds,
  weekBounds,
  toDateKey,
  parseDateBound,
  exclusiveEndOfDay,
  monthToDateWindows,
} from "./dates";

describe("monthBounds", () => {
  it("spans the month and rolls over December", () => {
    const aug = monthBounds("2026-08");
    expect(aug).toBeTruthy();
    expect(toDateKey(aug!.start)).toBe("2026-08-01");
    expect(toDateKey(aug!.end)).toBe("2026-09-01");
    const dec = monthBounds("2026-12");
    expect(dec).toBeTruthy();
    expect(toDateKey(dec!.end)).toBe("2027-01-01");
  });

  it("handles February in a leap year", () => {
    const feb = monthBounds("2028-02");
    expect(feb).toBeTruthy();
    expect(toDateKey(feb!.end)).toBe("2028-03-01");
    expect(Math.round((feb!.end.getTime() - feb!.start.getTime()) / 86_400_000)).toBe(29);
  });

  it("rejects malformed and out-of-range months", () => {
    for (const m of ["2026-13", "2026-00", "nonsense", "2026-1", ""]) {
      expect(monthBounds(m)).toBeNull();
    }
  });
});

describe("weekBounds", () => {
  it("anchors Sunday or Monday and spans 7 days", () => {
    // Wed Aug 12 2026.
    const anchor = new Date(2026, 7, 12);
    const sun = weekBounds(anchor, 0);
    expect(toDateKey(sun.start)).toBe("2026-08-09");
    expect(toDateKey(sun.end)).toBe("2026-08-16");
    const mon = weekBounds(anchor, 1);
    expect(toDateKey(mon.start)).toBe("2026-08-10");
    expect(toDateKey(mon.end)).toBe("2026-08-17");
  });

  it("treats a boundary day as the start of its own week", () => {
    const sunday = new Date(2026, 7, 9);
    expect(toDateKey(weekBounds(sunday, 0).start)).toBe("2026-08-09");
    // The same Sunday belongs to the PREVIOUS Monday-anchored week.
    expect(toDateKey(weekBounds(sunday, 1).start)).toBe("2026-08-03");
  });
});

describe("toDateKey", () => {
  it("uses local components, not UTC", () => {
    // 00:30 local on Aug 10 is 04:30Z — toISOString would still say the 10th here,
    // so use a late-evening time where UTC has already rolled over.
    const lateEvening = new Date(2026, 7, 10, 23, 30);
    expect(toDateKey(lateEvening)).toBe("2026-08-10");
    expect(lateEvening.toISOString().slice(0, 10)).toBe("2026-08-11");
  });
});

describe("parseDateBound", () => {
  it("reads YYYY-MM-DD as a local midnight", () => {
    const d = parseDateBound("2026-08-11");
    expect(d).toBeTruthy();
    expect(toDateKey(d!)).toBe("2026-08-11");
    expect(d!.getHours()).toBe(0);
  });

  it("rejects malformed input", () => {
    for (const raw of ["", undefined, "2026-8-11", "11/08/2026", "nonsense", "2026-08"]) {
      expect(parseDateBound(raw)).toBeNull();
    }
  });

  it("rejects a date that doesn't exist", () => {
    // Date() rolls 2026-02-31 forward to March 3 rather than failing, which would
    // silently query a range the URL never asked for. The student page treats null
    // as "no usable bound" and falls back to its default window instead.
    expect(parseDateBound("2026-02-31")).toBeNull();
    expect(parseDateBound("2026-13-01")).toBeNull();
    // A real leap day still parses.
    expect(parseDateBound("2024-02-29")).toBeTruthy();
  });
});

describe("exclusiveEndOfDay", () => {
  it("makes a 'to' bound cover its whole day", () => {
    const to = parseDateBound("2026-08-11");
    expect(to).toBeTruthy();
    const end = exclusiveEndOfDay(to!);
    expect(toDateKey(end)).toBe("2026-08-12");
    // A session at 23:59 on the 11th falls inside [to, end).
    expect(new Date(2026, 7, 11, 23, 59) < end).toBe(true);
  });

  it("rolls over a month and a year end", () => {
    expect(toDateKey(exclusiveEndOfDay(new Date(2026, 7, 31)))).toBe("2026-09-01");
    expect(toDateKey(exclusiveEndOfDay(new Date(2026, 11, 31)))).toBe("2027-01-01");
  });
});

describe("monthToDateWindows", () => {
  it("compares against the same elapsed span last month", () => {
    const now = new Date(2026, 7, 13, 14, 30); // Aug 13, mid-afternoon
    const { monthStart, priorStart, priorEnd } = monthToDateWindows(now);
    expect(toDateKey(monthStart)).toBe("2026-08-01");
    expect(toDateKey(priorStart)).toBe("2026-07-01");
    // priorEnd lands at the same time-of-day, one calendar month earlier — same
    // elapsed length as monthStart..now, which is what keeps the comparison honest.
    expect(priorEnd.getTime() - priorStart.getTime()).toBe(now.getTime() - monthStart.getTime());
    expect(priorEnd.getDate()).toBe(13);
    expect(priorEnd.getHours()).toBe(14);
  });

  it("caps the prior span at month end for a short prior month", () => {
    // Mar 31 is 30 elapsed days into March; Feb only has 28. The naive prior-month
    // window would spill 2 days into March itself — assert it's capped at monthStart.
    const now = new Date(2026, 2, 31, 12, 0); // Mar 31
    const { monthStart, priorEnd } = monthToDateWindows(now);
    expect(priorEnd.getTime()).toBe(monthStart.getTime());
  });
});
