# TODOS

Deferred from the /autoplan review of `docs/designs/student-accounts.md` (2026-09-23).

## Tutor per-student accuracy rollup (P3)
- **What:** Show each student's accuracy across sent sets on the student page.
- **Why:** The long-term payoff of student identity is the results loop, not retrieval.
- **Context:** Works today from `Submission` keyed by `studentId`; independent of accounts.
- **Depends on:** At least a few completed sets.

## Redo-missed-problems practice mode (P3)
- **What:** Let a student re-attempt problems they missed, as fresh practice.
- **Why:** Old sets are review-only (`applyAttempt` refuses resolved problems).
- **Context:** Changes the commit-then-reveal contract; needs its own design.

## Feed results into generation calibration (P3)
- **What:** Use a student's per-topic accuracy as a calibration input to the next set.
- **Depends on:** The generation rebuild landing.

## Isolated Postgres integration tests for claim/mint races (P2)
- **What:** A disposable-DB suite covering concurrent claim, mint, and remove.
- **Why:** Pure-function tests and DB constraints cover logic, not the transaction wiring.
- **Context:** CLAUDE.md forbids local DB ops; a Neon branch per CI run is the likely path.

## Bearer-link token rotation (P3)
- **What:** "Turn off text link" that rotates the token and keeps the set on the student's page.
- **Why:** Today one token controls both the texted link and account visibility.
