import { describe, expect, it } from "vitest";
import { checkAnswer, runAnswerCheck } from "./answer-check";

const value = (src: string) => {
  const r = runAnswerCheck(src);
  return r.ok ? r.value : r.reason;
};

describe("runAnswerCheck: contest-style programs", () => {
  it("enumerates with inclusive ranges and filters", () => {
    expect(value("f(n) = mod(n,3)==0 or mod(n,5)==0; size(filter(1:999, f))")).toBe(466);
    expect(value("count(filter(1:100, isPrime))")).toBe(25);
    expect(value("sum(map(1:10, f(x) = x^2))")).toBe(385);
  });

  it("multi-line programs with variables, fractions and combinatorics", () => {
    expect(value("a = 3\nb = 4\nsqrt(a^2 + b^2)")).toBe(5);
    expect(value("combinations(10, 3) - 5")).toBe(115);
    expect(value("fraction(1,3) + fraction(1,6)")).toBe(0.5);
    expect(value("max(map(1:20, f(k) = k*(20-k)))")).toBe(100);
  });

  it("accepts JS-style lambdas and // comments", () => {
    expect(value("sum(map(0:5, x -> 100 - x))")).toBe(585);
    expect(value("A = 1:5; B = 1:5\nmin(flatten(map(A, a -> map(B, b -> 2*a - a*b))))")).toBe(-15);
    expect(value("R = 4; // R/(3R) = 1/3\n3 * R")).toBe(12);
    expect(value("max(map(1:3, (k) -> k^2))")).toBe(9);
  });

  it("indexes arrays numerically", () => {
    expect(value("r = [4, 9, 16]; r[2]")).toBe(9);
  });

  it("abstains on 'none', empty, or non-scalar results", () => {
    expect(runAnswerCheck("none").ok).toBe(false);
    expect(runAnswerCheck("").ok).toBe(false);
    expect(runAnswerCheck("polynomialRoot(-6, 1, 1)")).toMatchObject({ ok: false, reason: "result is not a single number" });
    expect(runAnswerCheck("3 > 2")).toMatchObject({ ok: false });
  });
});

describe("runAnswerCheck: safety", () => {
  it.each([
    ["evaluate('1+1')", /strings|not allowed/],
    ["parse", /unknown name|not allowed/],
    ["import(1)", /not allowed/],
    ["f = 1; f.constructor", /property access/],
    ["x = [1]; x.length", /property access/],
    ['"abc"', /strings/],
    ["{a: 1}", /ObjectNode/],
    ["g(n) = n <= 1 ? 1 : n * g(n - 1); g(30)", /recursion/],
    ["a(n) = b(n); b(n) = n > 0 ? a(n - 1) : 0; a(5)", /recursion/],
    ["sqrt = 4", /cannot redefine|only plain|not allowed/],
    ["sqrt(x) = 4; sqrt(9)", /cannot redefine/],
    ["y + 1", /unknown name y/],
  ])("rejects %s", (src, reason) => {
    const r = runAnswerCheck(src);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toMatch(reason);
  });

  it("bounds enumeration, including nested enumeration", () => {
    expect(runAnswerCheck("size(1:100000000)")).toMatchObject({ ok: false, reason: expect.stringMatching(/too much/) });
    expect(runAnswerCheck("sum(map(1:2000, f(i) = sum(1:2000)))")).toMatchObject({ ok: false, reason: expect.stringMatching(/too much|too long/) });
  });

  it("rejects over-long programs", () => {
    expect(runAnswerCheck("1+".repeat(1000) + "1")).toMatchObject({ ok: false, reason: "program too long" });
  });
});

describe("checkAnswer", () => {
  it("match, mismatch, abstain", () => {
    expect(checkAnswer("2 + 3", 5)).toEqual({ kind: "match", value: 5 });
    expect(checkAnswer("2 + 3", 6)).toEqual({ kind: "mismatch", value: 5, stated: 6 });
    expect(checkAnswer("2 + 3", null).kind).toBe("abstain");
    expect(checkAnswer("none", 5).kind).toBe("abstain");
    expect(checkAnswer("1/3", 0.3333333333).kind).toBe("match");
  });
});
