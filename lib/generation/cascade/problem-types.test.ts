import { afterEach, describe, expect, it, vi } from "vitest";
import { byTypicality, cleanTypes, excludeSimilar, problemTypes, rotateTypes, typesModelFromEnv } from "./problem-types";
import type { CallOpenWeight } from "./verify-cheap";

afterEach(() => vi.unstubAllEnvs());
const plan = { domain: "Competition math (AMC10)", competition: "AMC10" as const, bandLow: 10, bandHigh: 15 };

describe("typesModelFromEnv", () => {
  it("defaults to a fast open-weight model and can be turned off", () => {
    expect(typesModelFromEnv("easy")).toMatchObject({ model: "deepseek-ai/DeepSeek-V4.1-Flash", thinking: "off" });
    vi.stubEnv("CASCADE_TYPES_MODEL", "off");
    expect(typesModelFromEnv("easy")).toBeNull();
    vi.stubEnv("CASCADE_TYPES_MODEL", "anthropic:claude-opus-5-5");
    expect(() => typesModelFromEnv("easy")).toThrow(/openweight/);
  });
});

describe("cleanTypes", () => {
  it("keeps distinct, non-empty, short phrases", () => {
    expect(cleanTypes(["Work-rate", " work-rate ", "", 7, "Vieta  transforms", "x".repeat(200)])).toEqual(["Work-rate", "Vieta transforms"]);
    expect(cleanTypes("nope")).toEqual([]);
  });
});

describe("rotateTypes", () => {
  const types = ["a", "b", "c", "d", "e", "f", "g", "h"];
  it("keeps every type and starts sessions at different points within the first half", () => {
    const starts = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const r = rotateTypes(types, `session-${i}`);
      expect([...r].sort()).toEqual(types);
      starts.add(r[0]);
    }
    expect(starts.size).toBeGreaterThan(1);
    for (const s of starts) expect(["a", "b", "c", "d"]).toContain(s);
    expect(rotateTypes(types, "same")).toEqual(rotateTypes(types, "same"));
  });
});

describe("problemTypes", () => {
  const rung = typesModelFromEnv("easy")!;
  const run = (call: CallOpenWeight, recentProblems: string[] = []) =>
    problemTypes({ call, rung, plan, profile: "AMC 10 Problems 10-15", topic: "quadratics", recentProblems, signal: new AbortController().signal, recordUsage: () => {} });

  it("names the recent problems' types first, then lists new types excluding them", async () => {
    const users: string[] = [];
    const call: CallOpenWeight = async (_r, prompt) => {
      users.push(prompt.user);
      return users.length === 1
        ? { ok: true, args: { types: ["work-rate: two pipes filling a tank"] } }
        : { ok: true, args: { types: ["Vieta root transform", "work-rate with two pipes filling a pool", "revenue maximization", "Vieta root transform"] } };
    };
    expect(await run(call, ["Two hoses fill a pool in 6 hours."])).toEqual(["Vieta root transform", "revenue maximization"]);
    expect(users[0]).toContain("Two hoses fill a pool in 6 hours.");
    expect(users[1]).toContain("EXCLUDED types");
    expect(users[1]).toContain("work-rate: two pipes filling a tank");
  });

  it("skips the naming step when the student has no history", async () => {
    let calls = 0;
    const call: CallOpenWeight = async () => (calls++, { ok: true, args: { types: ["a type", "b type"] } });
    expect(await run(call)).toEqual(["a type", "b type"]);
    expect(calls).toBe(1);
  });

  it("returns nothing on failure, so the set falls back to its old hints", async () => {
    expect(await run(async () => ({ ok: false, message: "timeout" }))).toEqual([]);
  });
});

describe("excludeSimilar", () => {
  it("drops listed types that restate an excluded one, keeps the rest", () => {
    const excluded = ["two quadratics sharing a common root, found by subtracting"];
    expect(excludeSimilar(["quadratics sharing a common root via subtraction", "line-parabola intersection count", "common factor"], excluded)).toEqual([
      "line-parabola intersection count",
      "common factor",
    ]);
  });
});

describe("byTypicality", () => {
  it("puts the least typical types first and accepts both shapes in cleanTypes", () => {
    const raw = [{ type: "common", typicality: 0.6 }, { type: "rare", typicality: 0.05 }, { type: "no estimate" }, { type: "mid", typicality: 0.2 }];
    expect(cleanTypes(byTypicality(raw))).toEqual(["rare", "mid", "common", "no estimate"]);
    expect(byTypicality("nope")).toEqual([]);
  });
});

describe("typesModelFromEnv", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("runs with thinking off on every tier unless a level is named", () => {
    for (const tier of ["easy", "mid", "hard"] as const) expect(typesModelFromEnv(tier)!.thinking).toBe("off");
    vi.stubEnv("CASCADE_TYPES_MODEL", "openweight:deepseek-ai/DeepSeek-V4.1-Flash");
    expect(typesModelFromEnv("mid")!.thinking).toBe("off");
    vi.stubEnv("CASCADE_TYPES_MODEL", "openweight:deepseek-ai/DeepSeek-V4.1-Flash@low");
    expect(typesModelFromEnv("mid")!.thinking).toBe("low");
  });
});
