# Research: how others generate problems, and what to change here

2026-09-23. A literature and industry review of LLM problem generation, judged against
five priorities: diversity, few duplicates, low cost, quality (difficulty on target),
and accuracy (correct answer keys). Then a plan for the cascade pipeline
(`lib/generation/cascade/`). Companion to `generation-cascade.md`.

Legend: **[V]** checked in the paper or abstract. **[M]** recalled, not re-checked.
**[U]** couldn't be verified. The 2026 preprints are recent and not peer-reviewed.

## Where we are (measured, not assumed)

| | Opus 5.5 writer, easy AMC 10–15 | DeepSeek writer |
|---|---|---|
| $/set | $0.27–0.47 | $0.04–0.10 |
| Wall clock | 67–113s | 160–212s |
| Complete sets | most; 1 of 3 short (`no distinct candidates left`) | 1 of 2 short (deadline) |
| Plays like | #6–15 (user: #8–12) | #3 |
| Calls per set | ~13–17 generation, **39–51 solve** | ~11–13 gen, ~30 solve |

**Rejections across the last 7 Opus sets: 26 `solver-disagree`, 14 `duplicate`.** About
two-thirds of the over-generation pays for wrong answer keys, not repetition. This
number reorders the plan: fixing correctness at write time is worth more than any
diversity change.

Repetition is better but not solved. `repetition-final3` grouped 30 problems into 16
types, with 1.7 within-set repeats per set. "Word problem set up as a quadratic"
appears 4 times in one set. That's weaker than the 0.97 types/problem recorded earlier.

## Findings, ranked by relevance to this pipeline

### 1. Compute the answer key with code, don't trust the writer's arithmetic
*Accuracy, cost, and indirectly duplicates.*

