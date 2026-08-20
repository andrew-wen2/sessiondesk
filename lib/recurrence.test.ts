import { describe, it, expect } from "vitest";
import { expandLocal, parseOccurrences, MAX_OCCURRENCES } from "./recurrence";
import { toDateKey } from "./dates";

const hourOf = (d: Date) => d.getHours();
const iso = (s: string) => new Date(s).toISOString();

describe("expandLocal", () => {
  it("weekly expansion is inclusive of the until date", () => {
    // Aug 10 2026 is a Monday; until Aug 31 (also a Monday) → 10, 17, 24, 31.
    const out = expandLocal("2026-08-10", "17:00", "weekly", "2026-08-31");
    expect(out.length).toBe(4);
    expect(toDateKey(out[0])).toBe("2026-08-10");
    expect(toDateKey(out[3])).toBe("2026-08-31");
  });

  it("until one day before an occurrence excludes it", () => {
    const out = expandLocal("2026-08-10", "17:00", "weekly", "2026-08-30");
    expect(out.length).toBe(3);
    expect(toDateKey(out[2])).toBe("2026-08-24");
  });

  it("biweekly steps 14 days, not 15", () => {
    const out = expandLocal("2026-08-10", "17:00", "biweekly", "2026-09-30");
    expect(out.map(toDateKey)).toEqual(["2026-08-10", "2026-08-24", "2026-09-07", "2026-09-21"]);
  });

  it("repeat 'none' yields exactly the one start", () => {
    const out = expandLocal("2026-08-10", "17:00", "none", "");
    expect(out.length).toBe(1);
    expect(toDateKey(out[0])).toBe("2026-08-10");
  });

  it("until before the start date yields nothing", () => {
    expect(expandLocal("2026-08-10", "17:00", "weekly", "2026-08-09")).toEqual([]);
  });

  it("until on the start date yields exactly one", () => {
    const out = expandLocal("2026-08-10", "17:00", "weekly", "2026-08-10");
    expect(out.length).toBe(1);
  });

  it("expansion truncates at MAX_OCCURRENCES", () => {
    const out = expandLocal("2026-01-05", "17:00", "weekly", "2028-01-05");
    expect(out.length).toBe(MAX_OCCURRENCES);
  });

  it("malformed inputs yield nothing rather than Invalid Dates", () => {
    expect(expandLocal("not-a-date", "17:00", "weekly", "2026-08-31")).toEqual([]);
    expect(expandLocal("2026-08-10", "25:00", "weekly", "2026-08-31")).toEqual([]);
    expect(expandLocal("2026-08-10", "17:00", "weekly", "nope")).toEqual([]);
    // Feb 30 rolls into March in the Date constructor — must be rejected, not accepted.
    expect(expandLocal("2026-02-30", "17:00", "none", "")).toEqual([]);
  });

  it("DST fall-back: 5pm stays 5pm across the November transition", () => {
    // US DST ends Sun Nov 1 2026. A Sunday series spanning it must not drift to 4pm.
    const out = expandLocal("2026-10-18", "17:00", "weekly", "2026-11-15");
    expect(out.length).toBeGreaterThanOrEqual(4);
    for (const d of out) expect(hourOf(d)).toBe(17);
    // And the underlying instants really do differ by more than a flat 7 days once
    // the clocks change — proving we stepped calendar days, not fixed milliseconds.
    const week = 7 * 24 * 60 * 60 * 1000;
    const spans = out.slice(1).map((d, i) => d.getTime() - out[i].getTime());
    expect(spans.some((s) => s !== week)).toBe(true);
  });

  it("DST spring-forward: 5pm stays 5pm across the March transition", () => {
    // US DST starts Sun Mar 8 2026.
    const out = expandLocal("2026-02-22", "17:00", "weekly", "2026-03-22");
    expect(out.length).toBeGreaterThanOrEqual(4);
    for (const d of out) expect(hourOf(d)).toBe(17);
  });
});

describe("parseOccurrences", () => {
  it("accepts a well-formed ascending array", () => {
    const r = parseOccurrences([iso("2026-08-10T21:00:00Z"), iso("2026-08-17T21:00:00Z")]);
    expect(r.ok).toBe(true);
  });

  it("rejects non-arrays, empties and over-long arrays", () => {
    expect(parseOccurrences("nope").ok).toBe(false);
    expect(parseOccurrences([]).ok).toBe(false);
    const many = Array.from({ length: MAX_OCCURRENCES + 1 }, (_, i) =>
      new Date(Date.UTC(2026, 0, 1 + i)).toISOString()
    );
    expect(parseOccurrences(many).ok).toBe(false);
  });

  it("rejects unsorted, duplicate and unparseable entries", () => {
    expect(parseOccurrences([iso("2026-08-17T21:00:00Z"), iso("2026-08-10T21:00:00Z")]).ok).toBe(
      false
    );
    expect(parseOccurrences([iso("2026-08-10T21:00:00Z"), iso("2026-08-10T21:00:00Z")]).ok).toBe(
      false
    );
    expect(parseOccurrences([iso("2026-08-10T21:00:00Z"), "banana"]).ok).toBe(false);
    expect(parseOccurrences([{ start: "x" }]).ok).toBe(false);
  });

  it("rejects a span beyond 400 days", () => {
    expect(
      parseOccurrences([iso("2026-01-01T00:00:00Z"), iso("2027-06-01T00:00:00Z")]).ok
    ).toBe(false);
  });
});
