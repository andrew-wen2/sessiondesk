import { describe, it, expect, afterEach, vi } from "vitest";
import { LadderConfigError, defaultLadder, ladderFor, parseLadder, rungProblems, TOP_RUNG_MODEL } from "./ladder";

afterEach(() => vi.unstubAllEnvs());

describe("defaultLadder", () => {
  it("is Opus 5.5 alone on every tier until open-weight rungs are admitted", () => {
    for (const tier of ["easy", "mid", "hard"] as const) {
      const l = defaultLadder(tier);
      expect(l).toHaveLength(1);
      expect(l[0]).toMatchObject({ provider: "anthropic", model: TOP_RUNG_MODEL });
      expect(rungProblems(l[0])).toEqual([]);
    }
  });

  it("uses a forced tool call only where thinking is off (Anthropic thinking needs auto)", () => {
    // Opus 5.5 can't turn thinking off, so its default rung is always "auto"; a model
    // that can (Sonnet on the easy tier) still gets the forced call.
    expect(defaultLadder("easy")[0].toolChoice).toBe("auto");
    expect(defaultLadder("mid")[0].toolChoice).toBe("auto");
    expect(parseLadder("easy", "anthropic:claude-sonnet-4-6")[0]).toMatchObject({ thinking: "off", toolChoice: "forced" });
  });
});

describe("parseLadder", () => {
  it("parses provider:model entries with the last one as the top rung", () => {
    const l = parseLadder("mid", "openweight:deepseek-flash, openweight:glm-5.3, anthropic:claude-opus-5-5");
    expect(l.map((r) => r.model)).toEqual(["deepseek-flash", "glm-5.3", "claude-opus-5-5"]);
    expect(l[2].timeoutMs).toBeGreaterThan(l[0].timeoutMs);
  });

  it("keeps GLM-5.3 on auto tool choice and never turns its thinking off", () => {
    const [glm] = parseLadder("easy", "openweight:glm-5.3,anthropic:claude-opus-5-5");
    expect(glm.toolChoice).toBe("auto");
    expect(glm.thinking).not.toBe("off");
    expect(rungProblems(glm)).toEqual([]);
  });

  it("recognizes GLM-5.3 under a host's capitalized id", () => {
    const [glm] = parseLadder("easy", "openweight:zai-org/GLM-5.3,anthropic:claude-opus-5-5");
    expect(glm).toMatchObject({ toolChoice: "auto" });
    expect(glm.thinking).not.toBe("off");
  });

  it("lets DeepSeek use a forced tool call only with thinking off", () => {
    expect(parseLadder("easy", "openweight:deepseek-flash,anthropic:x")[0].toolChoice).toBe("forced");
    expect(parseLadder("mid", "openweight:deepseek-flash,anthropic:x")[0].toolChoice).toBe("auto");
  });

  it("accepts a per-rung thinking override", () => {
    const [ds] = parseLadder("mid", "openweight:deepseek-ai/DeepSeek-V4.1-Flash@medium,anthropic:claude-opus-5-5");
    expect(ds).toMatchObject({ model: "deepseek-ai/DeepSeek-V4.1-Flash", thinking: "medium", toolChoice: "auto" });
    const [off] = parseLadder("mid", "openweight:deepseek-flash@off,anthropic:claude-opus-5-5");
    expect(off).toMatchObject({ thinking: "off", toolChoice: "forced" });
    expect(() => parseLadder("mid", "openweight:deepseek-flash@turbo,anthropic:x")).toThrow(/thinking must be one of/);
  });

  it("names the bad entry", () => {
    expect(() => parseLadder("mid", "deepseek-flash")).toThrow(/entry "deepseek-flash"/);
    expect(() => parseLadder("mid", "azure:gpt")).toThrow(LadderConfigError);
    expect(() => parseLadder("mid", " , ")).toThrow(/empty/);
  });
});

describe("per-tier rung timeouts", () => {
  it("reads cheap and top rung timeouts from env, in seconds", () => {
    vi.stubEnv("CASCADE_RUNG_TIMEOUT_MID", "150");
    vi.stubEnv("CASCADE_TOP_TIMEOUT_MID", "110");
    const l = parseLadder("mid", "openweight:deepseek-flash,anthropic:claude-opus-5-5");
    expect(l.map((r) => r.timeoutMs)).toEqual([150_000, 110_000]);
  });
  it("ignores a blank or invalid value", () => {
    vi.stubEnv("CASCADE_RUNG_TIMEOUT_MID", "soon");
    expect(parseLadder("mid", "openweight:deepseek-flash,anthropic:x")[0].timeoutMs).toBe(90_000);
  });
});

describe("rungProblems", () => {
  it("rejects a forced tool call with thinking on", () => {
    const r = { ...defaultLadder("mid")[0], toolChoice: "forced" as const };
    expect(rungProblems(r).join(" ")).toMatch(/forced tool call/);
  });
});

describe("ladderFor", () => {
  it("falls back to the default when the override is blank", () => {
    vi.stubEnv("GENERATION_LADDER_MID", "");
    expect(ladderFor("mid")).toEqual(defaultLadder("mid"));
  });

  it("reads the per-tier override", () => {
    vi.stubEnv("GENERATION_LADDER_EASY", "openweight:deepseek-flash,anthropic:claude-opus-5-5");
    expect(ladderFor("easy")).toHaveLength(2);
  });

  it("drops a disabled provider without a ladder rewrite", () => {
    vi.stubEnv("GENERATION_LADDER_EASY", "openweight:deepseek-flash,anthropic:claude-opus-5-5");
    vi.stubEnv("GENERATION_DISABLE_RUNGS", "openweight");
    expect(ladderFor("easy").map((r) => r.provider)).toEqual(["anthropic"]);
  });

  it("refuses to disable every rung", () => {
    vi.stubEnv("GENERATION_DISABLE_RUNGS", "anthropic");
    expect(() => ladderFor("hard")).toThrow(/removes every rung/);
  });
});

// Regression: the easy tier defaults to thinking "off", and Opus 5.5 rejects
// "thinking.type.disabled" (HTTP 400), so every easy-tier Opus call failed, including
// every escalation to the top rung.
describe("models whose thinking can't be disabled", () => {
  it("runs Opus 5.5 with low thinking and an optional tool on the easy tier", () => {
    const [opus] = parseLadder("easy", "anthropic:claude-opus-5-5");
    expect([opus.thinking, opus.toolChoice]).toEqual(["low", "auto"]);
    expect(defaultLadder("easy")[0].thinking).toBe("low");
  });
  it("leaves models that can disable thinking alone", () => {
    expect(parseLadder("easy", "openweight:deepseek-ai/DeepSeek-V4.1-Flash")[0].thinking).toBe("off");
  });
});
