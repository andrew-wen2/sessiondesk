// Maps a student to a competition + difficulty band for corpus anchor retrieval
// and rubric selection, inferred entirely from the free-text `profile`. There are
// no manual calibration fields — the profile string is the single source, so keep
// the competition name and problem-number band explicit in it.

export type Competition = "AMC10" | "AMC12" | "AIME" | "Fma";

export type Calibration = {
  competition: Competition | null;
  bandLow: number | null;
  bandHigh: number | null;
};

function detectCompetition(text: string): Competition | null {
  const t = text.toLowerCase();
  if (/f\s*=?\s*ma|f=ma|\bfma\b/.test(t)) return "Fma";
  if (/aime/.test(t)) return "AIME";
  if (/amc\s*12|amc12/.test(t)) return "AMC12";
  if (/amc\s*10|amc10|\bamc\b/.test(t)) return "AMC10";
  return null;
}

// Pull a numeric problem-number band out of free text, e.g. "problems 10–15",
// "10-15", "last 5" (→ 21–25 on a 25-problem contest), "first 15" (→ 1–15).
function detectBand(text: string, competition: Competition | null): [number | null, number | null] {
  const t = text.toLowerCase().replace(/[–—]/g, "-"); // normalize dashes
  const range = /\b(\d{1,2})\s*-\s*(\d{1,2})\b/.exec(t);
  if (range) return [Number(range[1]), Number(range[2])];

  const max = competition === "AIME" ? 15 : 25;
  const last = /last\s+(\d{1,2})/.exec(t);
  if (last) return [Math.max(1, max - Number(last[1]) + 1), max];
  const first = /first\s+(\d{1,2})/.exec(t);
  if (first) return [1, Number(first[1])];
  return [null, null];
}

// When the level names a competition but no explicit problem-number band, aim
// high rather than leaving the band unset (which would pull anchors across all
// difficulties, skewing easy). A challenging default beats an unset one for a
// tutor who wants problems the student can't already do.
const DEFAULT_BAND: Record<Competition, [number, number]> = {
  AIME: [6, 15],
  AMC10: [12, 25],
  AMC12: [12, 25],
  Fma: [12, 25],
};

// Infer competition + difficulty band from the student's profile text. Returns a
// null competition when the text names none — that is the signal the corpus can't
// help, which routes the request through the plan stage's model path instead.
export function calibrationFor(student: { profile: string }): Calibration {
  const text = student.profile;
  const competition = detectCompetition(text);
  let [bandLow, bandHigh] = detectBand(text, competition);
  if (competition && bandLow == null && bandHigh == null) {
    [bandLow, bandHigh] = DEFAULT_BAND[competition];
  }
  return { competition, bandLow, bandHigh };
}

// Difficulty thresholds keyed off the band CEILING (bandHigh). Single source of
// truth shared by tierFor here (model routing) and bandRegister in
// generation-prompt.ts (prompt framing), so the two decisions can't silently
// drift apart. AIME is a 15-problem contest; AMC10/AMC12/Fma are 25-problem.
export const BAND_THRESHOLDS = {
  // tierFor: bandHigh ≥ this routes to Sonnet (vs the easier tier below it).
  tier: { AIME_HARD: 10, AMC_MID: 16 },
  // bandRegister: routine ≤ routineMax, hard ≥ hardMin, core in between.
  register: {
    AIME: { routineMax: 5, hardMin: 10 },
    default: { routineMax: 10, hardMin: 18 }, // AMC10 / AMC12 / Fma
  },
} as const;

// Route generation by difficulty band, keyed off the band CEILING (bandHigh),
// since the prompt drives every set to the hard end of its band.
//   easy → Haiku, scratch        (AMC/Fma #1–15, unclassified)
//   mid  → Sonnet, scratch       (AMC/Fma #16–25, AIME #1–9)
//   hard → Sonnet, variant seeds (AIME #10–15)
export function tierFor(cal: Calibration): "easy" | "mid" | "hard" {
  const { competition, bandHigh } = cal;
  if (!competition) return "easy";
  if (competition === "AIME") return (bandHigh ?? 0) >= BAND_THRESHOLDS.tier.AIME_HARD ? "hard" : "mid";
  // AMC10 / AMC12 / Fma — 25-problem contests
  return (bandHigh ?? 0) >= BAND_THRESHOLDS.tier.AMC_MID ? "mid" : "easy";
}

// Number of problems to generate, by difficulty tier. The hard tier (AIME #10–15
// variants) gets a shorter set — those problems are long and demand sustained work;
// the easy and mid tiers get a fuller set of 10.
export function countForTier(tier: "easy" | "mid" | "hard"): number {
  return tier === "hard" ? 5 : 10;
}

// Coarse category for retrieval, from the student's profile + session topic.
export function categoryFor(profile: string, topic: string): string | null {
  const s = `${profile} ${topic}`.toLowerCase();
  if (/geometr|triangle|circle|angle|polygon/.test(s)) return "geometry";
  if (/combinatori|probabilit|counting|permutation|combination/.test(s)) return "combinatorics";
  if (/number\s*theor|divisor|prime|modul|congruen/.test(s)) return "number_theory";
  if (/algebra|polynomial|function|sequence|equation/.test(s)) return "algebra";
  if (/mechanic|kinematic|dynamic|force|energy|momentum/.test(s)) return "mechanics";
  return null;
}
