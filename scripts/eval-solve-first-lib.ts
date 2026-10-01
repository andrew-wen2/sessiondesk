// Pure logic for scripts/eval-solve-first.ts: settle each item's true answer, then
// score both solvers and the "both must agree" rule against it. No model calls here,
// so it's covered by npm run check.
//
// The experiment: the writer emits a problem STATEMENT only. Two solvers answer it
// blind, in separate calls: the writer's own model ("self") and a different family
// ("cross"). The question is which check catches wrong answers and broken problems
// better, and what requiring both to agree would ship.
//
// Truth comes from Opus, which solves every item (not just disagreements, since
// there is no writer answer to measure against). One Opus solve settles it when a
// cheap solver independently reached the same place; otherwise a second Opus solve
// breaks the tie, the same "two solvers must agree" standard as eval-accuracy-lib.
import type { AnswerFormat } from "@/lib/generation/plan";
import { answerMatch, type SolveObs } from "./eval-accuracy-lib";
import { failureUpperBound } from "./eval-lib";

export const MAX_OPUS_SOLVES = 2;

export type Truth = { kind: "answer"; answer: string; basis: string } | { kind: "ill-posed"; basis: string } | { kind: "unresolved"; basis: string };

export type Scored = {
  truth: Truth;
  selfOk: boolean | null; // null when the truth is unresolved
  crossOk: boolean | null;
  agree: boolean; // the two cheap solvers reached the same answer, or both flagged the problem
  // What "ship only if self and cross agree" does with this item.
  // drop-caught: an ill-posed problem was dropped. drop-good: a well-posed one was.
  bothRule: Rule;
  // --construct only: the writer built the problem backward from an answer it chose
  // first (never shown to the solvers). Did that intended answer match the truth, and
  // what does "ship only if the writer and both solvers agree" do with the item?
  intendedOk?: boolean | null;
  allThree?: Rule;
};

type Rule = "ship-correct" | "ship-wrong" | "drop-caught" | "drop-good" | "unknown";

export type SolveFirstInput = {
  format: AnswerFormat;
  self: SolveObs;
  cross: SolveObs;
  opus: SolveObs[];
  intended?: string; // --construct: the writer's private answer. Never part of the truth: the writer isn't blind.
  equiv?: Record<string, boolean>;
};

export type SolveFirstStep = { need: "opus" } | { need: "equiv"; a: string; b: string } | { scored: Scored };

export function solveFirstStep(x: SolveFirstInput): SolveFirstStep {
  const { format, self, cross, opus, intended, equiv = {} } = x;
  let pending: SolveFirstStep | null = null;
  const same = (o: SolveObs | undefined, p: SolveObs | undefined): boolean => {
    if (o?.kind === "ambiguous" && p?.kind === "ambiguous") return true;
    if (o?.kind !== "answer" || p?.kind !== "answer") return false;
    const r = answerMatch(o.answer, p.answer, format, equiv);
    if (r === undefined) pending ??= { need: "equiv", a: o.answer, b: p.answer };
    return r === true;
  };

  if (opus.length === 0) return { need: "opus" };
  const [o1, o2] = opus;

  // 1. Settle the truth.
  let truth: Truth | null = null;
  const o1Self = same(o1, self);
  const o1Cross = same(o1, cross);
  if (pending) return pending;
  if (o1Self || o1Cross) truth = fromObs(o1, o1Self && o1Cross ? "opus+both" : o1Self ? "opus+self" : "opus+cross");
  else if (!o2) return opus.length < MAX_OPUS_SOLVES ? { need: "opus" } : { scored: unresolved(same(self, cross), "opus-budget", intended !== undefined) };
  else {
    const o1o2 = same(o1, o2);
    const o2Self = same(o2, self);
    const o2Cross = same(o2, cross);
    if (pending) return pending;
    if (o1o2) truth = fromObs(o1, "opus-twice");
    else if (o2Self || o2Cross) truth = fromObs(o2, o2Self ? "opus2+self" : "opus2+cross");
  }
  if (!truth || truth.kind === "unresolved") {
    const agree = same(self, cross);
    if (pending) return pending;
    return { scored: unresolved(agree, "no-agreement", intended !== undefined) };
  }

  // 2. Score each solver and the agreement rule against it.
  const t: SolveObs = truth.kind === "answer" ? { kind: "answer", answer: truth.answer } : { kind: "ambiguous", note: "" };
  const selfOk = same(self, t);
  const crossOk = same(cross, t);
  const agree = same(self, cross);
  const intendedObs: SolveObs | undefined = intended === undefined ? undefined : { kind: "answer", answer: intended };
  const intendedOk = intendedObs ? same(intendedObs, t) : undefined;
  const intendedAgrees = intendedObs ? same(intendedObs, self) : false;
  if (pending) return pending;

  // An agreed answer ships. Anything else (a disagreement, or both flagging the
  // problem) drops the item: correctly when the problem is ill-posed, and at the cost
  // of a rewrite when it was well-posed.
  const bothRule: Scored["bothRule"] =
    agree && self.kind === "answer" ? (selfOk ? "ship-correct" : "ship-wrong") : truth.kind === "ill-posed" ? "drop-caught" : "drop-good";
  if (!intendedObs) return { scored: { truth, selfOk, crossOk, agree, bothRule } };
  const allThree: Rule =
    agree && intendedAgrees && self.kind === "answer" ? (selfOk ? "ship-correct" : "ship-wrong") : truth.kind === "ill-posed" ? "drop-caught" : "drop-good";
  return { scored: { truth, selfOk, crossOk, agree, bothRule, intendedOk, allThree } };
}

