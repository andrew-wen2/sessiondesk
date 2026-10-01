// Canonical answer equivalence — pure, dependency-free. Two callers need this and
// need it to behave differently:
//   - solve.ts: does the generator's self-reported answer agree with the
//     independent solver's? Both sides are model output, so this needs to be
//     STRICT — two solvers agreeing on the same wrong reading is a real risk, and a
//     loose match would launder that into false confidence.
//   - the student worksheet (app/w/[[...token]]): did the student's typed answer
//     match the stored one? `x=2` vs `2`, `1,024` vs `1024`, a pasted U+2212 minus —
//     all normal student typing, all of which must be accepted; between two solvers
//     each is a red flag. LOOSE mode exists for that caller, and every leniency in it
//     is constrained so it cannot turn a genuine mismatch into a match.
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

// Loose mode only. Three ways a student types a number that no parser here accepts,
// each of which currently grades a CORRECT answer as wrong — the worst failure this
// function can have, because the student has no recourse and no retry:
//   - U+2212 MINUS SIGN, which is what you get pasting from a rendered page or PDF
//   - a thousands separator ("1,024")
//   - a trailing decimal point ("14."), matching neither the integer nor the
//     decimal branch of tryParseNumber
function looseNumericCleanup(normalized: string): string {
  let s = normalized.replace(/−/g, "-");
  // Only when the commas are genuinely thousands separators — never touch a tuple
  // like "(1,2)" or a list.
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  if (/^-?\d+\.$/.test(s)) s = s.slice(0, -1);
  return s;
}

// Loose mode only: "x=2" -> "2". Answering an equation-shaped problem by writing the
// variable back is normal student behaviour. Constrained three ways so it can never
// turn a genuine mismatch into a match:
//   - the remainder must parse as a number, so "y=2x+1" under `expression` is left
//     alone rather than mutilated into "2x+1"
//   - the variable may be multi-character ("n_1=", "ab=")
//   - callers must reject a pair whose variables differ, so "y=3" and "x=3" stay
//     different answers (enforced in answersMatch, which sees both sides)
function splitAnswerPrefix(normalized: string): { varName: string | null; value: string } {
  const m = /^([a-z][a-z0-9_]*)=(.+)$/.exec(normalized);
  if (!m) return { varName: null, value: normalized };
  if (tryParseNumber(m[2]) == null) return { varName: null, value: normalized };
  return { varName: m[1], value: m[2] };
}

// The answer as a single plain number under loose normalization ("x = 2",
// "$\frac{8}{3}$", "1,024"), or null when it is anything else. Lets a caller tell
// when a numeric comparison is definitive, so two different numbers never go to a
// model to be judged equivalent (scripts/eval-accuracy-lib.ts).
export function parseNumericAnswer(s: string): number | null {
  const raw = (s ?? "").trim();
  if (!raw) return null;
  return tryParseNumber(stripTrailingWords(splitAnswerPrefix(looseNumericCleanup(normalizeString(raw))).value));
}

// The numeric value of an answer that is a number or a simple closed-form expression
// ("$\sqrt{97}-5$", "2\sqrt{3}", "\tfrac{21}{2}", "3\pi/4", "x = 2^{5}"), or null for
// anything else (a variable expression, words, a list, an interval). Lets a caller
// compare "\sqrt{73}-5" with "\sqrt{97}-5" as the different numbers they are. Only the
// cascade's answer/solution consistency guard uses it; grading keeps answersMatch.
export function evaluateAnswer(s: string): number | null {
  const raw = (s ?? "").trim();
  if (!raw) return null;
  const pre = raw
    .replace(/\\tfrac/g, "\\frac")
    .replace(/\\(cdot|times)/g, "*")
    .replace(/\\pi\b/g, "pi")
    .replace(/\^\{([^{}]*)\}/g, "^($1)");
  let t = looseNumericCleanup(normalizeString(pre));
  const eq = t.lastIndexOf("=");
  if (eq !== -1) {
    // "x = 2" → "2"; anything left of the last "=" must be a bare variable.
    if (!/^[a-z][a-z0-9_]*$/.test(t.slice(0, eq).split("=").pop() ?? "")) return null;
    t = t.slice(eq + 1);
  }
  if (!t || /[^0-9.+\-*/^()a-z]/.test(t)) return null;
  const v = new SimpleExpr(t).parse();
  return v != null && Number.isFinite(v) ? v : null;
}

// Recursive-descent evaluator over the normalized alphabet above: numbers, + - * / ^,
// parentheses, sqrt(...), pi, and implicit multiplication ("2sqrt(3)", "3pi").
class SimpleExpr {
  private i = 0;
  constructor(private readonly s: string) {}
  parse(): number | null {
    const v = this.expr();
    return v != null && this.i === this.s.length ? v : null;
  }
  private peek() {
    return this.s[this.i];
  }
  private expr(): number | null {
    let v = this.term();
    while (v != null && (this.peek() === "+" || this.peek() === "-")) {
      const op = this.s[this.i++];
      const r = this.term();
      if (r == null) return null;
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }
  private term(): number | null {
    let v = this.unary();
    for (;;) {
      if (v == null) return null;
      const c = this.peek();
      if (c === "*" || c === "/") {
        this.i++;
        const r = this.unary();
        if (r == null) return null;
        v = c === "*" ? v * r : v / r;
      } else if (c !== undefined && /[0-9.(a-z]/.test(c)) {
        const r = this.power(); // implicit multiplication
        if (r == null) return null;
        v *= r;
      } else return v;
    }
  }
  // Unary minus binds looser than ^, so "-2^2" is -4.
  private unary(): number | null {
    if (this.peek() === "-") {
      this.i++;
      const v = this.unary();
      return v == null ? null : -v;
    }
    return this.power();
  }
  private power(): number | null {
    const base = this.primary();
    if (base == null || this.peek() !== "^") return base;
    this.i++;
    const exp = this.unary();
    return exp == null ? null : base ** exp;
  }
  private primary(): number | null {
    const rest = this.s.slice(this.i);
    const num = /^(\d+\.?\d*|\.\d+)/.exec(rest);
    if (num) {
      this.i += num[0].length;
      return Number(num[0]);
    }
    if (rest.startsWith("pi")) {
      this.i += 2;
      return Math.PI;
    }
    if (rest.startsWith("sqrt(")) {
      this.i += 4;
      const v = this.primary();
      return v == null || v < 0 ? null : Math.sqrt(v);
    }
    if (rest.startsWith("(")) {
      this.i++;
      const v = this.expr();
      if (v == null || this.peek() !== ")") return null;
      this.i++;
      return v;
    }
    return null;
  }
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
    normA = looseNumericCleanup(normA);
    normB = looseNumericCleanup(normB);

    // Strip a variable prefix only when it can't launder a mismatch: if both sides
    // name a variable and the names differ, "y=3" and "x=3" are different answers
    // and both keep their prefix so they compare unequal.
    const pa = splitAnswerPrefix(normA);
    const pb = splitAnswerPrefix(normB);
    if (!(pa.varName && pb.varName && pa.varName !== pb.varName)) {
      normA = pa.value;
      normB = pb.value;
    }

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
