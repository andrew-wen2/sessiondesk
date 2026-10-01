import { describe, expect, it } from "vitest";
import {
  AccuracyArgError,
  answerMatch,
  readToolCall,
  retryDelayMs,
  toolChoiceFor,
  equivKey,
  auditPick,
  cheapJudgeFor,
  estimateDollars,
  familyOf,
  judgeStep,
  parseAccuracyArgs,
  summarizeAccuracy,
  type ItemRecord,
  type JudgeInput,
  type SolveObs,
} from "./eval-accuracy-lib";

const ans = (answer: string): SolveObs => ({ kind: "answer", answer });
const amb: SolveObs = { kind: "ambiguous", note: "two readings" };
const err: SolveObs = { kind: "error", message: "timeout" };
const base: JudgeInput = { writerAnswer: "42", format: "integer", opus: [], audit: false };

describe("judgeStep", () => {
  it("asks for the cheap judge first", () => {
    expect(judgeStep(base)).toEqual({ need: "cheap" });
  });

  it("never judges an open-format item", () => {
    expect(judgeStep({ ...base, format: "open" })).toEqual({ verdict: "not-judgeable", basis: "open-format" });
  });

  it("accepts a cheap agreement without Opus", () => {
    expect(judgeStep({ ...base, cheap: ans("42") })).toEqual({ verdict: "correct", basis: "cheap-agree" });
  });

  it("sends an audited cheap agreement to Opus anyway", () => {
    expect(judgeStep({ ...base, cheap: ans("42"), audit: true })).toEqual({ need: "opus" });
    expect(judgeStep({ ...base, cheap: ans("42"), audit: true, opus: [ans("42")] })).toEqual({ verdict: "correct", basis: "audit-agree" });
  });

  it("catches a false cheap agreement only when Opus disagrees twice", () => {
    const x = { ...base, cheap: ans("42"), audit: true };
    expect(judgeStep({ ...x, opus: [ans("41")] })).toEqual({ need: "opus" });
    expect(judgeStep({ ...x, opus: [ans("41"), ans("41")] })).toEqual({ verdict: "wrong", basis: "audit-opus-twice" });
  });

  it("escalates every cheap disagreement, ambiguity or error to Opus", () => {
    for (const cheap of [ans("7"), amb, err]) expect(judgeStep({ ...base, cheap })).toEqual({ need: "opus" });
  });

  it("marks wrong when Opus and the cheap judge independently agree against the writer", () => {
    expect(judgeStep({ ...base, cheap: ans("7"), opus: [ans("7")] })).toEqual({ verdict: "wrong", basis: "opus+cheap" });
  });

  it("marks correct when Opus sides with the writer against the cheap judge", () => {
    expect(judgeStep({ ...base, cheap: ans("7"), opus: [ans("42")] })).toEqual({ verdict: "correct", basis: "opus-agree" });
  });

  it("never marks wrong on one Opus solve alone", () => {
    // Three different answers: writer 42, cheap 7, Opus 9 — needs a tie-breaker.
    expect(judgeStep({ ...base, cheap: ans("7"), opus: [ans("9")] })).toEqual({ need: "opus" });
    expect(judgeStep({ ...base, cheap: ans("7"), opus: [ans("9"), ans("9")] })).toEqual({ verdict: "wrong", basis: "opus-twice" });
    expect(judgeStep({ ...base, cheap: ans("7"), opus: [ans("9"), ans("42")] })).toEqual({ verdict: "correct", basis: "opus-split" });
    expect(judgeStep({ ...base, cheap: ans("7"), opus: [ans("9"), ans("5")] })).toEqual({ verdict: "unresolved", basis: "no-agreement" });
  });

  it("calls an item ill-posed only when two solvers flag it", () => {
    expect(judgeStep({ ...base, cheap: amb, opus: [amb] })).toEqual({ verdict: "ill-posed", basis: "opus+cheap-ambiguous" });
    expect(judgeStep({ ...base, cheap: ans("7"), opus: [amb] })).toEqual({ need: "opus" });
    expect(judgeStep({ ...base, cheap: ans("7"), opus: [amb, amb] })).toEqual({ verdict: "ill-posed", basis: "opus-twice-ambiguous" });
  });

  it("leaves an item unresolved rather than guessing when Opus errors twice", () => {
    expect(judgeStep({ ...base, cheap: err, opus: [err] })).toEqual({ need: "opus" });
    expect(judgeStep({ ...base, cheap: err, opus: [err, err] })).toEqual({ verdict: "unresolved", basis: "no-agreement" });
  });

  it("does not count two empty answers as agreement", () => {
    expect(judgeStep({ ...base, writerAnswer: "", cheap: ans("") })).toEqual({ need: "opus" });
  });
});

