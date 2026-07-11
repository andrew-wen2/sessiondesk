// SubjectProfile — the seam that lets one app serve any tutoring subject.
//
// The app was built for competition math: everything keyed off a free-text
// `Student.level` parsed into a competition + difficulty band, then anchored to a
// corpus of real contest problems. A profile bundles the pieces that are actually
// subject-specific so the rest of the pipeline (auth, chunking, deficit-retry,
// expansion, usage accounting, rendering) stays shared:
//
//   - which generation ENGINE runs (corpus-anchored vs. corpus-free prompt)
//   - how a generated answer is VALIDATED (AIME 0–999 vs. lenient)
//   - how generated content is RENDERED (math / code / prose)
//   - the user-facing COPY for the level field
//
// Two profiles ship today: "competition-math" (the original pipeline, unchanged)
// and "general" (corpus-free, any subject). `getProfile` maps a student's stored
// `generatorProfile` to one, defaulting unknown/legacy values to "general".

import type { Problem } from "@/lib/types";

export type GeneratorProfileKey = "competition-math" | "general";

// Drives the renderer (components/RichContent). "math" → KaTeX on $...$/$$...$$;
// "code" → fenced ```code``` blocks; "prose" → plain text; "mixed" → all three.
export type ContentType = "math" | "code" | "prose" | "mixed";

export interface SubjectProfile {
  key: GeneratorProfileKey;
  // Human label for the profile picker.
  label: string;
  // Corpus-anchored generation (ReferenceProblem). Only competition-math uses it.
  usesCorpus: boolean;
  // How generated problem/solution/lesson text should be rendered.
  contentType: ContentType;
  // Helper text under the Student "level / goals" field, tailored to the profile.
  levelHelp: string;
  // Format guard for a generated answer. `competition` is only meaningful for the
  // corpus profile (passed through from calibration); general ignores it.
  validateAnswer(p: Problem, competition?: string): boolean;
}
