import { afterEach, describe, expect, it, vi } from "vitest";
import { cheapConfigFromEnv, cheapVerify, familyProblem, realAssumption, sameAnswer, solveBlind, type CallOpenWeight } from "./verify-cheap";
import { LadderConfigError, parseRungSpec } from "./ladder";

afterEach(() => vi.unstubAllEnvs());
const plan = { domain: "Competition math (AMC10)", rubric: "r", answerFormat: "numeric" as const };
const problem = { problem: "Find $b+c$.", answer: "21/2", solution: "So $b+c=\\tfrac{21}{2}$." };

// A fake host: each solver model answers from `answers`; the validity model reports `valid`.
function fakeCall(answers: Record<string, { answer?: string; ambiguous?: boolean } | "error">, valid: boolean | "error" = true): CallOpenWeight {
  return async (rung, _prompt, tool) => {
    if (tool.name === "emit_validity") return valid === "error" ? { ok: false, message: "timeout" } : { ok: true, args: { wellPosed: valid, reason: valid ? "fine" : "no real solution" } };
    const a = answers[rung.model];
    return a === "error" ? { ok: false, message: "HTTP 500" } : { ok: true, args: { answer: a.answer ?? "", ambiguous: a.ambiguous ?? false } };
  };
}

describe("cheapConfigFromEnv", () => {
  it("defaults to two cross-family thinking solvers and a validity check, with room to think", () => {
    const c = cheapConfigFromEnv("easy");
    expect(c.solvers.map((s) => [s.model, s.thinking])).toEqual([
      ["deepseek-ai/DeepSeek-V4.1-Flash", "low"],
      ["zai-org/GLM-5.3", "low"],
    ]);
    expect(c.solvers.every((s) => s.maxTokens >= 16_000)).toBe(true);
    expect(c.validity?.model).toBe("zai-org/GLM-5.3");
  });
  it("turns the validity check off, and rejects one solver or a non-openweight one", () => {
    vi.stubEnv("CASCADE_VALIDITY", "off");
    expect(cheapConfigFromEnv("easy").validity).toBeNull();
    vi.stubEnv("CASCADE_SOLVERS", "openweight:zai-org/GLM-5.3");
    expect(() => cheapConfigFromEnv("easy")).toThrow(LadderConfigError);
    vi.stubEnv("CASCADE_SOLVERS", "openweight:zai-org/GLM-5.3,anthropic:claude-opus-5-5");
    expect(() => cheapConfigFromEnv("easy")).toThrow(/must be an openweight model/);
  });
});

describe("familyProblem", () => {
  const solvers = cheapConfigFromEnv("easy").solvers;
  it("accepts writers that some solver is outside of", () => {
    expect(familyProblem([parseRungSpec("easy", "anthropic:claude-opus-5-5", true)], solvers)).toBeNull();
    expect(familyProblem([parseRungSpec("easy", "openweight:deepseek-ai/DeepSeek-V4.1-Flash")], solvers)).toBeNull();
  });
  it("rejects a writer every solver shares a family with", () => {
    const glmOnly = [parseRungSpec("easy", "openweight:zai-org/GLM-5.3"), parseRungSpec("easy", "openweight:zai-org/GLM-5.3-Flash")];
    expect(familyProblem([parseRungSpec("easy", "openweight:zai-org/GLM-5.3")], glmOnly)).toMatch(/no solver from a different model family/);
  });
});

describe("sameAnswer", () => {
  it("matches notation variants and closed forms, never different values", () => {
    expect(sameAnswer("21/2", "\\tfrac{21}{2}", "numeric")).toBe(true);
    expect(sameAnswer("$\\sqrt{97}-5$", "-5+\\sqrt{97}", "numeric")).toBe(true);
    expect(sameAnswer("x = 4", "4", "numeric")).toBe(true);
    expect(sameAnswer("$\\sqrt{73}-5$", "\\sqrt{97}-5", "numeric")).toBe(false);
  });
});

describe("cheapVerify", () => {
  const config = cheapConfigFromEnv("easy");
  const [ds, glm] = config.solvers.map((s) => s.model);
  const run = (call: CallOpenWeight) =>
    cheapVerify({ problem, plan, config, call, signal: new AbortController().signal, recordUsage: () => {} });

  it("reports agreement when both blind solvers reach the writer's answer", async () => {
    const v = await run(fakeCall({ [ds]: { answer: "10.5" }, [glm]: { answer: "21/2" } }));
    expect(v.observations).toEqual([{ kind: "agree" }, { kind: "agree" }]);
    expect(v.invalid).toBeUndefined();
  });
  it("reports a disagreement and an ambiguity as they came", async () => {
    const v = await run(fakeCall({ [ds]: { answer: "13" }, [glm]: { ambiguous: true } }));
    expect(v.observations).toEqual([{ kind: "disagree", answer: "13" }, { kind: "ambiguous", note: "" }]);
  });
  it("flags a problem the validity check finds broken, even when the solvers agree", async () => {
    const v = await run(fakeCall({ [ds]: { answer: "21/2" }, [glm]: { answer: "21/2" } }, false));
    expect(v.invalid).toBe("no real solution");
  });
  it("treats a validity error as no evidence, and notices when every solver errored", async () => {
    const v = await run(fakeCall({ [ds]: "error", [glm]: "error" }, "error"));
    expect(v.invalid).toBeUndefined();
    expect(v.solverErrorsOnly).toBe(true);
  });
});

describe("assumption veto", () => {
  const rung = parseRungSpec("easy", "openweight:deepseek-ai/DeepSeek-V4.1-Flash@low");
  const plan = { domain: "math", rubric: "", answerFormat: "integer" as const };
  const reply = (args: object): CallOpenWeight => async () => ({ ok: true, args });

  it("treats a stated assumption as ambiguous, and 'none' as no assumption", async () => {
    const signal = new AbortController().signal;
    expect(await solveBlind(reply({ answer: "12", ambiguous: false, assumed: "the two trains start at the same time" }), rung, "p", plan, signal, () => {}, true)).toEqual({
      kind: "ambiguous",
      note: "assumed: the two trains start at the same time",
    });
    expect(await solveBlind(reply({ answer: "12", ambiguous: false, assumed: "None." }), rung, "p", plan, signal, () => {}, true)).toEqual({ kind: "answer", answer: "12" });
    // Off: the field is ignored.
    expect(await solveBlind(reply({ answer: "12", ambiguous: false, assumed: "x" }), rung, "p", plan, signal, () => {})).toEqual({ kind: "answer", answer: "12" });
  });

  it("realAssumption", () => {
    expect(realAssumption("")).toBeNull();
    expect(realAssumption("n/a")).toBeNull();
    expect(realAssumption("No assumptions needed")).toBeNull();
    expect(realAssumption("the box is closed")).toBe("the box is closed");
  });
});
