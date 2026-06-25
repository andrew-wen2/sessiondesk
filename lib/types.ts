// Shared client-facing shapes (server components serialize Dates to ISO strings
// before passing across the client boundary).

export type CalendarSession = {
  id: string;
  start: string; // ISO 8601
  paid: boolean;
  amount: number;
  studentName: string;
};

// Fields the Add-session combobox needs — name + the rate/level it autofills.
export type StudentOption = {
  id: string;
  name: string;
  rate: number;
  level: string;
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
};

export type BookOption = {
  id: string;
  title: string;
};
