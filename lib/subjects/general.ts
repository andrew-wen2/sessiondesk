// The corpus-free profile — the default for any subject that isn't the competition
// math corpus (SAT, languages, AP sciences, coding, music theory, essay writing…).
//
// It has no reference corpus and no problem-number difficulty model. Difficulty is
// a coarse tier parsed from the free-text level (beginner/intermediate/advanced),
// which drives model choice and count via the shared calibration helpers. Content
// is "mixed" so the renderer handles math, code, and prose depending on the
// subject. Answers are validated leniently (open-ended content allowed).

import { answerOkLenient } from "@/lib/generation/verifier";
import type { SubjectProfile } from "./types";

export const generalProfile: SubjectProfile = {
  key: "general",
  label: "General (any subject)",
  usesCorpus: false,
  contentType: "mixed",
  levelHelp:
    "Describe the student's level and goals in plain language, e.g. \"AP Bio unit 3, needs help with genetics\" or \"Spanish, intermediate, past-tense conjugation\". More specific is better.",
  validateAnswer: (p) => answerOkLenient(p),
};

// Coarse difficulty tier for the general path, parsed from the level text. There's
// no problem-number band here, so we key off explicit level words; anything
// advanced/AP/college-level routes to the stronger model, everything else stays on
// the cheaper one. Mirrors tierFor's easy/mid split (there is no corpus "hard"/
// variant path off the corpus).
export function generalTier(level: string): "easy" | "mid" {
  const t = level.toLowerCase();
  if (/\b(advanced|expert|college|university|ap |a-level|honors|olympiad|competitive|proficient|fluent|hard)\b/.test(t))
    return "mid";
  return "easy";
}
