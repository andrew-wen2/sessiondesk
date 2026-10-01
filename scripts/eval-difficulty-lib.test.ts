import { describe, expect, it } from "vitest";
import { accuracy, bandCurve, curveSpread, gateVerdict, nonIncreasing, pickPerNumber, placeOnCurve, type DifficultyItem } from "./eval-difficulty-lib";

const item = (number: number | null, results: (boolean | "err")[], kind: DifficultyItem["kind"] = "real"): DifficultyItem => ({
  id: `${kind}-${number}-${results.join()}`,
  kind,
  number,
  trials: results.map((r) => (r === "err" ? { error: "timeout" } : { correct: r })),
});

describe("pickPerNumber", () => {
  const rows = [1, 1, 1, 1, 2, 2, 3].map((number, i) => ({ id: `p${i}`, number }));
  it("takes up to N per position in range, the same ones every time", () => {
    const a = pickPerNumber(rows, 2, 1, 2);
    expect(a.map((r) => r.number)).toEqual([1, 1, 2, 2]);
    expect(pickPerNumber([...rows].reverse(), 2, 1, 2)).toEqual(a);
  });
});

describe("accuracy", () => {
  it("does not count errors as attempts", () => {
    expect(accuracy([item(1, [true, false, "err"])])).toEqual({ correct: 1, answered: 2, rate: 0.5 });
    expect(accuracy([item(1, ["err"])]).rate).toBeNull();
  });
});

describe("nonIncreasing", () => {
  it("pools a noisy rise into a flat step, weighted by trials", () => {
    nonIncreasing([0.9, 0.6, 0.8, 0.3], [1, 1, 1, 1]).forEach((v, i) => expect(v).toBeCloseTo([0.9, 0.7, 0.7, 0.3][i]));
    nonIncreasing([0.6, 0.9], [3, 1]).forEach((v) => expect(v).toBeCloseTo(0.675));
  });
});

describe("placeOnCurve", () => {
  const real = [item(1, [true, true, true, true]), item(6, [true, true, true, false]), item(11, [true, true, false, false]), item(16, [false, false, false, true])];
  const curve = bandCurve(real, 5, 1, 20); // mids 3, 8, 13, 18 at 1.0, 0.75, 0.5, 0.25

  it("interpolates between band midpoints", () => {
    expect(placeOnCurve(curve, 0.625)).toEqual({ kind: "at", number: 10.5 });
    expect(placeOnCurve(curve, 0.75)).toEqual({ kind: "at", number: 8 });
  });

  it("reports a bound when the rate is off either end", () => {
    expect(placeOnCurve(curve, 1)).toEqual({ kind: "at", number: 3 }); // ties the easiest band
    expect(placeOnCurve(bandCurve([item(1, [true, false]), item(6, [false, false])], 5, 1, 10), 0.9)).toEqual({ kind: "easier-than", number: 3 });
    expect(placeOnCurve(curve, 0.1)).toEqual({ kind: "harder-than", number: 18 });
  });

  it("measures how much the curve can discriminate", () => {
    expect(curveSpread(curve)).toBeCloseTo(0.75);
    expect(curveSpread(bandCurve([item(1, [true]), item(6, [true])], 5, 1, 10))).toBe(0);
  });
});

describe("gateVerdict", () => {
  it("passes a set that plays like the middle of the band, and fails the ends or beyond", () => {
    expect(gateVerdict({ kind: "at", number: 8 }, 0.4, [1, 15]).pass).toBe(true);
    expect(gateVerdict({ kind: "at", number: 7.9 }, 0.4, [1, 15]).pass).toBe(true);
    // Inside the band but a set of warm-ups: the case the first gate let through.
    expect(gateVerdict({ kind: "at", number: 3 }, 0.4, [1, 15])).toEqual({ pass: false, reason: "plays like #3.0, outside #4.5-11.5, the middle of #1-15" });
    expect(gateVerdict({ kind: "at", number: 17.2 }, 0.4, [1, 15]).pass).toBe(false);
    expect(gateVerdict({ kind: "easier-than", number: 3 }, 0.4, [1, 15]).pass).toBe(false);
    expect(gateVerdict({ kind: "at", number: 21 }, 0.4, [21, 25]).pass).toBe(true); // narrow band: at least ±2
  });
  it("refuses to pass on a curve too flat to measure", () => {
    expect(gateVerdict({ kind: "at", number: 8 }, 0.1, [1, 15]).pass).toBe(false);
  });
});
