// Maps a student to a competition + difficulty band for corpus anchor retrieval
// and rubric selection, inferred entirely from the free-text subject/level. There
// are no manual calibration fields — the level string is the single source.

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

// Infer competition + difficulty band from the student's subject + level text.
export function calibrationFor(student: { subject: string; level: string }): Calibration {
  const text = `${student.subject} ${student.level}`;
  const competition = detectCompetition(text);
  const [bandLow, bandHigh] = detectBand(text, competition);
  return { competition, bandLow, bandHigh };
}

// Coarse category for retrieval, from the student's subject + session topic.
export function categoryFor(subject: string, topic: string): string | null {
  const s = `${subject} ${topic}`.toLowerCase();
  if (/geometr|triangle|circle|angle|polygon/.test(s)) return "geometry";
  if (/combinatori|probabilit|counting|permutation|combination/.test(s)) return "combinatorics";
  if (/number\s*theor|divisor|prime|modul|congruen/.test(s)) return "number_theory";
  if (/algebra|polynomial|function|sequence|equation/.test(s)) return "algebra";
  if (/mechanic|kinematic|dynamic|force|energy|momentum/.test(s)) return "mechanics";
  return null;
}