function fromObs(o: SolveObs, basis: string): Truth {
  if (o.kind === "answer") return { kind: "answer", answer: o.answer, basis };
  if (o.kind === "ambiguous") return { kind: "ill-posed", basis };
  return { kind: "unresolved", basis };
}

function unresolved(agree: boolean, basis: string, constructed: boolean): Scored {
  const s: Scored = { truth: { kind: "unresolved", basis }, selfOk: null, crossOk: null, agree, bothRule: "unknown" };
  return constructed ? { ...s, intendedOk: null, allThree: "unknown" } : s;
}

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------

export type SolveFirstRecord = {
  id: string;
  index: number;
  fixtureId: string;
  answerFormat: AnswerFormat;
  write: { ok: true; ms: number; problem: string; intended?: string; construction?: string } | { ok: false; ms: number; finish: string; message: string };
  guard: string | null;
  self?: SolveObs;
  cross?: SolveObs;
  opus: SolveObs[];
  equiv?: Record<string, boolean>;
  scored?: Scored;
  compared?: Comparison; // --no-opus
  dollars: number;
  unpriced: string[];
};

export type SolveFirstSummary = {
  attempted: number;
  writeFailed: number;
  guardRejected: number;
  judged: number; // truth settled
  unresolved: number;
  illPosed: number;
  self: { right: number; rate: number | null };
  cross: { right: number; rate: number | null };
  agreed: number;
  intended: { right: number; rate: number | null } | null; // null unless the run used --construct
  allThree: RuleSummary | null;
  both: RuleSummary;
  dollars: number;
  unpriced: string[];
};

export type RuleSummary = { shipped: number; shippedWrong: number; wrongRate: number | null; upperBound: number | null; dropped: number; droppedGood: number };

function summarizeRule(rules: Rule[]): RuleSummary {
  const shipped = rules.filter((r) => r === "ship-correct" || r === "ship-wrong").length;
  const shippedWrong = rules.filter((r) => r === "ship-wrong").length;
  return {
    shipped,
    shippedWrong,
    wrongRate: shipped === 0 ? null : shippedWrong / shipped,
    upperBound: shipped === 0 ? null : failureUpperBound(shippedWrong, shipped),
    dropped: rules.length - shipped,
    droppedGood: rules.filter((r) => r === "drop-good").length,
  };
}

export function summarizeSolveFirst(records: SolveFirstRecord[]): SolveFirstSummary {
  const judged = records.filter((r) => r.scored && r.scored.truth.kind !== "unresolved").map((r) => r.scored!);
  const rate = (n: number, d: number) => (d === 0 ? null : n / d);
  const selfRight = judged.filter((s) => s.selfOk).length;
  const crossRight = judged.filter((s) => s.crossOk).length;
  const constructed = judged.filter((s) => s.intendedOk !== undefined);
  const intendedRight = constructed.filter((s) => s.intendedOk).length;
  return {
    attempted: records.length,
    writeFailed: records.filter((r) => !r.write.ok).length,
    guardRejected: records.filter((r) => r.write.ok && r.guard).length,
    judged: judged.length,
    unresolved: records.filter((r) => r.scored?.truth.kind === "unresolved").length,
    illPosed: judged.filter((s) => s.truth.kind === "ill-posed").length,
    self: { right: selfRight, rate: rate(selfRight, judged.length) },
    cross: { right: crossRight, rate: rate(crossRight, judged.length) },
    agreed: judged.filter((s) => s.agree).length,
    intended: constructed.length ? { right: intendedRight, rate: rate(intendedRight, constructed.length) } : null,
    allThree: constructed.length ? summarizeRule(constructed.map((s) => s.allThree!)) : null,
    both: summarizeRule(judged.map((s) => s.bothRule)),
    dollars: records.reduce((n, r) => n + r.dollars, 0),
    unpriced: [...new Set(records.flatMap((r) => r.unpriced))],
  };
}

