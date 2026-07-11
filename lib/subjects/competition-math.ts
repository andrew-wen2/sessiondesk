// The original engine, expressed as a profile. Generation itself still lives in
// app/api/generate/route.ts (corpus retrieval + multi-stage adapt pipeline); this
// object only carries the metadata + answer guard that differ by profile. Answer
// validation stays competition-aware: the route passes the calibrated competition
// (from lib/calibration) so the AIME integer-0–999 / AMC MC-letter rules fire.

import { answerOk } from "@/lib/generation/verifier";
import type { SubjectProfile } from "./types";

export const competitionMathProfile: SubjectProfile = {
  key: "competition-math",
  label: "Competition Math",
  usesCorpus: true,
  contentType: "math",
  levelHelp:
    "Calibration string for the corpus generator — the difficulty (competition + problem-number band) is inferred from this text, so keep it specific, e.g. \"AIME, problems 10–15\".",
  validateAnswer: (p, competition) => answerOk(p, competition),
};
