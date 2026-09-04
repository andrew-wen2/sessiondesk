// The state machine behind one student attempt. Pure: takes the prior results array and
// returns the next one, plus everything the response needs. No Prisma, no clock beyond an
// injectable `now`.
//
// This is deliberately NOT a thin wrapper over answersMatch. A `gradeAttempt(answer,
// stored, format) -> verdict` helper would be one line over a function that already has
// its own test file, while the code where the bugs actually live — the attempt cap,
// already-resolved handling, appending to `attempts`, deciding whether to reveal — stayed
// in the route handler where this repo's node-env vitest can never reach it.

import { answersMatch } from "@/lib/generation/answer-match";
import type { AnswerFormat } from "@/lib/generation/plan";
import { isResolved, MAX_ATTEMPTS, type StoredResult } from "@/lib/worksheet";

export type Reveal = { answer: string; solution: string };

export type ApplyOutcome = {
  results: StoredResult[];
  verdict: "correct" | "wrong";
  attempts: string[];
  attemptsLeft: number;
  /** Present once the problem is settled — correct, or out of attempts. Never before. */
  reveal: Reveal | null;
  /**
   * True when this index was already settled before the call. The caller returns 409 with
   * this state rather than an error: two tabs or a stale client must not paint a red
   * failure on a problem the student already got right.
   */
  alreadyResolved: boolean;
};

export function applyAttempt(
  results: StoredResult[],
  opts: {
    index: number;
    answer: string;
    stored: { answer: string; solution: string };
    format: AnswerFormat;
    formatFallback?: boolean;
    maxAttempts?: number;
    now?: Date;
  }
): ApplyOutcome {
  const { index, answer, stored, format, formatFallback } = opts;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const now = opts.now ?? new Date();

  const existing = results.find((r) => r.index === index);

  if (isResolved(existing, maxAttempts) && existing) {
    return {
      results,
      verdict: existing.verdict,
      attempts: existing.attempts,
      attemptsLeft: 0,
      reveal: stored,
      alreadyResolved: true,
    };
  }

  const attempts = [...(existing?.attempts ?? []), answer];
  // Loose: a student writing "x=2" for a stored "2", or pasting a Unicode minus, is
  // giving the right answer. Strict is for solver-vs-solver agreement, where the same
  // leniency would launder two models onto the same wrong reading.
  const correct = answersMatch(answer, stored.answer, { format, strictness: "loose" });
  const verdict: "correct" | "wrong" = correct ? "correct" : "wrong";
  const settled = correct || attempts.length >= maxAttempts;

  const entry: StoredResult = {
    index,
    attempts,
    verdict,
    ...(settled ? { revealedAt: now.toISOString() } : {}),
    ...(formatFallback ? { formatFallback: true as const } : {}),
  };

  const next = existing
    ? results.map((r) => (r.index === index ? entry : r))
    : [...results, entry].sort((a, b) => a.index - b.index);

  return {
    results: next,
    verdict,
    attempts,
    attemptsLeft: settled ? 0 : Math.max(0, maxAttempts - attempts.length),
    reveal: settled ? stored : null,
    alreadyResolved: false,
  };
}
