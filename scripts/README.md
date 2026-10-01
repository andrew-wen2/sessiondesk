# Scripts

## Generation commands

| Command | Spends? | What it does |
|---|---|---|
| `npm run gen:check` | no | What each tier would run (pipeline, ladder), whether each ladder fits the 285s budget, and whether every provider has credentials and every model a price. Exits nonzero on a problem. Run it after any env change. |
| `npm run gen:baseline -- --email you@x --days 60 [--json]` | no | Read-only failure report per tier: short/failed sets, drop causes, killed runs, p95 — from `Session.genMeta` and the `GenerationAttempt` table. Undercounts before attempt tracking; it says so. |
| `npm run gen:smoke -- --yes [--tier mid] [--pipeline cascade]` | **yes**, one set | One real generation through the configured pipeline; prints kept/asked, wall time, cost and (cascade) which rung wrote each problem. Writes nothing to the database. |
| `npm run eval:generation -- --dry-run [--pipeline cascade --repeat 30]` | no | Lists the samples an eval run would generate and a cost range. |
| `npm run eval:generation -- --yes --out runs/cascade.jsonl --pipeline cascade --repeat 30 [--concurrency 3] [--max-dollars 60]` | **yes** | The eval run. `--resume` continues it (and refuses a file from a different configuration). |
| `npm run eval:generation -- --rate runs/cascade.jsonl` | no | Human pass: is each answer correct (y/n/?), and how well calibrated is it (1–5). Blinded to pipeline and model. |
| `npm run eval:generation -- --compare runs/legacy.jsonl runs/cascade.jsonl` | no | Per fixture: short-set rate, p95, $/set, wrong-answer rate, rating; plus kept problems by rung. |
| `npm run eval:generation -- --gate runs/cascade.jsonl` | no | Cutover gate per tier: 0 short sets in ≥30 samples and p95 under budget. Exit 0 pass, 1 fail, 2 insufficient evidence. |
| `npm run gen:admit -- --yes --rung openweight:deepseek-flash [--tier mid]` | **yes**, a few short calls | Admission test for a new ladder rung: tool call under the rung's real settings, LaTeX backslashes intact (`\binom`, `\frac`, `\theta`...). Any corruption disqualifies the rung. |
| `npm run gen:slot -- --yes --profile "AMC 10, problems 16-25" --slot 3 --rung 0 [--trace]` | **yes**, one call | Reproduce one cascade slot: the exact prompt (`--trace`), raw finish reason, guard verdict, latency. |
| `npm run eval:solver -- ...` | yes | Is the independent solver right? See below. |
| `npm run eval:accuracy -- --yes --rung easy=openweight:... [--per-tier 30]` | **yes** | How often a rung ships a wrong answer key: cheap cross-family judge, Opus on disagreement plus a 15% audit. |
| `npm run eval:solve-first -- --yes --contest-only [--lean \| --construct \| --forward] [--no-opus] --writer ... --out runs/x.jsonl` | **yes** | One problem per call, answered blind by a self and a cross-family solver (and Opus unless `--no-opus`). `--lean` is the cascade's construct prompt, `--forward` the cascade's own writer; `--band 16-25`, `--timeout`, `--max-tokens` override the plan and rung. |
| `npm run eval:judge -- --yes --in runs/e2e.jsonl --out runs/judge.jsonl` | **yes** | Independent correctness of SHIPPED problems: Opus solves each blind; a key is "wrong" only when two Opus solves agree against it. Opus can still be wrong on its own problems, so read its "wrong" list. |
| `npm run eval:repetition -- --yes --fixtures F --sessions 3 --out runs/rep.jsonl` | **yes** | Runs sessions IN ORDER (each sees the previous ones' problems, as the route passes them), then groups every problem by underlying type with one model call: distinct types, repeats within a set, types repeated across sets. `--cluster FILE` groups one existing run; **`--compare A,B` groups several runs in ONE call** and reports each, which is the only fair comparison (separate grouping calls pick different granularities). |
| `npm run eval:difficulty -- --yes --generated runs/x.jsonl --out runs/d.jsonl [--solver ...]` | **yes**, cheap | How hard generated problems play: a weak solver on real corpus problems at every position (the curve), then on the generated ones. `--summary FILE --expect-band 1-15` is the standing gate: exit 1 if the set plays outside the band or the curve is too flat to measure. |
| `npm run eval:difficulty-judge -- --yes --judges SPEC[,SPEC] --modes ladder,pairwise --items 90` | **yes**, cheap | Can a difficulty judge order REAL held-out contest problems by human difficulty (E2H ratings)? Reports Spearman vs human rating next to problem number's, and the #6–10 vs #11–15 AUC. Gate before trusting a judge on generated problems. |
| `npm run eval:program-solver -- --yes --models SPEC[,SPEC] --items 80` | **yes**, cheap | The blind program solver on real problems with known answers: share it computes, and share of those WRONG (the false-veto rate). |
| `npm run eval:validity -- --yes --items 40` | **yes**, cheap | Well-posedness screening: false flags on real problems vs detections on cheaply broken variants, for the old validity prompt, the staged one, and the assumption veto. |
| `npm run join:e2h` | no (read-only DB) | Rebuilds `data/corpus-difficulty.json`: Easy2Hard-Bench human difficulty joined onto the corpus. |
| `npm run extract:taxonomy -- --yes` | **yes**, ~$0.20 | Rebuilds `data/corpus-taxonomy.json`: every corpus problem labeled, clustered into canonical types per category, counted per contest position. Labels are cached in `runs/taxonomy-labels.jsonl`. |

Every eval starts all its items at once by default (`--concurrency N` limits it); open-weight calls wait out HTTP 429s. Because `--max-dollars` is checked only before an item starts, it cannot stop a fully parallel run partway.

Rollback: set `GENERATION_PIPELINE=legacy` (or the per-tier variable) in Vercel and redeploy; no code change. Rows the cascade wrote still render and grade on the legacy path.

## Corpus ingestion

`ingest-corpus.ts` populates the `ReferenceProblem` table with real past competition
problems. These are used **only** to retrieve same-difficulty "anchor" examples that
calibrate problem generation (see `lib/corpus-retrieval.ts`). They are never shown to
students verbatim or redistributed — internal calibration reference only.

Run:

```
npm run ingest:corpus
```

Idempotent — each problem gets a deterministic id, so re-running upserts in place.

## Sources (pulled live from the HuggingFace datasets-server JSON API)

| Competition | Dataset | Count | Difficulty signal |
|---|---|---|---|
| AIME | `gneubig/aime-1983-2024` | 933 | Year + problem number (`Part` distinguishes AIME I/II) |
| AMC (numbered) | `AI-MO/aimo-validation-amc` | 83 | Year + AMC 10/12 + problem number parsed from the AoPS `url` |
| AMC (level) | `kaggle-aimo/amc_filtered` | 1081 | AMC 10 vs AMC 12 only (no problem number) |

`category` (algebra / number_theory / geometry / combinatorics) is derived from the
statement with keyword heuristics; rows with no clear hit are left null and retrieval
drops the category filter when it would starve results.

## F=ma

No clean public F=ma dataset exists, so `ingest-fma.ts` pulls the official AAPT
problems-only exam PDFs, extracts text with `pdf-parse`, splits on problem number,
and keeps the **figure-free** problems (many F=ma problems depend on a diagram that
doesn't survive PDF→text — those are dropped). The exam PDFs have no answer key, so
F=ma rows have `answer: null` — fine, since anchors convey *difficulty* via the
statement + problem number, not the answer.

```
npm run ingest:fma
```

Sources are a curated list of confirmed-reachable AAPT exam URLs in `ingest-fma.ts`
(2024, 2023, 2021, 2010, 2009 ≈ 72 problems). Add more years by appending `{ year, url }`.
USAPhO (free-response) could be ingested the same way but isn't yet — no roster student
needs it. AAPT exams are copyrighted; stored for internal calibration only.

## Copyright

Problem statements are stored for personal, internal calibration use only. Do not
redistribute the corpus.

## Generation pipeline eval

Two scripts, two different jobs. Both spend real API credit — on whichever vendors
the configured pipeline uses (Anthropic, Gemini, and any open-weight host on a
cascade ladder) — and both refuse to run without `--yes` (use `--dry-run` first to
see what they'd do and an estimated cost).

**`eval-solver.ts`** — is the independent solver (`lib/generation/solve.ts`) any
good? Feeds ~60 real corpus problems with known-verified answers (sampled by
`dump-corpus-fixtures.ts` into `scripts/eval-fixtures/corpus-sample.json`, committed
— no live DB connection needed to run the eval itself) and reports accuracy by
source. **This is an upper bound, not an estimate**, on generated-problem accuracy —
see the file header for why.

```
npx tsx scripts/dump-corpus-fixtures.ts   # one-time / re-run to refresh the sample
npm run eval:solver -- --dry-run
npm run eval:solver -- --yes --out runs/solver-baseline.jsonl
```

**`eval-generation.ts`** — is a change to the pipeline better or worse? Runs the
real `generateProblems()` pipeline against `scripts/eval-fixtures/generation-fixtures.json`
(15 synthetic student profiles spanning AIME 10-15 down to non-contest Spanish).
Contest-anchored fixtures legitimately touch Prisma via the pipeline's own corpus
retrieval — that's the system under test doing its normal job, not a bootstrap
dependency; non-contest fixtures never touch the corpus at all.

```
npm run eval:generation -- --dry-run
npm run eval:generation -- --yes --out runs/baseline.jsonl
npm run eval:generation -- --rate runs/baseline.jsonl        # your 1-5 rating — THE headline metric
npm run eval:generation -- --compare runs/baseline.jsonl runs/candidate.jsonl
```

Automated numbers (agreement rate, kept/asked, dollars) are diagnostics, not the
score — they're gameable by loosening the guards, which is exactly the kind of
change this eval exists to catch. `--rate` is what actually answers "did this
change help." Run output goes to `/runs`, gitignored (may contain real generated
problems); the fixtures under `eval-fixtures/` are synthetic and committed.