describe("answer equivalence", () => {
  const expr: JudgeInput = { writerAnswer: "x = 10, \\; -5", format: "expression", opus: [], audit: false };

  it("decides integer answers by rule, never by the model", () => {
    expect(answerMatch("96", "097", "integer")).toBe(false);
    expect(answerMatch("x = 96", "96", "integer")).toBe(true);
    expect(answerMatch("", "", "numeric")).toBe(false);
  });

  it("accepts a numeric rule match but sends a multi-part miss to the model", () => {
    expect(answerMatch("pH = 3.19", "3.19", "numeric")).toBe(true);
    expect(answerMatch("pH = 4.14; percent ionization = 0.048%", "pH ≈ 4.14; percent ionization ≈ 0.048%", "numeric")).toBeUndefined();
  });

  // Regression: the thinking-off equivalence model called "2" and "8/3" the same
  // answer about 1 time in 40 (eval:solve-first, construct-easy #0). Two plain
  // numbers are decided by rule in every format, so the model is never asked.
  it("decides two plain numbers by rule in every format, never by the model", () => {
    expect(answerMatch("2", "8/3", "numeric")).toBe(false);
    expect(answerMatch("2", "\\frac{3}{4}", "expression")).toBe(false);
    expect(answerMatch("$\\frac{72}{5}$", "72/5", "expression")).toBe(true);
    expect(answerMatch("k = 7", "7", "short-text")).toBe(true);
    expect(answerMatch("x = 2", "y = 2", "numeric")).toBe(false);
    // Not a single number on one side: still the model's call.
    expect(answerMatch("2", "$k=7$ or $k=2$", "expression")).toBeUndefined();
  });

  it("asks the equivalence model when a free-form answer differs only in wording", () => {
    expect(answerMatch("x = 10, x = -5", "x = 10, \\; -5", "expression")).toBeUndefined();
    expect(judgeStep({ ...expr, cheap: ans("x = 10, x = -5") })).toEqual({ need: "equiv", a: "x = 10, x = -5", b: "x = 10, \\; -5" });
  });

  it("uses the equivalence verdict in either argument order", () => {
    const equiv = { [equivKey("x = 10, \\; -5", "x = 10, x = -5")]: true };
    expect(judgeStep({ ...expr, cheap: ans("x = 10, x = -5"), equiv })).toEqual({ verdict: "correct", basis: "cheap-agree" });
    expect(judgeStep({ ...expr, cheap: ans("x = 10, x = -5"), equiv: { [equivKey("x = 10, \\; -5", "x = 10, x = -5")]: false } })).toEqual({ need: "opus" });
  });

  it("asks one comparison at a time, then reaches a verdict", () => {
    const x = { ...expr, cheap: ans("x = 7"), opus: [ans("seven")] };
    const k1 = equivKey("x = 7", "x = 10, \\; -5");
    const k2 = equivKey("seven", "x = 10, \\; -5");
    const k3 = equivKey("seven", "x = 7");
    expect(judgeStep(x)).toEqual({ need: "equiv", a: "x = 7", b: "x = 10, \\; -5" });
    expect(judgeStep({ ...x, equiv: { [k1]: false } })).toEqual({ need: "equiv", a: "seven", b: "x = 10, \\; -5" });
    expect(judgeStep({ ...x, equiv: { [k1]: false, [k2]: false } })).toEqual({ need: "equiv", a: "seven", b: "x = 7" });
    expect(judgeStep({ ...x, equiv: { [k1]: false, [k2]: false, [k3]: true } })).toEqual({ verdict: "wrong", basis: "opus+cheap" });
  });
});

