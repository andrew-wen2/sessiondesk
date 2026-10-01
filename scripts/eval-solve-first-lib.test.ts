import { describe, expect, it } from "vitest";
import { compareStep, solveFirstStep, summarizeComparisons, summarizeSolveFirst, type SolveFirstInput, type SolveFirstRecord } from "./eval-solve-first-lib";
import type { SolveObs } from "./eval-accuracy-lib";

const ans = (answer: string): SolveObs => ({ kind: "answer", answer });
const amb: SolveObs = { kind: "ambiguous", note: "" };
const err: SolveObs = { kind: "error", message: "timeout" };
const run = (x: Partial<SolveFirstInput> & Pick<SolveFirstInput, "self" | "cross">) =>
  solveFirstStep({ format: "integer", opus: [], ...x });
const scored = (x: Parameters<typeof run>[0]) => {
  const s = run(x);
  if (!("scored" in s)) throw new Error(`expected a result, got ${JSON.stringify(s)}`);
  return s.scored;
};

describe("solveFirstStep", () => {
  it("always asks Opus first, even when the cheap solvers agree", () => {
    expect(run({ self: ans("5"), cross: ans("5") })).toEqual({ need: "opus" });
  });

  it("ships an agreed answer that Opus confirms", () => {
    const s = scored({ self: ans("5"), cross: ans("5"), opus: [ans("5")] });
    expect(s.truth).toEqual({ kind: "answer", answer: "5", basis: "opus+both" });
    expect(s).toMatchObject({ selfOk: true, crossOk: true, agree: true, bothRule: "ship-correct" });
  });

  it("counts a shared wrong answer as shipped wrong once two Opus solves agree", () => {
    expect(run({ self: ans("5"), cross: ans("5"), opus: [ans("7")] })).toEqual({ need: "opus" });
    const s = scored({ self: ans("5"), cross: ans("5"), opus: [ans("7"), ans("7")] });
    expect(s.truth.basis).toBe("opus-twice");
    expect(s).toMatchObject({ selfOk: false, crossOk: false, bothRule: "ship-wrong" });
  });

  it("drops a well-posed problem the solvers split on, and scores each solver", () => {
    const s = scored({ self: ans("5"), cross: ans("7"), opus: [ans("7")] });
    expect(s).toMatchObject({ selfOk: false, crossOk: true, agree: false, bothRule: "drop-good" });
    expect(s.truth.basis).toBe("opus+cross");
  });

  it("treats a problem Opus and a cheap solver both flag as ill-posed, caught when dropped", () => {
    const s = scored({ self: ans("5"), cross: amb, opus: [amb] });
    expect(s.truth.kind).toBe("ill-posed");
    expect(s).toMatchObject({ selfOk: false, crossOk: true, bothRule: "drop-caught" });
  });

  it("is unresolved when neither Opus solve lines up with anything", () => {
    const s = scored({ self: ans("5"), cross: ans("6"), opus: [ans("7"), ans("8")] });
    expect(s).toMatchObject({ truth: { kind: "unresolved" }, selfOk: null, bothRule: "unknown" });
  });

  it("never treats two errors as agreement", () => {
    const s = scored({ self: err, cross: err, opus: [ans("4"), ans("4")] });
    expect(s).toMatchObject({ agree: false, selfOk: false, crossOk: false, bothRule: "drop-good" });
  });

  it("asks for an equivalence check before comparing free-form answers", () => {
    const step = solveFirstStep({ format: "expression", self: ans("x = 2, 3"), cross: ans("2 and 3"), opus: [ans("x=2 or x=3")] });
    expect(step).toMatchObject({ need: "equiv" });
  });
});

describe("summarizeSolveFirst", () => {
  const rec = (x: Partial<SolveFirstRecord>): SolveFirstRecord => ({
    id: "i",
    index: 0,
    fixtureId: "f",
    answerFormat: "integer",
    write: { ok: true, ms: 1, problem: "p" },
    guard: null,
    opus: [],
    dollars: 0.01,
    unpriced: [],
    ...x,
  });

  it("rolls up solver accuracy and what the agreement rule ships", () => {
    const s = summarizeSolveFirst([
      rec({ scored: scored({ self: ans("5"), cross: ans("5"), opus: [ans("5")] }) }),
      rec({ scored: scored({ self: ans("5"), cross: ans("5"), opus: [ans("7"), ans("7")] }) }),
      rec({ scored: scored({ self: ans("5"), cross: ans("7"), opus: [ans("7")] }) }),
      rec({ write: { ok: false, ms: 1, finish: "timeout", message: "" } }),
      rec({ guard: "guard-problem" }),
    ]);
    expect(s).toMatchObject({ attempted: 5, writeFailed: 1, guardRejected: 1, judged: 3, agreed: 2 });
    expect(s.self).toEqual({ right: 1, rate: 1 / 3 });
    expect(s.cross).toEqual({ right: 2, rate: 2 / 3 });
    expect(s.both).toMatchObject({ shipped: 2, shippedWrong: 1, wrongRate: 0.5, dropped: 1, droppedGood: 1 });
    expect(s.dollars).toBeCloseTo(0.05);
  });
});

describe("solveFirstStep with a constructed intended answer", () => {
  it("scores the writer's intended answer and the all-three rule against the truth", () => {
    const s = scored({ self: ans("5"), cross: ans("5"), intended: "7", opus: [ans("5")] });
    expect(s).toMatchObject({ intendedOk: false, bothRule: "ship-correct", allThree: "drop-good" });
    expect(scored({ self: ans("5"), cross: ans("5"), intended: "5", opus: [ans("5")] })).toMatchObject({ intendedOk: true, allThree: "ship-correct" });
  });
});

describe("compareStep / summarizeComparisons (--no-opus)", () => {
  const cmp = (x: Omit<Parameters<typeof compareStep>[0], "format">) => {
    const s = compareStep({ format: "integer", ...x });
    if (!("compared" in s)) throw new Error("expected a comparison");
    return s.compared;
  };

  it("lines up the writer and both solvers without any truth", () => {
    const cs = [
      cmp({ self: ans("5"), cross: ans("5"), intended: "5" }), // all three
      cmp({ self: ans("5"), cross: ans("5"), intended: "6" }), // solvers agree, writer differs
      cmp({ self: ans("5"), cross: ans("6"), intended: "6" }), // writer matches cross only
      cmp({ self: amb, cross: amb, intended: "6" }), // both flag
      cmp({ self: ans("1"), cross: err, intended: "2" }), // none agree, one error
    ];
    expect(summarizeComparisons(cs)).toEqual({
      compared: 5,
      solversAgree: 2,
      bothFlagged: 1,
      oneFlagged: 0,
      errors: 1,
      constructed: { allThree: 1, solversAgreeWriterDiffers: 1, writerMatchesOnlySelf: 0, writerMatchesOnlyCross: 1, noneAgree: 1 },
    });
  });

  it("waits on an equivalence check for free-form answers", () => {
    expect(compareStep({ format: "expression", self: ans("x = 2, 3"), cross: ans("2 and 3") })).toMatchObject({ need: "equiv" });
  });
});
