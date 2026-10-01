import { describe, it, expect } from "vitest";
import { answersMatch, evaluateAnswer } from "./answer-match";

describe("answersMatch", () => {
  it("treats equivalent fraction/decimal/LaTeX forms as equal", () => {
    expect(answersMatch("1/2", "0.5")).toBe(true);
    expect(answersMatch("1/2", "\\frac{1}{2}")).toBe(true);
    expect(answersMatch("0.5", "\\frac{1}{2}")).toBe(true);
  });

  it("treats equivalent decimal notations as equal", () => {
    expect(answersMatch("0.30", ".3")).toBe(true);
    expect(answersMatch("1.0", "1")).toBe(true);
  });

  it("treats 0 and -0 as equal", () => {
    expect(answersMatch("0", "-0")).toBe(true);
  });

  it("THE TRAP: never matches two empty answers", () => {
    expect(answersMatch("", "")).toBe(false);
    expect(answersMatch("  ", "  ")).toBe(false);
  });

  it("never matches empty against a real answer", () => {
    expect(answersMatch("", "5")).toBe(false);
    expect(answersMatch("5", "")).toBe(false);
  });

  it("never matches under the open format, even for identical strings", () => {
    expect(answersMatch("42", "42", { format: "open" })).toBe(false);
  });

  it("does not coerce two different division-by-zero expressions to equal via NaN", () => {
    // Both sides fail to parse as a number (denominator 0), so this falls back to
    // string comparison rather than silently treating them as the same value.
    expect(answersMatch("\\frac{1}{0}", "\\frac{2}{0}")).toBe(false);
  });

  it("matches simple commutative expressions under the expression format", () => {
    expect(answersMatch("x^2+1", "1+x^2", { format: "expression" })).toBe(true);
  });

  it("treats leading-zero integers as equal under the integer format", () => {
    expect(answersMatch("042", "42", { format: "integer" })).toBe(true);
  });

  it("does not match 1/3 against a truncated decimal approximation", () => {
    // Pinned tolerance: 1/3 = 0.3333... vs 0.333 differs by ~0.033%, well outside
    // the 1e-6 relative tolerance this matcher uses.
    expect(answersMatch("1/3", "0.333")).toBe(false);
  });

  it("does not match an answer with trailing prose in strict mode", () => {
    expect(answersMatch("42 apples", "42", { strictness: "strict" })).toBe(false);
  });

  it("strips a trailing unit only in loose (student-grading) mode", () => {
    expect(answersMatch("42 apples", "42", { strictness: "loose" })).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(answersMatch(" Blue ", "blue")).toBe(true);
  });

  // The header of answer-match.ts has always promised loose mode accepts "x=2" for a
  // stored "2". It did not — normalizeString leaves "x=2" intact, tryParseNumber
  // returns null, stripTrailingWords needs a leading digit, and `integer` skips the
  // sorted-token fallback. These lock in the fix.
  describe("loose mode: a student writing the variable back", () => {
    it("accepts x=2 for a stored 2", () => {
      expect(answersMatch("x=2", "2", { format: "integer", strictness: "loose" })).toBe(true);
    });

    it("accepts a multi-character variable", () => {
      expect(answersMatch("n_1 = 14", "14", { format: "integer", strictness: "loose" })).toBe(true);
    });

    it("still rejects it in strict mode", () => {
      expect(answersMatch("x=2", "2", { format: "integer", strictness: "strict" })).toBe(false);
    });

    it("does NOT match y=3 against x=3 — different variables, different answers", () => {
      expect(answersMatch("y=3", "x=3", { format: "expression", strictness: "loose" })).toBe(false);
    });

    it("leaves an equation-valued answer unmutilated", () => {
      // The remainder "2x+1" is not a number, so the prefix must survive and this
      // must not collapse to a comparison of "2x+1" against "2x+1".
      expect(answersMatch("y=2x+1", "2x+1", { format: "expression", strictness: "loose" })).toBe(
        false
      );
      expect(answersMatch("y=2x+1", "y=2x+1", { format: "expression", strictness: "loose" })).toBe(
        true
      );
    });
  });

  // Three ways a student types a correct number that the matcher used to mark wrong.
  describe("loose mode: numeric typing students actually do", () => {
    it("accepts a thousands separator", () => {
      expect(answersMatch("1,024", "1024", { format: "integer", strictness: "loose" })).toBe(true);
    });

    it("accepts a trailing decimal point", () => {
      expect(answersMatch("14.", "14", { format: "integer", strictness: "loose" })).toBe(true);
    });

    it("accepts a pasted Unicode minus (U+2212)", () => {
      expect(answersMatch("−14", "-14", { format: "integer", strictness: "loose" })).toBe(true);
    });

    it("does not strip commas that are not thousands separators", () => {
      expect(answersMatch("(1,2)", "12", { format: "short-text", strictness: "loose" })).toBe(false);
    });

    it("leaves all three alone in strict mode", () => {
      expect(answersMatch("1,024", "1024", { strictness: "strict" })).toBe(false);
      expect(answersMatch("14.", "14", { strictness: "strict" })).toBe(false);
      expect(answersMatch("−14", "-14", { strictness: "strict" })).toBe(false);
    });
  });
});

describe("evaluateAnswer", () => {
  const close = (s: string, v: number) => expect(evaluateAnswer(s)).toBeCloseTo(v, 9);

  it("evaluates numbers and simple closed forms", () => {
    close("12", 12);
    close("$\\tfrac{21}{2}$", 10.5);
    close("\\dfrac{39}{8}", 4.875);
    close("$\\sqrt{97}-5$", Math.sqrt(97) - 5);
    close("2\\sqrt{3}", 2 * Math.sqrt(3));
    close("\\frac{3\\pi}{4}", (3 * Math.PI) / 4);
    close("2^{5}", 32);
    close("-2^2", -4);
    close("x = -\\frac{4}{3}", -4 / 3);
    close("1,024", 1024);
  });

  it("tells apart the answers an Opus answer field got wrong", () => {
    expect(evaluateAnswer("$\\sqrt{73}-5$")).not.toBeCloseTo(evaluateAnswer("\\sqrt{97}-5")!, 6);
  });

  it("returns null for anything that is not a single closed-form number", () => {
    for (const s of ["x + 1", "10, -5", "(1, 2)", "all real numbers", "", "\\sqrt[3]{2}", "2x", "3 apples and 2 pears", "\\sqrt{-4}"]) {
      expect(evaluateAnswer(s)).toBeNull();
    }
  });
});
