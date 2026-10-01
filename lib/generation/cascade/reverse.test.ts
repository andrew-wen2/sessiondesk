import { describe, expect, it } from "vitest";
import { maskedValue, numbersIn, reverseKeyProblem } from "./reverse";

const seed = { source: "AIME", number: 5, statement: "A bag holds $12$ red and $\\frac{3}{2}$... marbles; 8 are drawn. Find the number of ways.", answer: "495", solution: null };
const good = { problem: "From a bag of red marbles, $8$ are drawn in $495$ ways. How many red marbles are there?", answer: "12", masked: "12", solution: "..." };

describe("reverseKeyProblem", () => {
  it("accepts a key that is a hidden given of the seed, with the seed's answer stated", () => {
    expect(reverseKeyProblem(good, seed)).toBeNull();
  });
  it.each([
    [{ ...good, answer: "13" }, /not the hidden given/],
    [{ ...good, answer: "7", masked: "7" }, /does not appear/],
    [{ ...good, masked: undefined }, /not the hidden given/],
    [{ ...good, answer: "x" }, /not a number/],
  ])("rejects %#", (p, why) => {
    expect(reverseKeyProblem(p, seed)).toMatch(why);
  });
  it("rejects a key equal to the seed's answer", () => {
    expect(reverseKeyProblem({ ...good, answer: "8", masked: "8" }, { ...seed, answer: "8" })).toMatch(/equals the seed's answer/);
  });
});

describe("numbersIn", () => {
  it("reads plain numbers and LaTeX fractions", () => {
    expect(numbersIn("take $\\dfrac{3}{4}$ of 20.5 and -2")).toEqual([0.75, 20.5, -2]);
  });
});

describe("maskedValue", () => {
  it("reads numbers, number words, and labeled expressions", () => {
    expect(maskedValue("12")).toBe(12);
    expect(maskedValue("six")).toBe(6);
    expect(maskedValue("BC=4")).toBe(4);
    expect(maskedValue("\\frac{9}{2}")).toBe(4.5);
    expect(maskedValue("")).toBeNull();
  });
  it("accepts a key whose seed wrote the given as a word", () => {
    const s = { source: "AIME", number: 12, statement: "Color a ring of six sections with four colors.", answer: "732", solution: null };
    expect(reverseKeyProblem({ problem: "There are 732 ways. Find N.", answer: "6", masked: "six", solution: "" }, s)).toBeNull();
  });
});
