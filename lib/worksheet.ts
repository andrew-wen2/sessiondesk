// Pure helpers for the student practice link (app/w/[[...token]] + /api/w/[token]/check).
// No Prisma, no React — vitest here is `environment: "node"` with no jsdom and no DB
// harness, so anything left inside a route handler or a component can never be covered.
// /api/generate is the repo's precedent: a thin auth/parse/persist handler with the work
// in lib/.

import { randomBytes } from "node:crypto";
import { calibrationFor } from "@/lib/calibration";
import { competitionAnswerFormat, isAnswerFormat, type AnswerFormat } from "@/lib/generation/plan";
import { parseGenMeta } from "@/lib/generation/gen-meta";
import { normalizeStatus } from "@/lib/session-status";
import type { Problem } from "@/lib/types";

/** A link dies this long after it was SENT — not after the session, which the calendar moves. */
export const LINK_TTL_DAYS = 14;

/** Attempts per problem before the answer is revealed anyway. */
export const MAX_ATTEMPTS = 2;

// 256 bits. crypto.randomUUID() is the habit elsewhere in this repo (sessions/route.ts)
// but it is only 122 bits and carries fixed version/variant nibbles — fine for an id,
// not for a bearer credential that is the only thing standing in front of a student's
// worksheet.
export function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

// base64url of 32 bytes is always 43 chars. Checked before any query so a malformed or
// absent token never reaches Prisma.
export function isWellFormedToken(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{43}$/.test(raw);
}

export type LinkState = "live" | "no-link" | "expired" | "cancelled";

/**
 * Why a link is or isn't usable, as one value rather than a boolean — the student needs
 * different copy for each case ("expired on Sep 23" vs "turned off" vs a plain 404), and
 * this is evaluated in two places (the page and the check route). One home so they can't
 * disagree by a millisecond or a helper.
 *
 * `completed` and `no_show` stay live on purpose: homework is normally done AFTER a
 * session. Only `cancelled` closes the link.
 */
export function linkState(
  session: { shareToken: string | null; sentAt: Date | null; status: string },
  now: Date
): LinkState {
  if (!session.shareToken || !session.sentAt) return "no-link";
  if (normalizeStatus(session.status) === "cancelled") return "cancelled";
  const deadline = session.sentAt.getTime() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000;
  return now.getTime() > deadline ? "expired" : "live";
}

export function linkExpiresAt(sentAt: Date): Date {
  return new Date(sentAt.getTime() + LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The answer format to grade against.
 *
 * Reads genMeta first, but falls back when the stored value is not a valid AnswerFormat
 * rather than when genMeta is null — those are different, and the difference is the whole
 * bug. Every session predating the genMeta migration returns null from parseGenMeta, AND
 * the pipeline's failure path writes `answerFormat: ""`, so a null-keyed check would sail
 * past exactly the rows most likely to be wrong. On day one, 100% of sets take this path.
 *
 * The fallback is derived, not guessed: the same competitionAnswerFormat the generator
 * itself would have used.
 */
export function resolveAnswerFormat(
  genMeta: unknown,
  profile: string
): { format: AnswerFormat; fallback: boolean } {
  const meta = parseGenMeta(genMeta);
  const stored = meta?.problems?.answerFormat;
  if (isAnswerFormat(stored)) return { format: stored, fallback: false };

  const { competition } = calibrationFor({ profile });
  if (competition) return { format: competitionAnswerFormat(competition), fallback: true };
  // No competition in the profile means no corpus anchoring either, so the generator ran
  // the model path. short-text is that path's own fallback (plan.ts) — deliberately NOT
  // "open", which answersMatch refuses to grade at all.
  return { format: "short-text", fallback: true };
}

// ---------------------------------------------------------------------------
// Projections. The containment rule lives here, as a TYPE rather than a habit:
// an unresolved problem has no `answer` or `solution` key at all, so leaking one is a
// compile error instead of something a reviewer has to notice.
// ---------------------------------------------------------------------------

export type PublicProblem =
  | { index: number; statement: string; resolved: false; attempts: string[]; attemptsLeft: number }
  | {
      index: number;
      statement: string;
      resolved: true;
      attempts: string[];
      verdict: "correct" | "wrong";
      answer: string;
      solution: string;
    };

export type StoredResult = {
  index: number;
  attempts: string[];
  verdict: "correct" | "wrong";
  revealedAt?: string;
  formatFallback?: true;
};

export function isResolved(entry: StoredResult | undefined, maxAttempts = MAX_ATTEMPTS): boolean {
  if (!entry) return false;
  return entry.verdict === "correct" || entry.attempts.length >= maxAttempts;
}

/**
 * What the page is allowed to render.
 *
 * The submission is an INPUT, not an afterthought: a student who did problems 1-4 last
 * night and comes back must see those four with their answers and solutions, or the page
 * shows blank cards the check endpoint then refuses as already resolved — stuck, with
 * nothing to show for the work. "Statements only" was wrong.
 */
export function publicProblems(
  sentSet: Problem[],
  results: StoredResult[],
  maxAttempts = MAX_ATTEMPTS
): PublicProblem[] {
  const byIndex = new Map(results.map((r) => [r.index, r]));
  return sentSet.map((p, index) => {
    const entry = byIndex.get(index);
    if (entry && isResolved(entry, maxAttempts)) {
      return {
        index,
        statement: p.problem,
        resolved: true,
        attempts: entry.attempts,
        verdict: entry.verdict,
        answer: p.answer,
        solution: p.solution,
      };
    }
    const attempts = entry?.attempts ?? [];
    return {
      index,
      statement: p.problem,
      resolved: false,
      attempts,
      attemptsLeft: Math.max(0, maxAttempts - attempts.length),
    };
  });
}

/** Tutor-side rollup. Counts against the set that was SENT, never the live `problems`. */
export function progressSummary(
  sentSet: Problem[],
  results: StoredResult[],
  maxAttempts = MAX_ATTEMPTS
): { total: number; checked: number; right: number; missed: number[]; secondTry: number } {
  const resolvedEntries = results.filter((r) => isResolved(r, maxAttempts));
  const right = resolvedEntries.filter((r) => r.verdict === "correct");
  return {
    total: sentSet.length,
    checked: resolvedEntries.length,
    right: right.length,
    // 1-based, because this is read aloud ("bring 3, 7 and 9 to ask about").
    missed: resolvedEntries
      .filter((r) => r.verdict !== "correct")
      .map((r) => r.index + 1)
      .sort((a, b) => a - b),
    // Got there, but not first time — a different diagnosis from a clean solve.
    secondTry: right.filter((r) => r.attempts.length > 1).length,
  };
}
