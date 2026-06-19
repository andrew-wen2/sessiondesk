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
  difficulty?: string; // model's self-estimate, e.g. "AIME #12" (calibration aid)
};

export type BookOption = {
  id: string;
  title: string;
};
