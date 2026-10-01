import { describe, it, expect } from "vitest";
import { answerMatchesSolution, answerOkFor, finalValueOfSolution, nearCopyOf, problemOk, solutionMetaOk, solutionOk, solutionSketchOk, tooSimilarToSeed } from "./verifier";
import type { Problem } from "@/lib/types";

const mathPlan = { contentType: "math" as const };
const prosePlan = { contentType: "prose" as const };
const codePlan = { contentType: "code" as const };

function problem(overrides: Partial<Problem> = {}): Problem {
  return { problem: "Find x.", answer: "5", solution: "x = 5.", ...overrides };
}

describe("answerOkFor", () => {
  it("rejects an empty answer unless the format is open", () => {
    const p = problem({ answer: "" });
    expect(answerOkFor(p, { answerFormat: "integer", competition: null })).toBe(false);
    expect(answerOkFor(p, { answerFormat: "open", competition: null })).toBe(true);
  });

  it("enforces AIME's integer 0-999 range", () => {
    expect(answerOkFor(problem({ answer: "999" }), { answerFormat: "integer", competition: "AIME" })).toBe(true);
    expect(answerOkFor(problem({ answer: "1000" }), { answerFormat: "integer", competition: "AIME" })).toBe(false);
    expect(answerOkFor(problem({ answer: "0" }), { answerFormat: "integer", competition: "AIME" })).toBe(true);
  });

  it("rejects a bare multiple-choice letter except for expression/open formats", () => {
    expect(answerOkFor(problem({ answer: "C" }), { answerFormat: "numeric", competition: null })).toBe(false);
    expect(answerOkFor(problem({ answer: "E" }), { answerFormat: "expression", competition: null })).toBe(true);
  });

  it("REGRESSION: no longer drops a solution for the word 'unknown'", () => {
    const p = problem({ answer: "5", solution: "Let the unknown be $x$. Then x = 5." });
    expect(answerOkFor(p, { answerFormat: "numeric", competition: null })).toBe(true);
  });

  it("REGRESSION: no longer drops a solution for the word 'hint'", () => {
    const p = problem({ answer: "5", solution: "As a hint, consider symmetry. Then x = 5." });
    expect(answerOkFor(p, { answerFormat: "numeric", competition: null })).toBe(true);
  });

  it("still rejects genuine placeholders", () => {
    expect(answerOkFor(problem({ answer: "TBD" }), { answerFormat: "numeric", competition: null })).toBe(false);
    expect(
      answerOkFor(problem({ answer: "5", solution: "see solution" }), { answerFormat: "numeric", competition: null })
    ).toBe(false);
  });
});

describe("problemOk", () => {
  it("REGRESSION: keeps a biology problem asking the student to draw a diagram", () => {
    const p = problem({ problem: "Draw a diagram of the electron transport chain and label each complex." });
    expect(problemOk(p, prosePlan)).toBe(true);
  });

  it("REGRESSION: keeps a geometry problem referencing 'the figure formed by'", () => {
    const p = problem({ problem: "Find the area of the figure formed by the three midpoints of triangle ABC." });
    expect(problemOk(p, mathPlan)).toBe(true);
  });

  it("still rejects a problem that depends on an image the student wasn't given", () => {
    const p = problem({ problem: "In the diagram shown above, find the measure of angle ABC." });
    expect(problemOk(p, mathPlan)).toBe(false);
  });

  it("exempts figure-dependence phrasing for code content (self-contained ASCII diagrams)", () => {
    const p = problem({
      problem: "As shown below:\n```\n  A\n /  \\\nB----C\n```\nWrite a function that computes the perimeter.",
    });
    expect(problemOk(p, codePlan)).toBe(true);
  });

  it("PROVES plan-awareness: the same statement is judged differently under math vs code plans", () => {
    const p = problem({ problem: "As shown below, compute the total." });
    expect(problemOk(p, mathPlan)).toBe(false);
    expect(problemOk(p, codePlan)).toBe(true);
  });

  it("still rejects self-correction leaking into the statement", () => {
    const p = problem({ problem: "Find x. Actually, disregard that — here is the real problem: find y." });
    expect(problemOk(p, mathPlan)).toBe(false);
  });

  it("still rejects a cut-off statement", () => {
    const p = problem({ problem: "Find the sum of all integers n such that..." });
    expect(problemOk(p, mathPlan)).toBe(false);
  });

  it("still rejects a real multiple-choice option list", () => {
    const p = problem({ problem: "What is 2+2? (A) 1 (B) 2 (C) 3 (D) 4 (E) 5" });
    expect(problemOk(p, mathPlan)).toBe(false);
  });

  it("rejects an empty statement", () => {
    expect(problemOk(problem({ problem: "" }), mathPlan)).toBe(false);
  });
});

