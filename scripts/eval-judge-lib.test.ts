import { describe, expect, it } from "vitest";
import { judgeKey, summarizeJudge } from "./eval-judge-lib";
import type { SolveObs } from "@/lib/generation/cascade/verify-cheap";

const ans = (answer: string): SolveObs => ({ kind: "answer", answer });
const amb: SolveObs = { kind: "ambiguous", note: "" };
const err: SolveObs = { kind: "error", message: "timeout" };

describe("judgeKey", () => {
  it("settles a key one blind solve reaches, in any notation", () => {
    expect(judgeKey("21/2", "numeric", [ans("\\tfrac{21}{2}")])).toEqual({ verdict: "correct", basis: "opus" });
  });
  it("asks for a second solve before calling anything wrong", () => {
    expect(judgeKey("13", "numeric", [])).toEqual({ need: "opus" });
    expect(judgeKey("13", "numeric", [ans("21/2")])).toEqual({ need: "opus" });
  });
  it("calls a key wrong only when two solves agree against it", () => {
    expect(judgeKey("13", "numeric", [ans("21/2"), ans("10.5")])).toEqual({ verdict: "wrong", basis: "opus-twice" });
    expect(judgeKey("13", "numeric", [ans("21/2"), ans("13")])).toEqual({ verdict: "correct", basis: "opus-split" });
    expect(judgeKey("13", "numeric", [ans("21/2"), ans("7")])).toMatchObject({ verdict: "unresolved" });
    expect(judgeKey("13", "numeric", [err, err])).toMatchObject({ verdict: "unresolved" });
  });
  it("calls a problem ill-posed when both solves say so", () => {
    expect(judgeKey("3/2", "numeric", [amb, amb])).toEqual({ verdict: "ill-posed", basis: "opus-twice" });
  });
});

describe("summarizeJudge", () => {
  it("counts wrong and ill-posed as bad, leaving unresolved out of the rate", () => {
    const s = summarizeJudge(["correct", "correct", "wrong", "ill-posed", "unresolved"]);
    expect(s).toMatchObject({ judged: 4, correct: 2, wrong: 1, illPosed: 1, unresolved: 1, badRate: 0.5 });
    expect(summarizeJudge(Array(30).fill("correct")).upperBound).toBeCloseTo(0.1, 1);
  });
});
