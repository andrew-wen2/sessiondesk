import { describe, it, expect, afterEach, vi } from "vitest";
import { checkGenerationConfig } from "./check-config";

afterEach(() => vi.unstubAllEnvs());

const ladder = "openweight:deepseek-flash,openweight:glm-5.3,anthropic:claude-opus-5-5";

describe("checkGenerationConfig", () => {
  it("passes a fully configured cascade ladder", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    vi.stubEnv("GOOGLE_API_KEY", "g");
    vi.stubEnv("GENERATION_PIPELINE", "cascade");
    vi.stubEnv("GENERATION_LADDER_MID", ladder);
    vi.stubEnv("OPENWEIGHT_API_KEY", "o");
    vi.stubEnv("OPENWEIGHT_BASE_URL", "https://api.example/v1");
    expect(checkGenerationConfig().errors).toEqual([]);
  });

  it("names a missing open-weight key and an http base URL", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    vi.stubEnv("GENERATION_PIPELINE_MID", "cascade");
    vi.stubEnv("GENERATION_LADDER_MID", ladder);
    vi.stubEnv("OPENWEIGHT_API_KEY", "");
    expect(checkGenerationConfig().errors.join(" ")).toMatch(/OPENWEIGHT_API_KEY/);
    vi.stubEnv("OPENWEIGHT_API_KEY", "o");
    vi.stubEnv("OPENWEIGHT_BASE_URL", "http://api.example");
    expect(checkGenerationConfig().errors.join(" ")).toMatch(/https/);
  });

  it("fails on an unpriced rung and on an invalid pipeline value", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    vi.stubEnv("GENERATION_PIPELINE_EASY", "cascade");
    vi.stubEnv("GENERATION_LADDER_EASY", "anthropic:claude-opus-9");
    vi.stubEnv("GENERATION_PIPELINE_MID", "nope");
    const errs = checkGenerationConfig().errors.join(" ");
    expect(errs).toMatch(/claude-opus-9 has no price row/);
    expect(errs).toMatch(/"legacy" or "cascade"/);
  });

  it("rejects a cheap-rung timeout that leaves no room for the top rung", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    vi.stubEnv("GENERATION_PIPELINE_HARD", "cascade");
    vi.stubEnv("GENERATION_LADDER_HARD", ladder);
    vi.stubEnv("OPENWEIGHT_API_KEY", "o");
    vi.stubEnv("OPENWEIGHT_BASE_URL", "https://api.example/v1");
    vi.stubEnv("CASCADE_RUNG_TIMEOUT_HARD", "150");
    expect(checkGenerationConfig().errors.join(" ")).toMatch(/cheaper rungs can never start/);
  });

  it("warns when the plan stage needs a Gemini key that is missing", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "k");
    vi.stubEnv("GOOGLE_API_KEY", "");
    expect(checkGenerationConfig().warnings.join(" ")).toMatch(/GOOGLE_API_KEY/);
  });
});