describe("judges", () => {
  it("classifies model families", () => {
    expect(familyOf("deepseek-ai/DeepSeek-V4.1-Flash")).toBe("deepseek");
    expect(familyOf("zai-org/GLM-5.3-Flash")).toBe("glm");
    expect(familyOf("claude-opus-5-5")).toBe("claude");
    expect(familyOf("gemini-3.8-flash")).toBe("gemini");
  });

  it("picks a cheap judge from a different family than the writer", () => {
    expect(familyOf(cheapJudgeFor("zai-org/GLM-5.3"))).toBe("deepseek");
    expect(familyOf(cheapJudgeFor("deepseek-ai/DeepSeek-V4.1-Flash"))).toBe("glm");
    expect(familyOf(cheapJudgeFor("gemini-3.8-flash"))).toBe("glm");
  });

  it("refuses a same-family override", () => {
    expect(() => cheapJudgeFor("zai-org/GLM-5.3-Flash", "openweight:zai-org/GLM-5.3")).toThrow(/same model family/);
    expect(cheapJudgeFor("zai-org/GLM-5.3", "openweight:deepseek-ai/DeepSeek-V4.1-Flash@low")).toBe("openweight:deepseek-ai/DeepSeek-V4.1-Flash@low");
  });

  it("samples audits deterministically at roughly the requested rate", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `mid|x|${i}`);
    expect(ids.map((id) => auditPick(id, 0.15))).toEqual(ids.map((id) => auditPick(id, 0.15)));
    const share = ids.filter((id) => auditPick(id, 0.15)).length / ids.length;
    expect(share).toBeGreaterThan(0.11);
    expect(share).toBeLessThan(0.19);
    expect(auditPick("a", 0)).toBe(false);
    expect(auditPick("a", 1)).toBe(true);
  });
});

describe("parseAccuracyArgs", () => {
  it("parses repeatable rungs with their tier's cheap-rung settings", () => {
    const a = parseAccuracyArgs(["--yes", "--rung", "easy=openweight:deepseek-ai/DeepSeek-V4.1-Flash", "--rung", "hard=openweight:zai-org/GLM-5.3"]);
    expect(a.rungs.map((r) => [r.tier, r.rung.model, r.rung.thinking, r.rung.toolChoice])).toEqual([
      ["easy", "deepseek-ai/DeepSeek-V4.1-Flash", "off", "forced"],
      ["hard", "zai-org/GLM-5.3", "high", "auto"],
    ]);
    expect(a).toMatchObject({ perTier: 30, audit: 0.15, judgeModel: "claude-opus-5-5", yes: true, maxDollars: 20, contestOnly: false });
    expect(parseAccuracyArgs(["--contest-only", "--rung", "mid=openweight:x"]).contestOnly).toBe(true);
  });

  it("rejects bad input loudly", () => {
    expect(() => parseAccuracyArgs([])).toThrow(AccuracyArgError);
    expect(() => parseAccuracyArgs(["--rung", "extreme=openweight:x"])).toThrow(/TIER/);
    expect(() => parseAccuracyArgs(["--rung", "easy=nope:x"])).toThrow(AccuracyArgError);
    expect(() => parseAccuracyArgs(["--rung", "easy=openweight:x", "--audit", "2"])).toThrow(/out of range/);
    expect(() => parseAccuracyArgs(["--rung", "easy=openweight:x", "--bogus"])).toThrow(/Unknown/);
    expect(() => parseAccuracyArgs(["--rung", "easy=openweight:x", "--rung", "easy=openweight:x"])).toThrow(/twice/);
  });

  it("allows --summary without rungs", () => {
    expect(parseAccuracyArgs(["--summary", "runs/a.jsonl"]).summary).toBe("runs/a.jsonl");
  });
});