- **PAL** [V] ([2211.10435](https://arxiv.org/abs/2211.10435)): the model writes a program and the interpreter computes the answer. GSM-Hard 61.2% vs 23.1% for chain-of-thought (CoT).
- **Program of Thoughts** [V] ([2211.12588](https://arxiv.org/abs/2211.12588)): about +12% over CoT.
- **Prove, "Programs as Verifiers"** [V] ([2410.12608](https://arxiv.org/abs/2410.12608)): translate each solution to a program and drop it if the program disagrees with the stated answer. +8–18% over plain majority vote. This is our consistency guard with an executor in place of numeric comparison.
- **GSM-Symbolic** [V] and **CBIT** [V] ([2511.07932](https://arxiv.org/abs/2511.07932)): the problem is a parameterized blueprint, so the key is correct by construction. CBIT is deployed commercially: 6,732 learners, 17.8% fewer errors than expert-written items.
- **Decorrelation** [V]: when two strong models are both wrong, they give the *same* wrong answer about 60% of the time, even across providers (Kim et al., [2506.07962](https://arxiv.org/abs/2506.07962); Goel et al., [2502.04313](https://arxiv.org/abs/2502.04313)). Error similarity rises with capability. Code execution fails differently, which makes it the most independent check available.
- **No evidence** [V] that prompting a model to "pick the answer first" lowers key error on its own. The published by-construction guarantees come from mechanical templates and inversion. Our 28/30 vs 21/30 construct result is better evidence than anything published.

**Why it's #1 here:** 65% of rejections are wrong keys. Each costs a writer call plus 2–3
solver calls. A key computed by code before any solver runs removes most of that spend
and shrinks the 20-spare buffer. It also adds a failure mode that doesn't correlate with
the text solvers.

**Limits:**
- Code can faithfully compute a wrong *reading* of the problem, so this checks the key, not validity.
- Useless for proofs, open response, and non-math subjects.
- Needs an execution environment (see Plan, phase 1).

### 2. Build the skill taxonomy once, offline, and sample slots in code
*Diversity, duplicates, cost, difficulty.*

- **KPDDS/KPMath** [V] ([2403.02333](https://arxiv.org/abs/2403.02333)): topics and key points extracted from the corpus into a co-occurrence matrix. Generation samples 2–3 topics plus key points from it. Filters kept about 76%.
- **MATH² skill pairs** [V] ([2407.21009](https://arxiv.org/abs/2407.21009)): about 110 skills extracted from MATH. Each question must use two sampled skills. Model success rate on the result ≈ the *square* of the MATH rate, so composition measurably raises difficulty. Yield was low without validation (62% of survivors needed human edits).
- **MathScale** [V] ([2403.02884](https://arxiv.org/abs/2403.02884)): a concept graph, sampled by random walk.
- **AttrPrompt** [V] ([2306.15895](https://arxiv.org/abs/2306.15895)): sampling attribute values in code beat "be diverse" prompts by 6–10 points downstream, at about 5% of the query cost.
- **The literature's pattern:** diversity is controlled *before* generation, so dedup afterwards removes little. SAND-Math's semantic dedup removed 7.3% [V]; Persona Hub's persona dedup sits near 0.9 cosine [V]. Our dedup-driven rejections (14 of 40) mean upstream conditioning is still weak.

**Relevance:** the typed-slot menu is a per-session, LLM-sampled version of this. The
published version is stronger in three ways:
- It extracts once from the ~1,180 answered corpus problems.
- It samples in code, so sampling is deterministic, auditable, and can exclude the student's last N sets.
- It weights pairs by co-occurrence, so combinations stay realistic for AMC.

It replaces two per-request LLM calls, and their latency and failure modes, with a lookup.

### 3. Place difficulty by pairwise comparison against real anchors; stop using pass rates
*Quality.*

- **Pass rates are the weakest signal** [V]. LLM success rate correlates with human difficulty at only r ≈ 0.22–0.24 (Ballon et al., [2512.14220](https://arxiv.org/abs/2512.14220)). The "curse of knowledge" ([2512.18880](https://arxiv.org/abs/2512.18880)): strong models can't simulate weaker solvers. This explains why the GLM-Flash filter couldn't separate #6–10 from #11–15. At 3×15 trials, binomial noise alone swamps that gap.
- **Pairwise beats absolute** [V]:
  - Kolesnikova et al. ([2605.18562](https://arxiv.org/abs/2605.18562)): pairwise correlates 0.13–0.15 better with empirical difficulty than absolute rating (r ≈ 0.63–0.67 overall).
  - Few-shot examples barely help pairwise judging. That matches our result that few-shot references didn't move the cheap writer.
  - Ballon et al.: Bradley–Terry scores over about 36 comparisons per problem reached r ≈ 0.80 on Omni-Math.
- **Better ground truth** [V]: **Easy2Hard-Bench E2H-AMC** ([2409.18433](https://arxiv.org/abs/2409.18433)) has 3,975 AMC/AIME/HMMT problems with IRT difficulty fitted to *published student solve rates*. Problem number is a noisy proxy that shifts year to year. Our "#6–10 vs #11–15" labels are noisy themselves. Coverage of our years and the license: [U].
- **Generation-side lever** [V]: two-skill composition (finding 2) is the one prompt-only intervention with a measured difficulty effect. The literature otherwise generates, then measures and selects. It does not try harder conditioning.
- **Simulated students plus IRT** [V] ([2601.09953](https://arxiv.org/abs/2601.09953)): r ≈ 0.75–0.82 on NAEP, but it takes 300 samples per item and isn't validated at contest level. Too expensive to run on demand.
- **Caveat:** no paper shows reliable separation of *adjacent* 5-problem AMC bands for *generated* items. It has to be validated on held-out real problems first, which costs nothing to generate.

### 4. Dedup on solution method, not wording
*Duplicates.*

- The isomorphic-problem literature (CBIT; isomorphic physics problems, [2602.05114](https://arxiv.org/html/2602.05114) [V]) defines "the same problem" as the same steps and operations with a different surface. That is exactly the duplicate shingle Jaccard misses: "word problem → quadratic" four times with different stories.
- **Approach:**
  - Have each candidate carry a short structured `method` field: the key technique plus a step skeleton.
  - Dedup on it, within the set and against history.
  - Send only the ambiguous band to one cheap "same method?" judge call.
  - That could let the surface threshold loosen, so fewer genuinely new problems get rejected.
- **Unknown:** no published precision or recall for method-level dedup of math problems [U]. Embedding cosine shares the shingle blind spot: it keys on topic and wording. Published thresholds range from 0.85 to 0.99 with no consensus.

### 5. Validity is the weakest link; stage the check and let solvers veto
*Accuracy.*

- **MathQ-Verify** [V] ([2505.13903](https://arxiv.org/abs/2505.13903), KDD '26):
  - Only 60.5% of its 2,147 LLM-generated questions were valid.
  - Its staged check (atomic conditions → contradictions → goal completeness) beat "is this valid?" by up to +25 F1.
  - A 3-model unanimous vote gave about 91% precision and 62% recall.
- **Models notice flaws but answer anyway** [V]. MathTrap300: accuracy drops 33–39% on unsolvable variants. Models often flag the problem mid-reasoning, then output a number regardless.
- **Relevance:** solver agreement is blind to ill-posedness, because every solver quietly adds the same assumption. `buildValidityPrompt` is one undifferentiated call. Two changes:
  - Give it the staged structure.
  - Add a structured `wellPosed: false | assumption` field to every blind solver, treated as a veto. It's free, because the solver calls already run.

### 6. Verbalized Sampling at the type stage
*Diversity; nearly free.*

- **Verbalized Sampling** [V] ([2510.01171](https://arxiv.org/abs/2510.01171)):
  - Mode collapse is partly *typicality bias* in preference data, so it persists across vendors.
  - Asking for k candidates with probabilities and sampling the tail gave 1.6–2.1× diversity.
  - On synthetic math questions, direct-prompted data scored *below* baseline (30.6% vs 32.8%), while VS data reached 37.5%.
- **Intent Factored Generation** [V] ([2506.09659](https://arxiv.org/abs/2506.09659)): sample the intent hot, write cold. Our type → construct → write flow already has this shape.
- **Artificial Hivemind** (NeurIPS 2025) [V] and **NoveltyBench** [V]: model families converge on the same outputs, and bigger models are often *less* diverse. Swapping writer vendors won't buy diversity.
- **Temperature** buys paraphrase, not new problem types.

### 7. Cheap verifiers have blind spots; don't grade the pipeline with its own verifiers
*Accuracy measurement.*

- **"Cheap Verifiers, Large Blind Spots"** [V] ([2609.01345](https://arxiv.org/abs/2609.01345)):
  - Cheap verifiers accepted wrong answers 12–55% of the time.
  - One cascade's dashboard showed 3% error while the true delivered error was 32%.
- **Weaver** [V] ([2506.18203](https://arxiv.org/abs/2506.18203)): weighting verifiers by measured accuracy beats one vote each.
- **Self-consistency backfires** [V] ([2608.11403](https://arxiv.org/html/2608.11403)) near the edge of solver ability. Agreement correlates with correctness at only ρ 0.20–0.59 in general ([2607.08065](https://arxiv.org/abs/2607.08065)). It is strong only when solvers comfortably outclass the problem, which holds for AMC with thinking-on solvers.
- **Statistics:** 0 wrong in 57 bounds the error rate below about 5.3% (rule of three). A claim of <1% needs about 300 clean items.

### 8. Cost mechanics
- **Gate order is the biggest cost lever after finding 1.** Run the cheapest checks first: deterministic guards → code-computed key → validity → cheap solvers → Opus. Opus votes run only on survivors (FrugalGPT, [2305.05176](https://arxiv.org/abs/2305.05176); agreement-based cascading, [2407.02348](https://arxiv.org/abs/2407.02348), 2–25× cheaper).
- **Parallel over-generation.** Firing the expected candidate count up front costs the same tokens as sequential retries, minus the latency. Latency, not tokens, is the binding limit at 300s.
- **Prompt caching** only pays on large shared prefixes reused inside the TTL (rubric plus anchors across parallel candidates or judge calls).
  - Opus 5.5 cache read: $0.20 vs $4.
  - DeepSeek cache hits: about 2% of a miss.
- **Prices, fetched 2026-09-23, per 1M in/out:**
  - Opus 5.5: $4/$20
  - Gemini 3.8 Flash: $0.75/$3.75
  - DeepSeek V4.1 Flash: $0.30/$1.20, half off-peak
  - GLM-5.3 on OpenRouter: $0.56/$1.76
  - **Gemini 3.x prices roughly double on 2027-01-01.** Re-run the cost comparison before then.
- **Batch APIs (50% off)** only fit if a set is pre-generated when the session is booked. That runs into the "no cached results / problem bank" non-goal, so it's a product decision, not a default.

### Skip (evidence says not worth it here)
- **Lean autoformalization:** Opus 4 compiled 77.9% of formalizations, but only 21.5% were semantically faithful ([2512.00997](https://arxiv.org/html/2512.00997)). Too slow per request.
- **Off-the-shelf process reward models:** ProcessBench F1 falls from 47.9 to 23.8 on competition math ([2412.06559](https://arxiv.org/abs/2412.06559)).
- **Self-play and trained generators** (R-Zero, Absolute Zero, SwS, ScaleDiff, QueST): all need training, excluded by the non-goals.
- **MinHash/LSH:** exact pairwise Jaccard is better at 30–60 items.
- **Relying on temperature or a vendor swap for diversity:** finding 6.

## Plan

Each phase is a separate change with its own `--compare` eval against the current
cascade. The human `--rate` stays the headline metric (CLAUDE.md), and correctness is
judged independently of the pipeline's own verifiers (finding 7). The phases are ordered
by measured waste: wrong keys first, then repetition, then difficulty.

### Phase 0: measurement (no generation spend, 1–2 days)
1. **Drop-reason baseline in `gen:baseline`.** Report `solver-disagree` vs `duplicate` vs `guard-*` per tier as the denominator every later phase moves. Today's split (26/14/0) comes from hand-grepped logs.
2. **Diversity metric.** Add a Vendi score (effective number of distinct items over the shingle similarity kernel) to `eval:repetition`, next to types-per-problem.
3. **Difficulty ground truth.** Check E2H-AMC coverage and license for our 2010+ AMC/AIME rows. If usable, write a script that joins its IRT difficulty onto `ReferenceProblem` as a new nullable column. That's an additive migration: code first, then the column.
4. **Zero-generation judge test** (`eval:difficulty --pairwise`):
   - Take held-out *real* AMC 10 problems from #6–10 and #11–15.
   - Compare each against about 8 anchors at known positions, in both orders.
   - Fit Bradley–Terry scores.
   - Run it with Gemini Flash and with Opus as judge.
   - **Gate:** if neither separates the two bands on real problems (for example AUC ≥ 0.75), stop, and treat difficulty between #6 and #15 as uncontrollable for now, as the memory note already says. Nothing downstream gets built on a judge that fails this.

### Phase 1: code-computed answer keys (the biggest lever)
1. **Output field.** Extend the construct writer's tool output with `answerProgram`: a restricted expression or program that computes the answer from the problem's givens. The prompt change is committed as `prompt: …`.
2. **Execution. Decision needed:**
   - **(a) An expression-only evaluator in-process (mathjs/nerdamer with a locked scope).** No loops, safe, works on Vercel Node. Covers arithmetic, algebra, number theory closed forms, and most F=ma numerics.
   - **(b) A sandbox (Pyodide in a worker, or an external microVM sandbox).** Runs brute-force enumeration for combinatorics and number theory, which is where contest keys most often go wrong.
   - **Recommendation:** start with (a). Measure how many candidates it can't express, then decide on (b) from that number.
   - Never `eval` model-written JS.
3. **New guard, `guard-program`.** Program result ≠ answer field → reject before any solver runs. A program that can't be evaluated → abstain and fall through to today's solvers unchanged.
4. **Reorder gates, cheapest first:**
   - deterministic guards
   - program
   - validity
   - cheap cross-family solvers
   - Opus only where the policy requires it
5. **Recount the spare buffer.** Recompute `SPARES` from the new rejection rate instead of keeping 20.
6. **Eval:**
   - `solver-disagree` rejections per set, and $/set, should both fall.
   - Correctness is judged against corpus answers and by hand, not by our solvers.
   - Track `guard-program` false rejections: a correct problem whose program was wrong.

### Phase 2: offline skill taxonomy and code-sampled slots
1. **`scripts/extract-taxonomy.ts` (one-off, cheap model).** For each answered corpus problem, record `{skills[], method}` into a sidecar table or JSON. Then build a per-contest, per-band skill co-occurrence matrix.
2. **Sample slots in code.** Replace the two per-request type-menu calls with a code sampler:
   - Draw each slot's skill tuple from the matrix.
   - Exclude tuples from the student's last 3 sets (already loaded by `recentProblemStatements`).
   - Seed it with `hash(sessionId, attemptId)`, the same scheme `targets.ts` uses, so reruns are reproducible.
   - Keep the LLM menu as the fallback for non-contest subjects, and add Verbalized Sampling to it (ask for types with probabilities, sample from the tail). This is another `prompt:` change.
3. **Method-level dedup.**
   - Each candidate emits a short `method` string.
   - Dedup compares method tokens within the set and against history.
   - Only pairs in the ambiguous band go to one cheap "same method?" call.
   - Leave `nearCopyOf` in place for literal copies.
4. **Eval (`eval:repetition --compare`):**
   - Types per problem, Vendi score, within-set and cross-session repeats.
   - `duplicate` rejections should fall toward the 5–10% the literature sees.
   - p95 latency should drop, since two serial calls are gone.

### Phase 3: difficulty (only if phase 0's judge passed)
1. **Two-skill composition for the upper half of a band.** Slots targeting the top of the band get a *pair* from the matrix, restricted to pairs that co-occur in real problems at that position. Slots at the bottom of the band get one skill.
2. **Pairwise placement as a selector, not a hard filter at first.** Score each kept candidate against about 8 anchors, running the calls in parallel on Flash (see Cost at the end). From the surplus, choose the 10 closest to their slot targets. It's recorded in `genMeta` as `difficulty`.
3. **Eval:** placement against human difficulty (E2H-AMC if joined), the user's own `--rate`, and the `--expect-band` gate.

### Phase 4: validity
1. **Split `buildValidityPrompt` into the staged form:** conditions → contradictions → goal. One call with a structured output per stage, not three calls.
2. **Solver veto.** Add a `wellPosed`/`assumption` field to every blind solver's tool schema. Any solver flagging the problem vetoes the candidate (`invalid-solver-flag`).
3. **Eval:** hand-label about 50 rejected and 50 kept items to get the veto's precision and recall.

### Phase 5: hard tier
1. **Mechanical inversion (ReverseMath, [2605.27709](https://arxiv.org/abs/2605.27709) [V]).** Mask a given of a real AIME problem and make the old answer a given. The new key is known without solving, as long as the source key is right, and our AIME keys are verified. Use it as an extra candidate source next to transposition, not a replacement.
2. **Memorization check.** Reject a reversed problem whose solver returns the *original* answer, which signals the model recognised the source.
3. **Weight solver votes** by each solver's measured accuracy on the corpus (Weaver), rather than one vote each. Don't count Opus-vs-Opus escalation as independent votes.

### Decisions for the user
- **Phase 1 execution:** expression evaluator only, or a sandbox for enumeration?
- **CLAUDE.md scope:** "Any ML beyond the single generation call" is already stretched. The pairwise judge (phase 3) and the taxonomy script add more model use. Record them as part of the requested redesign, or drop phase 3.
- **Batch pre-generation at booking time** would halve cost, but it's close to the "no cached results / problem bank" non-goal. Not in this plan unless you want it.

### Cost and risk at a glance
| Phase | Adds per set | Removes per set | Main risk |
|---|---|---|---|
| 1 | ~0 model calls | most wrong-key solver calls (~26 per 7 sets); fewer spares | a correct problem rejected because its program was wrong |
| 2 | 0–2 cheap judge calls | 2 serial type-menu calls | the taxonomy is too coarse or too fine |
| 3 | ~80 Flash judge calls (~$0.05) | — | a judge that can't separate bands (phase 0 gates this) |
| 4 | 0 (fields on existing calls) | wrong-but-agreed items | veto too eager, so more spares |
| 5 | 0 on inverted items | Opus re-solves on inverted items | the source problem is memorized |

## Implementation results (2026-09-23)

Built in the `generation-cascade` worktree, uncommitted. 498 tests, typecheck, lint and
`npm run build` pass. **Both Anthropic and Gemini ran out of API credit mid-session**, so
the live evals below ran on open-weight models (GLM-5.3 writing, DeepSeek/GLM checking).
Every Opus-writer number is still owed. Samples are small; read them as direction, not proof.

### Phase 0: measurement
- `gen:baseline` reports cascade rejections by reason over every run. `eval:repetition` reports effective types (per set and pooled) and a statement Vendi score.
- **Human difficulty joined:** `data/corpus-difficulty.json` (`npm run join:e2h`, read-only) holds E2H-AMC IRT ratings for 670 of 889 AMC/AIME corpus problems.
  - Problem number vs human rating: Spearman 0.86–0.90.
  - **Real AMC 10 #6–10 vs #11–15 separate at only AUC 0.74.** Medians by position: #10–12 = 0.237, #13–15 = 0.239. Much of "can't tell #6–10 from #11–15" is the contest itself.
- **Judge validation** (`eval:difficulty-judge`, real held-out AMC 10, ladder mode):

  | Judge | Spearman vs human | Problem number on the same items | AUC #6–10 vs #11–15 |
  |---|---|---|---|
  | Gemini Flash (n=89) | **0.76** | 0.63 | — |
  | Gemini Flash (n=30) | 0.83 | 0.80 | 0.81 (human ratings: 0.81) |
  | GLM-5.3 (n=82) | 0.64 | 0.63 | 0.78 |
  | Opus pairwise | 0.71 | — | — |

  - Opus pairwise cost $4.29, with no gain over Gemini.
  - DeepSeek failed as a judge.
  - Pairwise mode is rate-limited at scale, so ladder mode is the design.
  - AIME (n=60): Gemini 0.71 vs number 0.86.
  - **Gate passed.**

### Phase 1: code-computed keys
- **Sandbox** (`answer-check.ts`, mathjs):
  - Allowlisted functions only; no strings, property access or recursion.
  - Shared range-element budget of 1M and a 250ms wall clock.
  - Rewrites `x -> e` lambdas and `//` comments into mathjs.
- **Writer-side programs work for Opus** (20/20 matched, 0 backtracking) and **not for cheap writers**. Gemini asked for one leaked "wait, …" corrections into 14/19 solutions, against 5/17 without. So only Anthropic thinking writers write their own program.
- **Blind program solver** (`program-solver.ts`) on 80 real AMC #1–15 problems:

  | Model | Computed a value | Wrong among those |
  |---|---|---|
  | Gemini Flash (low) | 74/80 | 2 (3%) |
  | DeepSeek (low) | 72/80 | 2 (3%) |
  | DeepSeek (thinking off) | — | 43% (unusable) |

  - It runs beside the text solvers, and a disagreement is a veto (`guard-program`).
  - Live, it vetoed 3 of 23 candidates. Hand check: 1 false veto (a program dropped an extraneous root), 1 defensibly ambiguous problem, 1 unauditable. The log now keeps the full statement and program.
- **Gate order:** a duplicate is now caught before paid verification. Billing and auth errors (400 credit, 401, 402, 403) now trip the breaker, so the tutor sees "service unavailable", not "broaden the profile".
- **All-open-weight easy tier** (GLM writer): 4/4 complete sets, **$0.04–0.08 per set** (Opus: $0.27–0.47).

### Phase 2: diversity and duplicates
- **Taxonomy:** 1,188 corpus problems labeled and clustered into **214 canonical types** (`npm run extract:taxonomy`, $0.18).
  - Contest slots come from one selection call plus code sampling, excluding recent type ids exactly.
  - A narrow topic tops up from the Verbalized Sampling type menu. "Linear and quadratic equations" fits only 12–15 catalog types.
- **Method-level dedup:** a lexical prefilter, then a cheap "same practice?" judge, against the set and recent sets' stored methods.
- **Result** (3 sessions per arm, GLM writer, one grouping call):

  | | Baseline | New |
  |---|---|---|
  | Distinct types in 30 problems | 17 | **20** |
  | Repeats within a set | 2.0 | **1.7** |
  | Repeats across a pair of sets | 3.0 | **2.0** |
  | Effective types pooled over sets | 12.5 | **17.7** |

  The top-up landed after this run.

### Phase 3: difficulty
- **Judge wiring:** each objective gets a target rating (the median E2H rating at its position). The judge's placement is recorded per kept item, and `CASCADE_DIFFICULTY_TOLERANCE` turns it into a filter.
- **Result** (GLM writer and GLM judge, 3 sets each):

  | | Compose off | Compose on |
  |---|---|---|
  | Judged difficulty, lower half | 0.18 | 0.19 |
  | Judged difficulty, upper half | 0.18 | **0.21** |
  | Mean gap to target (≈0.236) | −0.057 | −0.036 |

  - Without composition, the upper half is no harder than the lower half.
  - Composition raised the upper half by about 0.03, but composed candidates hit more rung timeouts.
  - `CASCADE_COMPOSE` stays off until an Opus run. Opus already plays near the band.

### Phase 4: validity (40 real problems, 36 cheaply broken variants)

| Check | False flags on real | Broken variants caught |
|---|---|---|
| Old validity prompt | 1/40 | 7/36 |
| Staged prompt alone | 0/40 | 7/36 |
| Assumption veto alone | 0/40 | 11/36 |
| **Staged prompt or veto** | **0/40** | **13/36** |

The gain is the assumption veto, which matches the research: solvers notice flaws they wouldn't otherwise report.

### Phase 5: hard tier
- **Reverse candidates:** code checks that the key is a given of the seed. AIME answers are often encodings, so the new problem need not restate the seed's answer; the cheap solvers check that the facts pin down the key.
  - Raw samples: after the checker fix, all 6 keys traced back to the seed.
  - Live: GLM is too slow at AIME reversals to finish a set inside 285s.
  - `CASCADE_REVERSE_SHARE` stays 0 until an Opus run.
- **The blind program solver now also vetoes seed variants** next to the Opus votes.
- **Weighting votes by accuracy (Weaver) was not built:** under "any disagreement replaces", weights change nothing.

### Seeded slots (difficulty from real problems)
Cheap writers can't be prompted into a harder problem: only 3 of 28 kept GLM problems
reached their slot's target. So contest scratch slots are now variants of **real** corpus
problems (`seed-slots.ts`, `CASCADE_SEED_SLOTS`, default on):
- **Which real problems:** those at the slot's target position, or in the same contest with a human rating inside the targets' window.
  - Each must be answered, of a taxonomy type that fits today's topic, and not used by a recent set (`items[].seedId`).
  - A set takes at most one per type.
- **Prompt:** the construct writer sees the real problem, its answer and its solution. It keeps the idea and the step count, and changes the story, the numbers and a structural parameter.
- **Checks:** the same cheap checks as scratch problems, never Opus.

Run on GLM writer, GLM judge, AMC 10 #10–15, "linear and quadratic equations", composition off:

| Run | Sets complete | Seeded slots | Seeded items at target | Scratch items at target | All items at target | Mean judged |
|---|---|---|---|---|---|---|
| Seeding off | 5/5 | — | — | 7/50 | 7/50 (14%) | 0.188 |
| Exact positions only | 6/6 | 0–4 kept | **6/11** (0.217) | 6/48 (0.193) | 12/59 | 0.197 |
| + AMC 12 by rating | 4/6 | 30 kept | 8/30 (0.199) | 4/28 | 12/58 | 0.198 |
| **+ same-contest rating window (shipped)** | **6/6** | 27 kept | **13/27 (0.219)** | 3/33 (0.195) | **16/60 (27%)** | **0.206** |

- **AMC 12 seeds are excluded.** AMC 12 #2–7 problems are rated like AMC 10 #10–15, but their variants were judged 0.191 against the seeds' 0.241. AMC 10 seeds kept 0.213 of 0.233.
- **Cost and time:** $0.07–0.12 per set, 71–129s.
- **Limits:**
  - About half the slots still end up scratch, because only 5–9 real problems fit a narrow topic.
  - The judge is GLM (Spearman 0.64).
  - These are single-fixture runs.
  - The seeded items' true difficulty still needs your `--rate` pass.

### GLM judge vs human ratings, whole range (real problems)
`eval:difficulty-judge --range` (ladder mode, GLM-5.3, 8 anchors spread over each contest, $0.29 total):

| Contest | Spearman judge vs human | Spearman number vs human | Judge bias by band |
|---|---|---|---|
| AMC 10 (#1–25, n=81) | 0.78 | 0.83 | +0.013 at #1–5 → −0.020 at #21–25 |
| AMC 12 (#1–25, n=75) | 0.75 | 0.88 | +0.015 at #1–5 → −0.016 to −0.021 at #11–25 |
| AIME (#1–15, n=65) | 0.63 | 0.89 | +0.028 at #1–3 → −0.035 at #13–15 |

- **Pattern:** the judge compresses toward the middle. It overrates easy problems and underrates hard ones by up to about 0.02 (AMC) or 0.035 (AIME).
- **Consequence:** judge placements must be compared with the judge's own placements of real problems at the same position, never with the human target.
- **Problem number beats the judge on real problems.** The judge exists for generated problems, which have no number.

### Judge targets on the judge's own scale (applied)
- **Calibration:** `data/judge-calibration.json` (`npm run fit:judge-calibration`) fits, per judge and contest, `judged ≈ slope × human + intercept` from its placements of real problems.
  - GLM-5.3 AMC 10: 0.592 × human + 0.083 (n=163), so the human target 0.236 becomes 0.223.
- **Production:** slot targets and `CASCADE_DIFFICULTY_TOLERANCE` now use the judge's scale. A judge with no fit falls back to the human scale, with a warning and `cascade.judgeScale: "human"`.
- **Anchors:** production now uses the calibration's anchors, spread over the whole contest (`judgeAnchorIds`). The old window of target ±6 positions made the fit inapplicable.
- **Rerun** (`runs/seed-cal.jsonl`, GLM writer and judge, 6 sets):

| Items | n | Judged | Target (judge scale) | Gap | At or within 0.015 of target |
|---|---|---|---|---|---|
| Seeded | 24 | 0.220 | 0.222 | **−0.002** | 17/24 |
| Scratch | 29 | 0.196 | 0.223 | −0.027 | 11/29 |

  - 2 of 6 sets ran out of time on GLM writer timeouts (9 rung timeouts, against 0 in the run before). That's the host, not this change: the judge rejects nothing without a tolerance.

### Easy tier, 10 topics, GLM only (`runs/easy-10topics.jsonl`)
One set per topic, AMC 10 #10–15, all at once; $0.73 total, $0.06–0.08 per set, 151–228s per set.
- **Only 2 of 10 sets completed.** The 8 failures kept 5–9 problems each, every one "not enough time left".
- **Difficulty** (judge's scale, target 0.222):
  - Seeded problems: 0.216 (gap −0.006), 22/35 at or within 0.015 of target.
  - Scratch problems: 0.197 (gap −0.025), 15/40.
- **Seeded slots depend on the topic:** 10/10 for counting, probability, divisibility and digits; 2–5/10 for functions, triangles, circles and rates.
- **Correctness:** every kept problem was verified.
  - The program solver agreed 90 times and vetoed 5.
  - Rejections: 19 solver disagreements, 5 program vetoes, 2 answer–solution contradictions, 2 ambiguous, 1 ill-posed, 1 backtracking, 1 duplicate.
- **Why sets fail:**
  - 37 of 182 GLM writes (20%) hit the 90s write deadline, and another 17% were rejected.
  - A replacement may start only while a 90s write plus 40s of verification still fits in 285s, so only up to about 155s.
  - First-wave results arrive at 60–90s. A slot whose replacement also fails can't be retried, and a one-rung ladder can't escalate.
  - Rerunning the two worst topics with only two sets running still failed (9/10 and 6/10, 6 timeouts), so this isn't only eval load.

### Easy tier, 10 topics, DeepSeek writer (`runs/easy-10topics-ds.jsonl`)
DeepSeek V4.1 Flash writing with thinking off (the easy-tier default). GLM judges, and GLM is the program solver because Gemini is still out of credit (402).
- **3 of 10 sets completed.** $0.06–0.10 per set, 63–173s. 298 candidates, against GLM's 182.
- **Failures:** 6 of the 7 ran out of candidates ("no distinct candidates left"), not time. Unlike GLM, DeepSeek is fast.
- **Rejections:**
  - 72 answer fields that contradict their own solution.
  - 46 program vetoes.
  - 35 solver disagreements.
  - 24 ill-posed.
  - 11 backtracking.
- **Difficulty:**
  - Seeded problems: 0.231, above the 0.221 target, but only 10 were kept. Seeded variants mostly failed the checks.
  - Scratch problems: 0.199 (gap −0.024).
- **GLM as program solver** (`eval:program-solver`, 80 real AMC #1–15): computed 43/80, **21% of those wrong**, and 24 timeouts. It's unusable as a veto, so some of the 46 vetoes threw out correct problems. The DeepSeek-writer arm needs Gemini's program solver (3% wrong) for a fair run.

### Seeds-only sets, 600s budget (`runs/seedonly-glm.jsonl`, `runs/seedonly-ds.jsonl`)
Every candidate, spares included, is a variant of a real problem (`CASCADE_SEED_ONLY=on`), topped up from other topics when too few fit. Settings: `CASCADE_BUDGET_SECONDS=600`, `CASCADE_MAX_CALLS=80`, 5 topics, one arm at a time. (Running both arms at once hit DeepInfra 429s and 60 GLM timeouts; see the `*-contended` files.)

| Writer | Sets complete | $ total | Candidates | Judged / target (judge scale) | At or within 0.015 | Main rejections |
|---|---|---|---|---|---|---|
| GLM-5.3 | 1/5 (the rest 8–9/10) | $0.40 | 115 | 0.219 / 0.222 | 23/39 | 45 write timeouts (39%) |
| DeepSeek V4.1 Flash | 1/5 (the rest 2–9/10) | $0.26 | 128 | 0.232 / 0.221 | 13/17 | 35 answer–solution contradictions, 14 solver disagreements, 11 program vetoes |

- **Difficulty:** seeds-only difficulty is on target for both writers.
- **The longer budget didn't fix completion:**
  - GLM still loses 39% of writes to the 90s per-write deadline, which the overall budget doesn't change. Its failed sets ran to 478–550s.
  - DeepSeek runs out of its 30 real-problem candidates first.

### Specific topics, GLM, one set at a time (`runs/specific-glm.jsonl`): during a GLM outage
10 narrow topics (such as "Vieta's formulas", "inscribed angles and chords"), default settings, now with per-candidate timings (`cascade.timings`).
- **1 of 10 sets completed.** 100 of 150 GLM writes hit the 90s deadline.
- **After the run,** a one-line GLM request got no response in 120s, twice. DeepSeek on the same host answered in 0.3s. The run measured a host outage, not the pipeline; rerun when GLM responds.
- **Candidates that passed** took a median 49s to write and 40s to check (the check median sits at the 40s solver timeout, because GLM is also a solver and the judge).
- **Recent-year targets and rating-only seeds** (2015+, ±1 pooled; seeds rated at least the lowest target) left only 2–8 fitting real problems per topic on these narrow topics.

### Specific topics, GLM, longer limits (`runs/specific-glm-long.jsonl`)
Same 10 topics with GLM healthy. Settings: `CASCADE_TOP_TIMEOUT_EASY=150`, `CASCADE_BUDGET_SECONDS=600`, `CASCADE_MAX_CALLS=80`, one set at a time.
- **8 of 10 sets completed.** Arrangements kept 6/10 (ran out of candidates); similar triangles kept 9/10 (out of time).
- **Cost and time:** $0.04–0.15 per set ($0.83 total), 242–531s per set.
- **Per candidate** (194 total; 95 passed, 55 timed out at 150s, 44 rejected):
  - Passing writes took a median 48s, p90 119s, max 149s. **19 of the 95 took over 90s**, so the production 90s deadline cuts off good problems.
  - Checks took a median 21s, p90 40s.
- **Difficulty** (judge scale, 2015+ targets):
  - Seeded problems: 0.248 against 0.229, all 11 at or above.
  - Scratch problems: 0.204 against 0.227 (gap −0.023), 25/69 at or within 0.015.
- **Why most slots are scratch:** narrow topics leave only 0–4 kept seeded slots per set.
- **Timing fits the budget:** a 150s write plus about 40s of checks fits a single-attempt budget, but a replacement after a 150s timeout does not. Sets need 5–9 minutes, well over the route's 300s.

### Why GLM writes time out, and the fix
- **Root cause:** DeepInfra's GLM-5.3 sends some requests down a slow path.
  - Their first byte arrives at about 15s, and the first token 25–70s in, or never.
  - Streamed probes of real write prompts: 16 of 48 calls, and 2 never started in 240s.
  - It doesn't depend on the prompt or on how many calls run at once. At 8 calls, 7 were slow; at 24 calls, 6 were.
  - Healthy calls produce a token within about 1s and finished within 32s.
- **Why it cost so much:** the writer didn't stream, so it couldn't tell a stuck request from a slow one and waited out the whole deadline. That's the 55 of 194 timeouts at 150s, and the long 60–150s tail of writes that finished.
- **Fix** (`writers.ts`): open-weight writes stream. A request with no token after `CASCADE_FIRST_TOKEN_SECONDS` (default 10) is cancelled and resent, until the write deadline. A reply that isn't streamed is read as before.
- **Live check:** 24 real prompts at once went 24/24, median 10s, max 48s, with 1 resend (the host was healthier then than during the probes).
- **Full run with the fix** (`runs/broad-glm.jsonl`): 10 broad topics (polynomials, logarithms, conditional and geometric probability, combinatorics, diophantine equations, modular arithmetic, sequences, triangles, circles) under production limits (90s write, 285s set), one set at a time.
  - **10/10 sets complete,** in 74–203s, at $0.09–0.13 per set ($1.01 total).
  - **Stalls handled:** 11 stuck requests resent; 1 write hit 90s, against 55 of 194 at 150s before.
  - **Passing writes:** median 8s, p90 28s, max 79s.
  - **Difficulty** (judge scale):
    - Seeded problems: 0.240 against 0.228, 35/41 at or within 0.015.
    - Scratch problems: 0.200 against 0.227, 20/59.
  - **Coverage:** broad topics seeded 10/10 slots for combinatorics, modular arithmetic and triangles, and 0–4 elsewhere.

### Corpus expanded from Easy2Hard-Bench (2026-09-24)
- **Import** (`npm run ingest:e2h`, production database): 2,523 E2H-AMC problems from 2010 on, with statement, answer and worked solution. E2H's 3,975 rows are cached in `runs/e2h-amc.json`; 782 pre-2010 rows were not imported.
  - Corpus: AMC 8 265, AMC 10 643 (was 323), AMC 12 415 (was 190), AIME 407 (was 376), HMMT Nov 720, HMMT Feb 962, F=ma 299.
  - E2H gives 2021's spring and fall AMC the same label. The first write collided 28 twins; ids now hash the statement for shared labels, and those rows were replaced.
- **Ratings:** `npm run join:e2h` now rates 3,192 problems (was 670); the 670 existing ratings are unchanged. For HMMT, problem number barely tracks rating (Spearman 0.47–0.58), since it numbers within rounds.
- **Types:** `extract-taxonomy --assign-new` labeled the new rows and assigned 2,496 of 2,523 to the existing 214 types ($0.66). Type ids and all prior assignments are unchanged.
- **HMMT for AIME** (`SEED_SOURCES`, user decision, not measured): AIME students also draw seeds from HMMT problems rated in their band whose answer is an integer (any integer; the variant writer picks its own answer). That adds 148 at AIME #1–9 and 106 at #10–15, in both the mid-tier seeded slots and the hard-tier variant pool. AMC stays own-contest (AMC 12 → AMC 10 borrowing made variants too easy).
- **Typed, rated seeds per band now:**

  | Band | Seeds | Distinct types |
  |---|---|---|
  | AMC 10 #10–15 | 239 | 104 |
  | AMC 10 #16–25 | 208 | 90 |
  | AMC 12 #16–25 | 167 | 85 |
  | AIME #1–9 | 414 | 122 |
  | AIME #10–15 | 263 | 104 |

  The AIME counts are before the answer-format filter.

### Mid-tier write timeouts: runaway thinking (`runs/probe-mid.json`)
- **Probe:** 16 real AIME #1–9 write prompts streamed to GLM-5.3 at the mid tier's settings (thinking high, max_tokens 12,000), capped at 240s:
  - 11 normal: 1.3k–5.6k tokens, 17–97s.
  - **3 thought through the whole 12,000-token cap and wrote nothing** (138–171s, finish=length).
  - 1 finished at 128s with 8.4k tokens.
  - 1 was stuck at the host (first token at 236s).
- **Throughput:** GLM runs at about 70–85 tokens/s, so a runaway always hits the 120s write limit before the token cap. That is the spike at 120s (17% of mid-tier writes).
- **Stall watchdog:** some requests started at 12s or 40s, so the 10s watchdog is borderline for mid tier.
- **Options:**
  - lower mid `maxTokens` (about 7,000) so runaways end near 90s;
  - thinking medium or low for mid (needs a quality eval);
  - stop a write after N seconds of thinking with no output and replace its spec.

### Mid-tier options, researched (2026-09-24)
The same 16 AIME #1–9 write prompts (combinatorics, seeded) were run through the real checks per setting. Set completion was then estimated by replaying those attempts through the pipeline's timing rules (285s budget; a replacement starts only while a write plus 40s of checks fits). Checked against reality, the replay predicts easy 99.9% (actual 10/10) and mid 4% (actual 1/10).
- **Host-side thinking budget:** `thinking_token_budget` and `reasoning.max_tokens` are both ignored by DeepInfra for GLM-5.3 (6k–12k thinking tokens with a 3k budget). Runaways repeat on the same prompts.
- **Thinking level:**

  | Level | Passed | Median write | Median tokens | Judged vs target |
  |---|---|---|---|---|
  | high | 9/16 | 40s | 4.5k | 0.561 vs 0.551 (n=9) |
  | medium | 10/16 | 18s | 1.7k | 0.536 vs 0.549 (n=7) |

  - Medium still ran away on the same 2 prompts (cut off at 200s).
  - low: not measured; DeepInfra ran out of credit (HTTP 402) mid-probe.
- **Predicted set completion:**
  - high today: 22%.
  - Token cap alone: 18–34%.
  - **Race 2 per slot: 83–88%. Race 3: 97–98%.**
  - Budget 600s: 97%, but 266s mean.
  - Medium + cap + race 2: 86–89%.
  - On a host 1.6x slower (as in the real mid runs): race 2 26%, race 3 62%.
- **Chosen:**
  - mid keeps high thinking (medium judged easier) and races 3 candidates per slot (`FIRST_WAVE_DEFAULTS`);
  - mid maxTokens 10k (was 12k);
  - open-weight concurrency 32 (was 8), so the 30-candidate first wave doesn't queue.
  - Easy stays at 1. A 600s route budget is a product call (the tutor waits), not taken.
- **Cost:** about 42 writes per set against 9, cancelled siblings included; at GLM prices about $0.3–0.4 per set, similar to one Opus set.

### Still owed (needs Anthropic/Gemini credit)
1. Phase 1 A/B with the Opus writer: wrong-key rejections and $/set.
2. `eval:repetition --compare` with Opus.
3. Judge placements of Opus sets; a decision on `CASCADE_COMPOSE` and a tolerance.
4. Hard tier with `CASCADE_REVERSE_SHARE=0.3` vs 0.
5. Recompute `SPARES` (still 20) from those runs.
