// Profile registry. Resolve a student's stored `generatorProfile` to a
// SubjectProfile, defaulting unknown/legacy/empty values to "general" so a bad DB
// value never 500s a page or a generation. Import from "@/lib/subjects".

import type { SubjectProfile } from "./types";
import { competitionMathProfile } from "./competition-math";
import { generalProfile } from "./general";

export type { SubjectProfile, GeneratorProfileKey, ContentType } from "./types";
export { generalTier } from "./general";

const PROFILES: Record<string, SubjectProfile> = {
  "competition-math": competitionMathProfile,
  general: generalProfile,
};

// The set offered in the UI picker, in display order.
export const PROFILE_OPTIONS: SubjectProfile[] = [generalProfile, competitionMathProfile];

export function getProfile(key: string | null | undefined): SubjectProfile {
  return (key && PROFILES[key]) || generalProfile;
}

// User-facing vocabulary for the practice artifact, keyed off the profile. The math
// corpus keeps contest wording ("Problem", mono answers); every other subject gets
// subject-neutral wording ("Exercise", prose answers) so an English or history tutor
// isn't shown math framing. Single source of truth for these strings.
export interface UiLabels {
  isMath: boolean;
  item: string; // singular, e.g. "Problem" | "Exercise"
  sectionTitle: string; // practice section heading
  generate: string; // generate button
  regenerate: string;
  download: string; // noun used in download filenames/labels
}

export function uiLabels(key: string | null | undefined): UiLabels {
  const isMath = getProfile(key).contentType === "math";
  return isMath
    ? {
        isMath,
        item: "Problem",
        sectionTitle: "Practice problems",
        generate: "Generate problems",
        regenerate: "Regenerate problems",
        download: "problems",
      }
    : {
        isMath,
        item: "Exercise",
        sectionTitle: "Practice",
        generate: "Generate practice",
        regenerate: "Regenerate practice",
        download: "practice",
      };
}