// ---------------------------------------------------------------------------
// --no-opus: no truth, only how the answers line up
// ---------------------------------------------------------------------------
// Without Opus nothing here says who is right. What it can say: how often the two
// blind solvers agree, how often they also match the writer's intended answer
// (--construct), and how often a solver flags the problem as ill-posed.

export type Comparison = {
  selfCross: boolean; // same answer, or both flagged the problem
  intendedSelf?: boolean;
  intendedCross?: boolean;
  flagged: { self: boolean; cross: boolean };
  errors: { self: boolean; cross: boolean };
};

export type CompareStep = { need: "equiv"; a: string; b: string } | { compared: Comparison };

export function compareStep(x: { format: AnswerFormat; self: SolveObs; cross: SolveObs; intended?: string; equiv?: Record<string, boolean> }): CompareStep {
  const { format, self, cross, intended, equiv = {} } = x;
  let pending: CompareStep | null = null;
  const same = (o: SolveObs, p: SolveObs): boolean => {
    if (o.kind === "ambiguous" && p.kind === "ambiguous") return true;
    if (o.kind !== "answer" || p.kind !== "answer") return false;
    const r = answerMatch(o.answer, p.answer, format, equiv);
    if (r === undefined) pending ??= { need: "equiv", a: o.answer, b: p.answer };
    return r === true;
  };
  const selfCross = same(self, cross);
  const i: SolveObs | undefined = intended === undefined ? undefined : { kind: "answer", answer: intended };
  const intendedSelf = i ? same(i, self) : undefined;
  const intendedCross = i ? same(i, cross) : undefined;
  if (pending) return pending;
  return {
    compared: {
      selfCross,
      ...(i ? { intendedSelf, intendedCross } : {}),
      flagged: { self: self.kind === "ambiguous", cross: cross.kind === "ambiguous" },
      errors: { self: self.kind === "error", cross: cross.kind === "error" },
    },
  };
}

export type ComparisonSummary = {
  compared: number;
  solversAgree: number; // on an answer (not both flagging)
  bothFlagged: number;
  oneFlagged: number;
  errors: number; // items where at least one solver errored
  constructed: null | {
    allThree: number; // what a "writer + both solvers agree" rule would ship
    solversAgreeWriterDiffers: number; // likely a construction mistake
    writerMatchesOnlySelf: number;
    writerMatchesOnlyCross: number;
    noneAgree: number;
  };
};

export function summarizeComparisons(cs: Comparison[]): ComparisonSummary {
  const answered = (c: Comparison) => c.selfCross && !c.flagged.self && !c.errors.self;
  const constructed = cs.filter((c) => c.intendedSelf !== undefined);
  return {
    compared: cs.length,
    solversAgree: cs.filter(answered).length,
    bothFlagged: cs.filter((c) => c.flagged.self && c.flagged.cross).length,
    oneFlagged: cs.filter((c) => c.flagged.self !== c.flagged.cross).length,
    errors: cs.filter((c) => c.errors.self || c.errors.cross).length,
    constructed: constructed.length
      ? {
          allThree: constructed.filter((c) => answered(c) && c.intendedSelf).length,
          solversAgreeWriterDiffers: constructed.filter((c) => answered(c) && !c.intendedSelf).length,
          writerMatchesOnlySelf: constructed.filter((c) => !c.selfCross && c.intendedSelf).length,
          writerMatchesOnlyCross: constructed.filter((c) => !c.selfCross && c.intendedCross).length,
          noneAgree: constructed.filter((c) => !c.selfCross && !c.intendedSelf && !c.intendedCross).length,
        }
      : null,
  };
}
