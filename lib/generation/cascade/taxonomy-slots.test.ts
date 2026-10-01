import { describe, expect, it } from "vitest";
import { catalogFor, taxonomySlots } from "./taxonomy-slots";
import type { TaxonomyType } from "@/lib/generation/taxonomy";
import type { CallOpenWeight } from "./verify-cheap";
import type { RungConfig } from "./ladder";

const rung = { provider: "openweight", model: "m", timeoutMs: 1, maxTokens: 1, thinking: "off", toolChoice: "forced" } as RungConfig;
const catalog: TaxonomyType[] = Array.from({ length: 14 }, (_, i) => ({ id: `algebra:${i}`, name: `type ${i}`, category: "algebra", count: 1, numbers: { AMC10: [12] }, methods: [] }));
const choose = (indices: number[]): CallOpenWeight => async () => ({ ok: true, args: { types: indices } });
const base = { rung, plan: { competition: "AMC10" as const, bandLow: 10, bandHigh: 15 }, profile: "p", topic: "t", rotationKey: "k", count: 10, signal: new AbortController().signal, recordUsage: () => {}, catalog };

describe("taxonomySlots", () => {
  it("samples `count` distinct fitting types, never a recent one", async () => {
    const r = await taxonomySlots({ ...base, call: choose([...Array(14).keys()]), recentTypeIds: ["algebra:0", "algebra:1"] });
    expect(r?.types).toHaveLength(10);
    expect(new Set(r!.types.map((t) => t.id)).size).toBe(10);
    expect(r!.types.some((t) => t.id === "algebra:0" || t.id === "algebra:1")).toBe(false);
  });

  it("returns only the fresh types when fewer fit than slots, for the caller to top up", async () => {
    const r = await taxonomySlots({ ...base, call: choose([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), recentTypeIds: ["algebra:0"] });
    expect(r).toMatchObject({ fitting: 10, fresh: 9 });
    expect(r!.types).toHaveLength(9);
    expect(r!.types.some((t) => t.id === "algebra:0")).toBe(false);
  });

  it("ignores out-of-range and duplicate indices, and fails soft", async () => {
    const r = await taxonomySlots({ ...base, call: choose([0, 0, 99, -1, 1]), recentTypeIds: [] });
    expect(r).toMatchObject({ fitting: 2 });
    expect(r!.types.map((t) => t.id).sort()).toEqual(["algebra:0", "algebra:1"]);
    expect(await taxonomySlots({ ...base, call: async () => ({ ok: false, message: "x" }), recentTypeIds: [] })).toBeNull();
  });

  it("draws F=ma sets from mechanics only", () => {
    const all = [...catalog, { ...catalog[0], id: "mechanics:0", category: "mechanics" }];
    expect(catalogFor("Fma", all).map((t) => t.id)).toEqual(["mechanics:0"]);
    expect(catalogFor("AMC10", all)).toHaveLength(14);
  });
});
