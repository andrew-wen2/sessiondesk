// Canonical answer equivalence — pure, dependency-free. Two callers need this and
// need it to behave differently:
//   - solve.ts: does the generator's self-reported answer agree with the
//     independent solver's? Both sides are model output, so this needs to be
//     STRICT — two solvers agreeing on the same wrong reading is a real risk, and a
//     loose match would launder that into false confidence.
//   - the deferred worksheet: did the student's typed answer match the stored one?
//     `x=2` vs `2` is a normal way for a student to answer and should be accepted;
//     between two solvers it's a red flag. LOOSE mode exists for that caller.
// (Eng A5 — one normalizer, two thresholds, AnswerFormat as a parameter.)
//
// The load-bearing case: answersMatch("", "") MUST be false. An empty answer means
// nothing was solved. If empty ever equaled empty, every ungradeable item would
// mark itself correct against an equally-empty stored answer.

import type { AnswerFormat } from "@/lib/generation/plan";

export type MatchStrictness = "strict" | "loose";

const TOLERANCE = 1e-6; // relative tolerance for numeric comparison

function stripLatexWrappers(s: string): string {
  return s
    .trim()
    .replace(/^\$+|\$+$/g, "")
    .replace(/\\left|\\right/g, "")
    .replace(/\\,|\\;|\\!|\\quad|\\qquad/g, " ")
    .replace(/\\text\{([^}]*)\}/g, "$1")
    .trim();
}

// \frac{a}{b} -> (a)/(b). Handles one level of nesting, which covers every answer
// this pipeline emits (a final numeric/symbolic result, not a derivation).
function expandFrac(s: string): string {
  return s.replace(/\\d?frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)");
}

function normalizeString(s: string): string {
  return expandFrac(stripLatexWrappers(s))
    .replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)")
    .replace(/\s+/g, "")
    .toLowerCase();
}

// Parse a normalized string as a number if it unambiguously is one: an integer, a
// decimal, or a simple fraction "a/b". Anything else (an expression with a
// variable, a word, a phrase) returns null and falls through to string comparison.
function tryParseNumber(normalized: string): number | null {
  if (/^-?\d+$/.test(normalized)) return Number(normalized);
  if (/^-?\d*\.\d+$/.test(normalized)) return Number(normalized);
  const fracMatch = /^\(?(-?\d+)\)?\/\(?(-?\d+)\)?$/.exec(normalized);
  if (fracMatch) {
    const denom = Number(fracMatch[2]);
    if (denom === 0) return null;
    return Number(fracMatch[1]) / denom;
  }
  return null;
}

function numbersMatch(a: number, b: number): boolean {
  if (a === b) return true; // exact, and handles 0 === -0
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / scale <= TOLERANCE;
}

// Loose mode only: strip a trailing unit/word after a number ("42 apples" -> "42").
// A documented, deliberate leniency for grading a student's typed answer — never
// applied in strict (solver-vs-solver) mode, where such padding is itself a signal
// something is off.
function stripTrailingWords(normalized: string): string {
  const m = /^(-?\d+(?:\.\d+)?)[a-z]+$/.exec(normalized);
  return m ? m[1] : normalized;
}

export function answersMatch(
  a: string,
  b: string,
  opts: { format?: AnswerFormat; strictness?: MatchStrictness } = {}
): boolean {
  const { format, strictness = "strict" } = opts;

  // "open" format has no single answer to compare — never claim a match.
  if (format === "open") return false;

  const rawA = (a ?? "").trim();
  const rawB = (b ?? "").trim();
  // THE TRAP: empty must never equal empty. An empty answer means "nothing was
  // solved," on either side, and two nothings are not agreement.
  if (!rawA || !rawB) return false;

  let normA = normalizeString(rawA);
  let normB = normalizeString(rawB);
  if (strictness === "loose") {
    normA = stripTrailingWords(normA);
    normB = stripTrailingWords(normB);
  }

  const numA = tryParseNumber(normA);
  const numB = tryParseNumber(normB);
  if (numA != null && numB != null) return numbersMatch(numA, numB);

  // Symbolic/short-text: normalized string equality. Not a CAS — "1+x^2" and
  // "x^2+1" match only because both normalize to the same character sequence
  // AFTER our transforms, not because we understand commutativity in general.
  // expression/short-text formats get light reordering tolerance for the common
  // "a+b" vs "b+a" case via a sorted-token fallback; anything more (factoring,
  // trig identities) is out of scope for a pure string matcher.
  if (normA === normB) return true;
  if (format === "expression" || format === "short-text") {
    // Split into signed terms and sort, so "x^2+1" and "1+x^2" canonicalize the
    // same way. The leading term carries an implicit "+" that has to be made
    // explicit before sorting, or it sorts by its own first character instead of
    // alongside the other signed terms.
    const sortTokens = (s: string) => {
      const parts = s.split(/(?=[+\-])/);
      const signed = parts.map((t, i) => (i === 0 && !/^[+-]/.test(t) ? `+${t}` : t));
      return signed.sort().join("");
    };
    if (sortTokens(normA) === sortTokens(normB)) return true;
  }
  return false;
}
