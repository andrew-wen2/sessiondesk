// Pure logic for scripts/eval-judge.ts: is a SHIPPED answer key right? Opus solves the
// problem blind; one solve that reaches the key settles it as correct. Otherwise a
// second solve breaks the tie, and a key is only "wrong" when two Opus solves agree
// with each other against it, so one flaky solve can't condemn a problem. This is the
// independent check the pipeline's own verification can't provide for itself.
import type { AnswerFormat } from "@/lib/generation/plan";
import { sameAnswer, type SolveObs } from "@/lib/generation/cascade/verify-cheap";
import { failureUpperBound } from "./eval-lib";

export type JudgeVerdict = "correct" | "wrong" | "ill-posed" | "unresolved";
export type JudgeStep = { need: "opus" } | { verdict: JudgeVerdict; basis: string };

export function judgeKey(key: string, format: AnswerFormat, opus: SolveObs[]): JudgeStep {
  const agrees = (o: SolveObs | undefined) => o?.kind === "answer" && sameAnswer(key, o.answer, format);
  const [o1, o2] = opus;
  if (!o1) return { need: "opus" };
  if (agrees(o1)) return { verdict: "correct", basis: "opus" };
  if (!o2) return { need: "opus" };
  if (agrees(o2)) return { verdict: "correct", basis: "opus-split" };
  if (o1.kind === "answer" && o2.kind === "answer" && sameAnswer(o1.answer, o2.answer, format)) return { verdict: "wrong", basis: "opus-twice" };
  if (o1.kind === "ambiguous" && o2.kind === "ambiguous") return { verdict: "ill-posed", basis: "opus-twice" };
  return { verdict: "unresolved", basis: "no-agreement" };
}

export type JudgeSummary = {
  judged: number; // correct + wrong + ill-posed
  correct: number;
  wrong: number;
  illPosed: number;
  unresolved: number;
  badRate: number | null; // (wrong + ill-posed) / judged
  upperBound: number | null; // one-sided 95%
};

export function summarizeJudge(verdicts: JudgeVerdict[]): JudgeSummary {
  const n = (v: JudgeVerdict) => verdicts.filter((x) => x === v).length;
  const correct = n("correct");
  const wrong = n("wrong");
  const illPosed = n("ill-posed");
  const judged = correct + wrong + illPosed;
  return {
    judged,
    correct,
    wrong,
    illPosed,
    unresolved: n("unresolved"),
    badRate: judged ? (wrong + illPosed) / judged : null,
    upperBound: judged ? failureUpperBound(wrong + illPosed, judged) : null,
  };
}