describe("summarizeAccuracy", () => {
  const rec = (over: Partial<ItemRecord>): ItemRecord => ({
    id: "x",
    tier: "mid",
    rung: "openweight:m",
    index: 0,
    fixtureId: "f",
    answerFormat: "integer",
    write: { ok: true, ms: 1, problem: "p", answer: "1", solution: "s" },
    guard: null,
    opus: [],
    audited: false,
    dollars: 0.01,
    unpriced: [],
    ...over,
  });

  it("scores wrong and ill-posed as failures over judged items only", () => {
    const rows = summarizeAccuracy([
      ...Array.from({ length: 7 }, () => rec({ verdict: "correct" })),
      rec({ verdict: "wrong", opus: [ans("2")] }),
      rec({ verdict: "ill-posed", opus: [amb, amb] }),
      rec({ verdict: "unresolved", opus: [err, err] }),
      rec({ write: { ok: false, ms: 1, finish: "timeout", message: "" } }),
      rec({ guard: "guard-answer" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attempted: 12, writeFailed: 1, guardRejected: 1, judged: 9, correct: 7, wrong: 1, illPosed: 1, unresolved: 1, opusSolves: 5 });
    expect(rows[0].wrongRate).toBeCloseTo(2 / 9);
    expect(rows[0].upperBound!).toBeGreaterThan(2 / 9);
    expect(rows[0].dollars).toBeCloseTo(0.12);
  });

  it("counts audit catches separately and orders rows by tier", () => {
    const rows = summarizeAccuracy([
      rec({ tier: "hard", verdict: "correct" }),
      rec({ tier: "easy", audited: true, verdict: "wrong" }),
      rec({ tier: "easy", audited: true, verdict: "correct" }),
    ]);
    expect(rows.map((r) => r.tier)).toEqual(["easy", "hard"]);
    expect(rows[0]).toMatchObject({ audited: 2, auditCaught: 1 });
    expect(rows[1].wrongRate).toBe(0);
  });
});

describe("estimateDollars", () => {
  it("scales with items and keeps the worst case above the expected case", () => {
    const one = estimateDollars([{ tier: "mid" }], 30, 0.15);
    const two = estimateDollars([{ tier: "mid" }, { tier: "mid" }], 30, 0.15);
    expect(two.expected).toBeCloseTo(one.expected * 2);
    expect(one.worst).toBeGreaterThan(one.expected);
    expect(estimateDollars([{ tier: "hard" }], 30, 0.15).worst).toBeGreaterThan(one.worst);
  });
});

// Regression: openWeightSolve sent tool_choice "auto" whatever the rung said, and
// reported a max_tokens cutoff as "no tool call". DeepSeek with thinking off then
// worked broken problems in plain text until the limit (13 of 16 calls).
describe("open-weight tool calls", () => {
  it("follows the rung's tool policy", () => {
    expect(toolChoiceFor({ toolChoice: "forced" }, "emit_solve")).toEqual({ type: "function", function: { name: "emit_solve" } });
    expect(toolChoiceFor({ toolChoice: "auto" }, "emit_solve")).toBe("auto");
  });

  it("names a max_tokens cutoff as truncated, even when a partial call came back", () => {
    const call = { function: { name: "emit_solve", arguments: '{"answer":"4"' } };
    expect(readToolCall({ choices: [{ finish_reason: "length", message: { tool_calls: [call] } }] }, "emit_solve")).toEqual({ ok: false, message: "truncated" });
    expect(readToolCall({ choices: [{ finish_reason: "length", message: {} }] }, "emit_solve")).toEqual({ ok: false, message: "truncated" });
  });

  it("separates a missing call from a malformed one, and parses a good one", () => {
    expect(readToolCall({ choices: [{ finish_reason: "stop", message: {} }] }, "emit_solve")).toEqual({ ok: false, message: "no tool call" });
    const bad = { function: { name: "emit_solve", arguments: "{oops" } };
    expect(readToolCall({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [bad] } }] }, "emit_solve")).toEqual({ ok: false, message: "malformed tool call" });
    const good = { function: { name: "emit_solve", arguments: '{"answer":"4","ambiguous":false}' } };
    expect(readToolCall({ choices: [{ finish_reason: "tool_calls", message: { tool_calls: [good] } }] }, "emit_solve")).toEqual({ ok: true, args: { answer: "4", ambiguous: false } });
  });
});

describe("retryDelayMs", () => {
  it("honours a Retry-After in seconds, capped at a minute", () => {
    expect(retryDelayMs(1, "3")).toBe(3000);
    expect(retryDelayMs(1, "600")).toBe(60_000);
  });
  it("backs off exponentially with jitter when the host gives no hint", () => {
    expect(retryDelayMs(1, null, () => 0)).toBe(500);
    expect(retryDelayMs(1, null, () => 1)).toBe(1000);
    expect(retryDelayMs(4, null, () => 1)).toBe(8000);
    expect(retryDelayMs(10, null, () => 1)).toBe(30_000);
    // An HTTP-date Retry-After isn't parsed; fall back to backoff.
    expect(retryDelayMs(2, "Wed, 21 Oct 2026 07:28:00 GMT", () => 1)).toBe(2000);
  });
});