describe("solutionOk / solutionSketchOk", () => {
  it("REGRESSION: keeps a forward verification step ('let me verify: ... gives 14')", () => {
    const p = problem({ solution: "So x = 14. Let me verify: substituting back gives 14. Confirmed." });
    expect(solutionOk(p, mathPlan)).toBe(true);
  });

  it("REGRESSION: keeps 'double-check' used as forward pedagogy", () => {
    const p = problem({ solution: "We double-check by plugging x = 14 back into the original equation." });
    expect(solutionOk(p, mathPlan)).toBe(true);
  });

  it("still rejects genuine backtracking", () => {
    expect(solutionOk(problem({ solution: "x = 12. Wait, that's wrong. x = 14." }), mathPlan)).toBe(false);
    expect(solutionOk(problem({ solution: "Scratch that, let's start over." }), mathPlan)).toBe(false);
    expect(solutionOk(problem({ solution: "Oops, I made a mistake above." }), mathPlan)).toBe(false);
  });

  it("applies the same vocabulary to solutionSketch", () => {
    const p = problem({ solutionSketch: "1. x=12 [NUMERIC]. Wait, that's wrong. 2. x=14 [NUMERIC]." });
    expect(solutionSketchOk(p, mathPlan)).toBe(false);
  });
});

describe("tooSimilarToSeed", () => {
  it("flags a variant sharing 3+ non-trivial integers with a seed", () => {
    const p = problem({ problem: "A set has 100 elements, chosen from 1000, with modulus 2024." });
    const seeds = [{ source: "AIME", number: 12, statement: "A set has 100 elements from 1000 mod 2024." }];
    expect(tooSimilarToSeed(p, seeds)).not.toBeNull();
  });

  it("does not flag on shared trivial numbers alone", () => {
    const p = problem({ problem: "There are 2 boxes, each with 1 apple." });
    const seeds = [{ source: "AIME", number: 1, statement: "There are 2 cars, each with 1 driver." }];
    expect(tooSimilarToSeed(p, seeds)).toBeNull();
  });

  it("skips the numeric axis when numeric:false is passed", () => {
    const p = problem({ problem: "Conjugate the verb in 12 sentences using 30 examples." });
    const seeds = [{ source: "corpus", number: null, statement: "Translate 12 phrases from 30 flashcards." }];
    expect(tooSimilarToSeed(p, seeds, { numeric: false })).toBeNull();
  });

  // REGRESSION (found via /investigate on a live eval run: noncontest-easy-2 kept
  // only 1/10 requested problems, drops={"near-duplicate":19}). contentWords()
  // strips ALL math out of a statement, so a short, templated problem is left with
  // only a handful of generic instructional words. Two genuinely DIFFERENT
  // equations then collide on lexical-jaccard purely because they share 2 of those
  // ~3 leftover words — the guard was calibrated against long, richly-worded AIME
  // seeds (see the test above) and never tested against short algebra drills.
  it("does NOT flag two DIFFERENT equations that only share generic task words", () => {
    const p = problem({ problem: "Find all solutions to the equation $x^2 - 5x - 24 = 0$ by factoring." });
    const kept = [{ source: "kept", number: null, statement: "Solve the equation by factoring: $$3x^2 - 13x - 10 = 0$$" }];
    // contentWords leaves {solutions, equation, factoring} vs {solve, equation,
    // factoring} — jaccard 0.50, over the 0.45 threshold, on completely different
    // quadratics. Real, reproduced value from the eval log.
    expect(tooSimilarToSeed(p, kept, { numeric: true })).toBeNull();
  });

  it("still flags a genuine reworded paraphrase with real lexical overlap", () => {
    const p = problem({
      problem: "A rectangle has a length of $3x - 1$ and a width of $x + 2$. If the area of the rectangle is 24, find $x$.",
    });
    const kept = [
      {
        source: "kept",
        number: null,
        statement: "A rectangle has a length of $3x - 1$ and a width of $x + 2$. Find the value of $x$ given the area is 24.",
      },
    ];
    expect(tooSimilarToSeed(p, kept)).not.toBeNull();
  });
});

describe("solutionOk rejects a missing derivation", () => {
  const plan = { contentType: "math" as const };
  it("rejects an empty or near-empty solution", () => {
    expect(solutionOk({ problem: "p", answer: "3", solution: "" }, plan)).toBe(false);
    expect(solutionOk({ problem: "p", answer: "3", solution: "  = 3  " }, plan)).toBe(false);
  });
  it("accepts a short but real derivation", () => {
    expect(solutionOk({ problem: "p", answer: "3", solution: "Since 2x = 6, x = 3." }, plan)).toBe(true);
  });
});

