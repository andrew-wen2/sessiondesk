// Shared client-facing shapes (server components serialize Dates to ISO strings
// before passing across the client boundary).

import type { SessionStatus } from "@/lib/session-status";

export type CalendarSession = {
  id: string;
  start: string; // ISO 8601
  durationMin: number;
  paid: boolean;
  amount: number;
  studentName: string;
  topic: string; // shown in the calendar preview popover; "" when unset
  // Stored status only — the calendar never renders effectiveStatus(). Deriving
  // "completed" from the clock inside these components would mismatch between the
  // server render and hydration for a session that just started.
  status: SessionStatus;
};

// Fields the Add-session combobox needs — name + the rate it autofills, plus the
// profile text it echoes back so you can see who you picked.
export type StudentOption = {
  id: string;
  name: string;
  rate: number;
  profile: string;
};

export type Problem = {
  problem: string; // may contain LaTeX: $...$ or $$...$$
  answer: string;
  solution: string;
  // Adapt path (hard/variant) only: the terse key-insight + major-steps sketch the
  // heavy reasoning pass emits; `solution` is expanded from it by a cheap model.
  // Absent on scratch/easy problems and on all problems generated before this field
  // existed — display/PDF read `solution`, which is always populated.
  solutionSketch?: string;
  difficulty?: string; // model's self-estimate, e.g. "AIME #12" (calibration aid)
  // Cascade writers only, stripped before a set is stored: a mathjs program computing
  // the answer from the statement (lib/generation/answer-check.ts), and a one-line
  // summary of the solution method (method-level dedup).
  answerCheck?: string;
  method?: string;
  masked?: string; // reverse candidates: the given hidden from the seed, as it appears there
};

// A generated lesson — structured teaching content for a session, stored on
// Session.lesson. Parallel to Problem[]. `content`/`solution` may carry LaTeX
// ($...$ / $$...$$) or fenced code, rendered by RichContent. Practice items reuse
// the Problem-shaped answer/solution (answer may be empty for open-ended work).
export type Lesson = {
  title: string;
  objectives: string[]; // what the student should be able to do after
  sections: { heading: string; content: string }[]; // the explanation, in order
  workedExamples: { problem: string; solution: string }[];
  practice: { problem: string; answer: string; solution: string }[];
};

// A real reference problem retrieved from the corpus, used to calibrate (or, in
// the hard tier, seed) generation. One shape shared by the retriever
// (corpus-retrieval), the prompt builder (generation-prompt), and the verifier.
export type Anchor = {
  source: string;
  number: number | null;
  statement: string;
  answer: string | null;
  // The seed's real worked solution from the corpus (AIME/AMC are fully populated;
  // F=ma is null). Injected on the adapt path so the model transforms it instead of
  // re-deriving from scratch. Null → fall back to statement-only re-solve.
  solution: string | null;
  // Adapt path, Stage A: the seed's real solution distilled into a terse numbered
  // step-by-step sketch (cheap Haiku call). When present, the transpose stage mutates
  // THIS sketch rather than re-reading the prose solution — handing the model a concrete
  // skeleton to transpose suppresses the heavy re-derivation. Populated by the route
  // after retrieval; absent on the scratch path or if Stage A fails.
  sketch?: string;
  // The ReferenceProblem id, when the retriever supplies it (cascade seeded slots record
  // it so the student's next sets never reuse the same real problem).
  id?: string;
};
