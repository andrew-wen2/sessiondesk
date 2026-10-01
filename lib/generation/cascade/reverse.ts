// Reverse candidates (ReverseMath, 2026; docs/designs/generation-research.md phase 5):
// a real problem with a verified answer A has one given N hidden, A becomes a stated
// fact, and the question asks for N. The key is N, read off the seed rather than
// computed, so it is right whenever the seed's key is and N is uniquely determined.
// Uniqueness is what the cheap solvers and the well-posedness check still verify; this
// file checks the part code can: that the key really is a given of the seed.
import { evaluateAnswer } from "@/lib/generation/answer-match";
import type { Anchor, Problem } from "@/lib/types";

// Every numeric literal in a statement: plain numbers and \frac{a}{b} / \dfrac{a}{b}.
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  const t = text.replace(/\\[dt]?frac\{(-?\d+)\}\{(\d+)\}/g, (_m, a: string, b: string) => {
    out.push(Number(a) / Number(b));
    return " ";
  });
  for (const m of t.matchAll(/-?\d+(?:\.\d+)?/g)) out.push(Number(m[0].replace(/,/g, "")));
  return out;
}

const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
// The hidden given's value as the writer reported it: "12", "six", "BC=4", "\\frac{9}{2}".
export function maskedValue(masked: string | undefined): number | null {
  const m = (masked ?? "").trim();
  if (!m) return null;
  const direct = evaluateAnswer(m);
  if (direct !== null) return direct;
  const word = WORDS[m.toLowerCase().replace(/[^a-z]/g, "")];
  if (word !== undefined) return word;
  const nums = numbersIn(m);
  return nums.length ? nums[nums.length - 1] : null;
}

// null when the key traces back to the seed, else why not. The seed's answer need NOT
// appear in the new problem: AIME answers are often encodings (m+n of a fraction m/n),
// and a correct reversal states the underlying value, not the encoding. Whether the
// stated facts really pin down the key is the cheap solvers' job.
export function reverseKeyProblem(p: Problem, seed: Anchor): string | null {
  const key = evaluateAnswer(p.answer);
  const masked = maskedValue(p.masked);
  const seedAnswer = evaluateAnswer(seed.answer ?? "");
  if (key === null) return "answer is not a number";
  if (masked === null || !close(key, masked)) return "answer is not the hidden given";
  if (!numbersIn(seed.statement).some((n) => close(n, masked)) && !seedHasWord(seed.statement, masked)) return "hidden given does not appear in the seed";
  if (seedAnswer !== null && close(key, seedAnswer)) return "answer equals the seed's answer";
  return null;
}

function seedHasWord(statement: string, value: number): boolean {
  const lower = statement.toLowerCase();
  return Object.entries(WORDS).some(([w, n]) => n === value && new RegExp(`\\b${w}\\b`).test(lower));
}
