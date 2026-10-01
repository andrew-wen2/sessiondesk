import { describe, expect, it } from "vitest";
import { assignSeeds, pickSeeds, seedFitsContest, seedSourcesFor, type SeedPick } from "@/lib/generation/cascade/seed-slots";
import type { Anchor } from "@/lib/types";

const ref = (id: string, number: number, answer: string | null = "5", source = "AMC10"): Anchor => ({ id, source, number, statement: `problem ${id}`, answer, solution: "s" });
const types: Record<string, string> = { a: "t1", b: "t1", c: "t2", d: "t3", e: "t4", f: "t5" };
const base = {
  candidates: [ref("a", 10), ref("c", 10), ref("b", 12), ref("d", 12), ref("e", 15), ref("f", 15, null)],
  typeOf: (id: string) => types[id],
  fittingTypeIds: new Set(["t1", "t2", "t3", "t4", "t5"]),
  recentSeedIds: [] as string[],
  recentTypeIds: [] as string[],
  rotationKey: "k",
  max: 10,
};
const pick = (a: Anchor, rating?: number): SeedPick => ({ seed: a as Anchor & { id: string }, typeId: a.id!, ...(rating !== undefined ? { rating } : {}) });

describe("pickSeeds", () => {
  it("takes one problem per fitting type and skips problems with no answer", () => {
    const picks = pickSeeds(base);
    expect(picks.map((p) => p.typeId).sort()).toEqual(["t1", "t2", "t3", "t4"]);
    expect(picks.find((p) => p.typeId === "t1")!.seed.id).toMatch(/^[ab]$/);
  });

  it("drops types that don't fit the topic and problems a recent set used", () => {
    const picks = pickSeeds({ ...base, fittingTypeIds: new Set(["t1", "t2"]), recentSeedIds: ["a", "b"] });
    expect(picks.map((p) => p.seed.id)).toEqual(["c"]);
  });

  it("puts types a recent set used last", () => {
    const picks = pickSeeds({ ...base, recentTypeIds: ["t2", "t3"] });
    expect(picks.slice(-2).map((p) => p.typeId).sort()).toEqual(["t2", "t3"]);
  });

  it("is stable for a rotation key, respects max, ignores repeated ids, and carries ratings", () => {
    expect(pickSeeds(base)).toEqual(pickSeeds(base));
    expect(pickSeeds({ ...base, max: 2 })).toHaveLength(2);
    expect(pickSeeds({ ...base, candidates: [...base.candidates, ...base.candidates] })).toHaveLength(4);
    expect(pickSeeds({ ...base, ratingOf: (id) => (id === "d" ? 0.24 : undefined) }).find((p) => p.seed.id === "d")!.rating).toBe(0.24);
  });
});

describe("assignSeeds", () => {
  it("gives each seed the free objective nearest its position", () => {
    const map = assignSeeds([pick(ref("e", 15)), pick(ref("a", 10)), pick(ref("d", 12))], [10, 11, 12, 13, 14, 15]);
    expect(map.get(0)!.seed.id).toBe("a");
    expect(map.get(2)!.seed.id).toBe("d");
    expect(map.get(5)!.seed.id).toBe("e");
    expect(map.size).toBe(3);
  });

  it("places by human rating when seed and target are both rated, so another contest's problem fits", () => {
    const amc12 = pick(ref("x", 6, "5", "AMC12"), 0.243);
    const map = assignSeeds([amc12], [10, 12, 14], [0.22, 0.23, 0.244], "AMC10");
    expect(map.get(2)!.seed.id).toBe("x");
  });

  it("leaves an unrated seed from another contest unplaced, and stops when every objective is taken", () => {
    expect(assignSeeds([pick(ref("x", 12, "5", "AMC12"))], [12], [], "AMC10").size).toBe(0);
    expect(assignSeeds(["a", "c", "d"].map((id) => pick(ref(id, 10))), [10, 11]).size).toBe(2);
  });
});

describe("borrowing seeds from other contests", () => {
  const aime = { competition: "AIME" as const, answerFormat: "integer" as const };
  it("lets AIME borrow HMMT, and keeps AMC to its own contest", () => {
    expect(seedSourcesFor("AIME")).toEqual(["AIME", "HMMT-Nov", "HMMT-Feb"]);
    expect(seedSourcesFor("AMC10")).toEqual(["AMC10"]);
  });
  it("takes a borrowed seed only when its answer already fits the student's contest", () => {
    const hmmt = (answer: string): Anchor => ({ source: "HMMT-Feb", number: 4, statement: "s", answer, solution: null });
    expect(seedFitsContest(hmmt("42"), aime)).toBe(true);
    expect(seedFitsContest(hmmt("\\frac{1}{2}"), aime)).toBe(false);
    expect(seedFitsContest(hmmt("1024"), aime)).toBe(true); // any integer: the variant picks its own answer
    expect(seedFitsContest(hmmt("-3"), aime)).toBe(true);
    expect(seedFitsContest(hmmt("(3,-24)"), aime)).toBe(false);
    expect(seedFitsContest({ source: "AIME", number: 3, statement: "s", answer: "1/2", solution: null }, aime)).toBe(true); // own contest: never filtered
  });
});
