import type { StudentSeed } from "./seed";

// TEMPLATE — copy this file to prisma/seed.roster.ts (gitignored) and replace
// the placeholders with the real roster. seed.ts imports from ./seed.roster.
// weekday: 0=Sun, 1=Mon ... 6=Sat. hour: local start hour (24h).
export const students: StudentSeed[] = [
  {
    name: "Student One",
    // Subject, level, and goals in one string — everything generation calibrates
    // from. For contest prep name the competition and the problem-number band
    // ("AIME, problems 10-15"); otherwise describe it plainly ("AP Biology, unit 3").
    profile: "AIME, problems 10-15, number theory",
    rate: 90,
    notes: "anything not captured per-session",
    weekday: 4,
    hour: 17,
  },
  {
    name: "Student Two",
    profile: "AMC 10, problems 16-22, number theory",
    rate: 60,
    notes: "anything not captured per-session",
    weekday: 0,
    hour: 10,
  },
  // …additional students follow the same shape.
];
