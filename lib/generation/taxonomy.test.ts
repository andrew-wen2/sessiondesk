import { describe, expect, it } from "vitest";
import { bandWeight, sampleSlotTypes, type TaxonomyType } from "./taxonomy";

const t = (id: string, numbers: number[] = []): TaxonomyType => ({ id, name: id, category: "algebra", count: numbers.length, numbers: { AMC10: numbers }, methods: [] });
const args = (over: Partial<Parameters<typeof sampleSlotTypes>[0]> = {}) => ({
  candidates: ["a", "b", "c", "d", "e"].map((id) => t(id, [12])),
  count: 3,
  recentTypeIds: [],
  competition: "AMC10",
  bandLow: 10,
  bandHigh: 15,
  rotationKey: "s1",
  ...over,
});

describe("sampleSlotTypes", () => {
  it("draws distinct types, reproducibly per rotation key", () => {
    const a = sampleSlotTypes(args());
    expect(new Set(a.map((x) => x.id)).size).toBe(3);
    expect(sampleSlotTypes(args()).map((x) => x.id)).toEqual(a.map((x) => x.id));
  });

  it("varies across sessions", () => {
    const seen = new Set(Array.from({ length: 20 }, (_, i) => sampleSlotTypes(args({ rotationKey: `s${i}` })).map((x) => x.id).join()));
    expect(seen.size).toBeGreaterThan(3);
  });

  it("never reuses a recent type while fresh ones remain, and tops up from recent only when forced", () => {
    expect(sampleSlotTypes(args({ recentTypeIds: ["a", "b"] })).map((x) => x.id).sort()).toEqual(["c", "d", "e"]);
    expect(sampleSlotTypes(args({ recentTypeIds: ["a", "b", "c"] })).filter((x) => ["a", "b", "c"].includes(x.id))).toHaveLength(1);
  });

  it("favors types real problems at the band use", () => {
    const candidates = [t("typical", [10, 11, 12, 13, 14, 15, 12, 13]), t("rare", [1, 25])];
    let typical = 0;
    for (let i = 0; i < 200; i++) if (sampleSlotTypes(args({ candidates, count: 1, rotationKey: `k${i}` }))[0].id === "typical") typical++;
    expect(typical).toBeGreaterThan(170);
    expect(bandWeight(candidates[1], "AMC10", 10, 15)).toBeCloseTo(0.25);
  });
});