// Cases from a real eval run (Opus 5.5 writing easy AMC forward, runs/opus-forward-easy).
describe("answer/solution consistency (cascade only)", () => {
  it("reads the value a solution arrives at", () => {
    expect(finalValueOfSolution("So $b+c=20-\\tfrac{19}{2}=\\tfrac{21}{2}$.")).toBe("\\tfrac{21}{2}");
    expect(finalValueOfSolution("Work.\nTherefore the answer is $12$.")).toBe("12");
    expect(finalValueOfSolution("First $x=3$, and \\boxed{7} follows.\nDone.")).toBe("7");
    expect(finalValueOfSolution("")).toBeNull();
  });

  it("rejects an answer field that contradicts the solution's own result", () => {
    expect(answerMatchesSolution(problem({ answer: "13", solution: "Also $c=20$.\nSo $b+c=20-\\tfrac{19}{2}=\\tfrac{21}{2}$." }))).toBe(false);
    expect(answerMatchesSolution(problem({ answer: "$\\sqrt{73}-5$", solution: "Then $w^2+10w-72=0$.\nSo $w=\\sqrt{97}-5$." }))).toBe(false);
  });

  it("passes a match in any notation, and abstains when it can't evaluate", () => {
    expect(answerMatchesSolution(problem({ answer: "10.5", solution: "So $b+c=\\tfrac{21}{2}$." }))).toBe(true);
    expect(answerMatchesSolution(problem({ answer: "x = 10, -5", solution: "The roots are $x=10$ and $x=-5$." }))).toBe(true);
    expect(answerMatchesSolution(problem({ answer: "8", solution: "Checking both cases gives the two values of k, which sum as required." }))).toBe(true);
  });

  it("rejects a solution that says the problem itself is broken", () => {
    const s = "So the conditions contradict each other, and the problem as written has no answer. The problem needs to be rewritten.";
    expect(solutionMetaOk(problem({ solution: s }))).toBe(false);
    // A proof by contradiction is a technique, not a broken problem.
    expect(solutionMetaOk(problem({ solution: "Suppose $n$ is odd; this leads to a contradiction, so $n$ is even and $n=4$." }))).toBe(true);
  });
});

// Real pairs from the eval runs (runs/repetition-*): the threshold's evidence.
describe("nearCopyOf (cross-session)", () => {
  const rational = "Find the sum of all real numbers $x$ that satisfy $$\\frac{x}{x-2}+\\frac{3}{x+1}=\\frac{6}{x^2-x-2}.$$";
  it("does not call different equations with the same terse prose a copy", () => {
    expect(nearCopyOf("Find the sum of all real numbers $x$ that satisfy $$|x^2-6x+5| = x-1.$$", [rational])).toBeNull();
    expect(nearCopyOf("Find the sum of all distinct real numbers $x$ that satisfy $$x^4-5x^3+8x^2-5x+1=0.$$", [rational])).toBeNull();
  });
  it("lets a new instance of the same type through (types are problem-types.ts's job)", () => {
    expect(
      nearCopyOf("Let $r$ and $s$ be the roots of $x^2-3x-5=0$. The quadratic $p(x)=x^2+bx+c$ has roots $r^2$ and $s^2$. What is $p(1)$?", [
        "Let $r$ and $s$ be the roots of $x^2-5x+3=0$. The quadratic $x^2+bx+c=0$ has roots $r+\\dfrac{1}{s}$ and $s+\\dfrac{1}{r}$. What is $b+c$?",
      ])
    ).toBeNull();
  });
  it("catches the same equation with new numbers: a repeated exercise, not a new one", () => {
    expect(nearCopyOf("Find the sum of all real numbers $x$ that satisfy $x^2-5x+5=19.$", ["Find the sum of all real numbers $x$ that satisfy $x^2-4x+3=12.$"])).not.toBeNull();
  });
  it("catches a reworded or renamed copy, and says which recent problem it copies", () => {
    const recent = [
      rational,
      "For some real number $a \\neq 6$, the equations $$x^2 + ax + 6 = 0 \\quad\\text{and}\\quad x^2 + 6x + a = 0$$ have exactly one root in common. Each equation also has one root that the other equation does not share. What is the product of these two unshared roots?",
    ];
    const copy = nearCopyOf("For a real number $k \\neq 6$, the equations $$x^2 + kx + 6 = 0 \\quad\\text{and}\\quad x^2 + 6x + k = 0$$ have exactly one real root in common. What is the product of the two roots that are not shared?", recent);
    expect(copy?.index).toBe(1);
    expect(
      nearCopyOf("Pipe A fills a tank $5$ hours faster than pipe B, and together they take $6$ hours. How many hours does pipe A take alone?", [
        "Hose X fills a pool $5$ hours faster than hose Y, and together they take $6$ hours. How many hours does hose X take alone?",
      ])
    ).not.toBeNull();
  });
});
