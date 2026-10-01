import { describe, it, expect, afterEach, vi } from "vitest";
import {
  anthropicModelFor,
  envOr,
  geminiModelFor,
  openweightModelFor,
  OPENWEIGHT_STAGE_MODEL,
  pipelineFor,
  PipelineConfigError,
  providerForStage,
  solverConfig,
  stageModel,
} from "./config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("envOr", () => {
  it("treats a blank value as unset", () => {
    vi.stubEnv("SOME_MODEL", "");
    expect(envOr("SOME_MODEL", "default")).toBe("default");
    vi.stubEnv("SOME_MODEL", "   ");
    expect(envOr("SOME_MODEL", "default")).toBe("default");
  });

  it("returns the first non-blank name in order", () => {
    vi.stubEnv("FIRST", "");
    vi.stubEnv("SECOND", "picked");
    expect(envOr(["FIRST", "SECOND"], "default")).toBe("picked");
  });

  it("uses a set value", () => {
    vi.stubEnv("SOME_MODEL", "chosen");
    expect(envOr("SOME_MODEL", "default")).toBe("chosen");
  });
});

// REGRESSION: .env.example ships these overrides as NAME="", and `??` let the empty
// string through, so a fresh copy of the example file sent model "" to every call.
describe("blank overrides from .env.example resolve to defaults", () => {
  it("Anthropic tier and stage models", () => {
    vi.stubEnv("GENERATION_MODEL", "");
    vi.stubEnv("GENERATION_MODEL_MID", "");
    vi.stubEnv("GENERATION_MODEL_PLAN", "");
    expect(anthropicModelFor("mid")).toBe("claude-sonnet-4-6");
    expect(anthropicModelFor("plan")).toBe("claude-haiku-4-5");
    expect(anthropicModelFor("lesson")).toBe("claude-sonnet-4-6");
  });

  it("Gemini stage models", () => {
    vi.stubEnv("GEMINI_MODEL", "");
    vi.stubEnv("GEMINI_MODEL_MID", "");
    expect(geminiModelFor("mid")).toBe("gemini-3.8-flash");
  });

  it("solver models", () => {
    vi.stubEnv("SOLVER_MODEL", "");
    vi.stubEnv("SOLVER_MODEL_ESCALATE", "");
    expect(solverConfig().model).toBe("claude-opus-5");
    expect(solverConfig().escalateModel).toBe("claude-opus-5");
  });
});

describe("override precedence is unchanged", () => {
  it("GENERATION_MODEL wins over the tier var", () => {
    vi.stubEnv("GENERATION_MODEL", "global");
    vi.stubEnv("GENERATION_MODEL_HARD", "tier");
    expect(anthropicModelFor("hard")).toBe("global");
  });

  it("the plan stage ignores GENERATION_MODEL", () => {
    vi.stubEnv("GENERATION_MODEL", "global");
    vi.stubEnv("GENERATION_MODEL_PLAN", "");
    expect(anthropicModelFor("plan")).toBe("claude-haiku-4-5");
  });

  it("GEMINI_MODEL wins over the stage var, which wins over the default", () => {
    vi.stubEnv("GEMINI_MODEL_EASY", "stage");
    expect(geminiModelFor("easy")).toBe("stage");
    vi.stubEnv("GEMINI_MODEL", "global");
    expect(geminiModelFor("easy")).toBe("global");
  });
});

describe("providerForStage", () => {
  it("defaults to open-weight for every stage but the hard tier, never Gemini", () => {
    vi.stubEnv("GENERATION_PROVIDER", "");
    expect(providerForStage("hard")).toBe("anthropic");
    for (const stage of ["plan", "easy", "mid", "expand", "seedSketch", "lesson"] as const) {
      expect(providerForStage(stage)).toBe("openweight");
    }
  });

  it("GENERATION_PROVIDER forces every stage to one vendor; an unknown value is ignored", () => {
    for (const forced of ["anthropic", "gemini", "openweight"] as const) {
      vi.stubEnv("GENERATION_PROVIDER", forced);
      expect(providerForStage("hard")).toBe(forced);
      expect(providerForStage("plan")).toBe(forced);
    }
    vi.stubEnv("GENERATION_PROVIDER", "nope");
    expect(providerForStage("plan")).toBe("openweight");
  });
});

describe("open-weight stage models", () => {
  it("blank overrides resolve to the default", () => {
    vi.stubEnv("OPENWEIGHT_MODEL", "");
    vi.stubEnv("OPENWEIGHT_MODEL_LESSON", "");
    expect(openweightModelFor("lesson")).toBe(OPENWEIGHT_STAGE_MODEL);
  });

  it("OPENWEIGHT_MODEL wins over the stage var; seed-sketch reuses the expand var", () => {
    vi.stubEnv("OPENWEIGHT_MODEL_EXPAND", "stage");
    expect(openweightModelFor("seedSketch")).toBe("stage");
    vi.stubEnv("OPENWEIGHT_MODEL", "global");
    expect(openweightModelFor("expand")).toBe("global");
  });

  it("stageModel names the model of whichever provider serves the stage", () => {
    vi.stubEnv("GENERATION_PROVIDER", "");
    vi.stubEnv("OPENWEIGHT_MODEL", "");
    vi.stubEnv("OPENWEIGHT_MODEL_PLAN", "");
    expect(stageModel("plan", "claude-haiku-4-5")).toBe(OPENWEIGHT_STAGE_MODEL);
    expect(stageModel("hard", "claude-opus-5")).toBe("claude-opus-5");
    vi.stubEnv("GENERATION_PROVIDER", "gemini");
    vi.stubEnv("GEMINI_MODEL", "");
    vi.stubEnv("GEMINI_MODEL_PLAN", "");
    expect(stageModel("plan", "claude-haiku-4-5")).toBe("gemini-3.8-flash");
  });
});

describe("pipelineFor", () => {
  it("defaults to legacy", () => {
    expect(pipelineFor("mid")).toBe("legacy");
  });
  it("lets a per-tier override win over the global one", () => {
    vi.stubEnv("GENERATION_PIPELINE", "cascade");
    vi.stubEnv("GENERATION_PIPELINE_HARD", "legacy");
    expect(pipelineFor("easy")).toBe("cascade");
    expect(pipelineFor("hard")).toBe("legacy");
  });
  it("rejects an unknown value instead of defaulting", () => {
    vi.stubEnv("GENERATION_PIPELINE", "cascad");
    expect(() => pipelineFor("mid")).toThrow(PipelineConfigError);
  });
});
