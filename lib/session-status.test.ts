import { describe, it, expect } from "vitest";
import {
  isSessionStatus,
  normalizeStatus,
  effectiveStatus,
  isOwed,
  owedAmount,
  countsAsTaught,
} from "./session-status";

const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);
const PAST = new Date(NOW - 86_400_000).toISOString();
const FUTURE = new Date(NOW + 86_400_000).toISOString();

describe("isSessionStatus", () => {
  it("accepts exactly the four values", () => {
    for (const s of ["scheduled", "completed", "cancelled", "no_show"]) {
      expect(isSessionStatus(s)).toBe(true);
    }
    for (const s of ["", null, undefined, "COMPLETED", "deleted", 3]) {
      expect(isSessionStatus(s)).toBe(false);
    }
  });
});

describe("normalizeStatus", () => {
  it("degrades unknown values to scheduled", () => {
    expect(normalizeStatus("no_show")).toBe("no_show");
    expect(normalizeStatus("garbage")).toBe("scheduled");
    expect(normalizeStatus(null)).toBe("scheduled");
  });
});

describe("effectiveStatus", () => {
  it("derives completed only for past scheduled sessions", () => {
    expect(effectiveStatus("scheduled", PAST, NOW)).toBe("completed");
    expect(effectiveStatus("scheduled", FUTURE, NOW)).toBe("scheduled");
    // Every explicit status is left exactly as stored.
    for (const s of ["completed", "cancelled", "no_show"] as const) {
      expect(effectiveStatus(s, PAST, NOW)).toBe(s);
      expect(effectiveStatus(s, FUTURE, NOW)).toBe(s);
    }
  });
});

describe("isOwed / owedAmount", () => {
  it("owed = unpaid AND started AND not cancelled, across all 16 combinations", () => {
    for (const status of ["scheduled", "completed", "cancelled", "no_show"] as const) {
      for (const start of [PAST, FUTURE]) {
        for (const paid of [true, false]) {
          const expected = !paid && start === PAST && status !== "cancelled";
          expect(isOwed({ paid, start, status }, NOW)).toBe(expected);
          expect(owedAmount({ paid, start, status, amount: 90 }, NOW)).toBe(expected ? 90 : 0);
        }
      }
    }
  });

  it("a past unpaid no-show is owed; a cancelled session never is", () => {
    expect(owedAmount({ paid: false, start: PAST, status: "no_show", amount: 75 }, NOW)).toBe(75);
    expect(owedAmount({ paid: false, start: PAST, status: "cancelled", amount: 75 }, NOW)).toBe(0);
  });
});

describe("countsAsTaught", () => {
  it("excludes cancelled and the future, includes no-shows", () => {
    expect(countsAsTaught("no_show", PAST, NOW)).toBe(true);
    expect(countsAsTaught("completed", PAST, NOW)).toBe(true);
    expect(countsAsTaught("cancelled", PAST, NOW)).toBe(false);
    expect(countsAsTaught("scheduled", FUTURE, NOW)).toBe(false);
  });
});
