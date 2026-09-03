# Corpus ingestion

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

Two scripts, two different jobs. Both spend real Anthropic API credit and both
refuse to run without `--yes` (use `--dry-run` first to see what they'd do and an
estimated cost).

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
