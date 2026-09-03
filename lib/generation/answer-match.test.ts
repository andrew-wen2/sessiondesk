import { describe, it, expect } from "vitest";
import { answersMatch } from "./answer-match";

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
});
