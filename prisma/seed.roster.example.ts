import type { StudentSeed } from "./seed";

// TEMPLATE — copy this file to prisma/seed.roster.ts (gitignored) and replace
// the placeholders with the real roster. seed.ts imports from ./seed.roster.
// weekday: 0=Sun, 1=Mon ... 6=Sat. hour: local start hour (24h).
export const students: StudentSeed[] = [
  {
    name: "Student One",
    // Difficulty is inferred from this text — name the competition and the
    // problem-number band, e.g. "AIME, problems 10-15".
    level: "AIME, problems 10-15, number theory",
    rate: 90,
    notes: "anything not captured per-session",
    weekday: 4,
    hour: 17,
  },
  {
    name: "Student Two",
    level: "AMC 10, problems 16-22, number theory",
    rate: 60,
    notes: "anything not captured per-session",
    weekday: 0,
    hour: 10,
  },
  // …additional students follow the same shape.
];
