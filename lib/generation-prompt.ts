// The problem-generation prompt. This file is the product — keep ALL prompt
// logic here, nowhere else. Iterate it via commits: `prompt: <what changed>`.

import type { Anchor } from "@/lib/types";
import { BAND_THRESHOLDS } from "@/lib/calibration";

// Kept as a name alias for callers that imported the prompt-local anchor type.
export type GenerationAnchor = Anchor;

export type GenerationInput = {
  level: string;
  topic: string;
  count: number;
  recentTopics: string[]; // last N session topics, most recent first
  book?: { title: string; contents: string }; // assigned book for this session, if any
  competition?: string; // "AMC10" | "AMC12" | "AIME" | "Fma" — selects the difficulty rubric
  bandLow?: number | null; // target problem-number band (difficulty floor/ceiling)
  bandHigh?: number | null;
  anchors?: GenerationAnchor[]; // real same-difficulty problems retrieved from the corpus
  // "variant" = transform corpus seeds into isomorphic new problems (hard AIME tier only).
  // "scratch" = generate fresh problems using anchors as calibration context (easy and mid tiers).
  mode?: "variant" | "scratch";
  // Adapt path: when true (and mode is "variant" with seeds that carry real
  // solutions), inject each seed's worked solution and ask the model to TRANSFORM it
  // — emitting a terse solutionSketch instead of re-deriving a full solution from
  // scratch. The cheap expansion stage turns the sketch into the student-facing
  // solution. When false, the variant block falls back to statement-only re-solve.
  adapt?: boolean;
  // Variant statements rejected on a prior attempt for being too close to a seed.
  // Fed back so the deficit retry diverges instead of re-echoing the same seed.
  avoidStatements?: string[];
};

// Per-competition difficulty rubric. The structure + number-band semantics are the
// concrete anchor the model calibrates against (alongside the retrieved anchors).
const RUBRICS: Record<string, string> = {
  AIME: `AIME calibration: 15 fill-in problems, integer answers 0–999, strictly increasing difficulty. #1–5 are routine one-idea problems; #6–10 need a clever idea; #11–15 demand multiple non-obvious insights and careful casework (a strong solver spends 15–25+ min). A problem in the target band must NOT be solvable by a single standard technique if the band is 10–15.`,
  AMC10: `AMC 10 calibration: a 25-problem contest whose difficulty ramps with problem number. #1–10 quick; #11–17 need a solid idea; #18–25 require two or more insights or careful work under time pressure. Match the target number band — a #22 is not a warm-up. Present every problem as FREE-RESPONSE — do NOT include the A–E answer choices; ask for the actual value.`,
  AMC12: `AMC 12 calibration: a 25-problem contest, harder and more advanced than AMC 10 at the same number (more algebra/precalc, trickier). #1–10 quick; #11–17 a solid idea; #18–25 multi-insight. Match the target number band. Present every problem as FREE-RESPONSE — do NOT include the A–E answer choices; ask for the actual value.`,
  Fma: `F=ma calibration (AAPT): 25 multiple-choice mechanics problems (answers A–E), 75 minutes. Topics: kinematics, Newton's laws, energy, momentum, rotation, oscillations, gravitation. Later problems are harder (multi-step, less obvious setup); no calculus beyond basics. Exactly one correct option of five.`,
};

// AMC/F=ma corpus statements carry the original "(A) … (E)" option list. We generate
// free-response, so strip that list before injecting an anchor — otherwise the model
// is shown multiple-choice formatting to mimic. Conservative: only cut when a full
// span from (A) (or \textbf{(A)}) through (E) is present; otherwise leave untouched.
function stripChoices(statement: string): string {
  const m = statement.match(/(?:\$?\s*\\textbf\s*\{\s*)?\(\s*A\s*\)[\s\S]*\(\s*E\s*\)/i);
  // Drop a dangling math delimiter left over from a "$\textbf{(A)} …" choice block.
  return m && m.index != null ? statement.slice(0, m.index).replace(/\$\s*$/, "").trim() : statement;
}

// Difficulty register inferred from the band CEILING — drives whether the prompt
// pushes the set to the hard end of the contest (core/hard bands) or holds it to
// genuinely routine, quick problems (low bands like AMC #1–10 / AIME #1–5). The
// thresholds mirror the rubric ramps in RUBRICS ("#1–10 quick", "#18–25
// multi-insight"; AIME "#1–5 routine"). No competition or no band → routine.
function bandRegister(
  competition: string | undefined,
  bandHigh: number | null | undefined
): "routine" | "core" | "hard" {
  if (!competition || bandHigh == null) return "routine";
  const { routineMax, hardMin } =
    competition === "AIME" ? BAND_THRESHOLDS.register.AIME : BAND_THRESHOLDS.register.default;
  return bandHigh <= routineMax ? "routine" : bandHigh >= hardMin ? "hard" : "core";
}

export function buildPrompt(input: GenerationInput): { system: string; user: string } {
  const { level, topic, count, recentTopics, book, competition, bandLow, bandHigh, anchors, mode = "scratch", avoidStatements } =
    input;
  // Adapt only applies on the variant path AND only when the seeds actually carry
  // solutions to transform (AIME/AMC do; F=ma seeds are null → statement-only re-solve).
  const adapt = !!input.adapt && mode === "variant" && !!anchors?.some((a) => a.solution);
  // Staged transpose path: the seeds carry a pre-distilled step-by-step SKETCH (Stage A).
  // When present, the adapt block hands the model that numbered skeleton to TRANSPOSE
  // rather than the raw prose solution to re-read — narrowing the task so the heavy
  // re-derivation (and its runaway thinking/truncations) doesn't fire. Falls back to the
  // prose-solution framing when sketches are absent (Stage A skipped or failed).
  const staged = adapt && !!anchors?.some((a) => a.sketch);
  // Routine bands (early contest problems) get easy, match-the-band framing; core
  // and hard bands keep the "push to the hard end" language unchanged.
  const routine = bandRegister(competition, bandHigh) === "routine";

  const historyBlock =
    recentTopics.length > 0
      ? `Recent session topics (most recent first — do NOT repeat these, build on them):\n${recentTopics
          .map((t, i) => `${i + 1}. ${t}`)
          .join("\n")}`
      : "No prior session history — this is the student's first session.";

  const bookBlock =
    book && book.contents.trim()
      ? `\nAssigned book: ${book.title}. The session's topic (given below) names chapters from this book. Use the chapter contents here to determine exactly what those chapters cover, and generate problems on those topics.\n\nBook contents:\n${book.contents}\n`
      : book
        ? `\nAssigned book: ${book.title}. The session's topic (given below) may name chapters from it — generate problems matching those chapters.\n`
        : "";

  const rubric = competition && RUBRICS[competition] ? `\n${RUBRICS[competition]}\n` : "";

  const bandBlock =
    competition && bandLow != null && bandHigh != null
      ? routine
        ? `\nTarget difficulty band: ${competition} problems ${bandLow}–${bandHigh}. These are the EARLY, ROUTINE problems of the contest — each a quick, single-main-idea problem that a solver at this level finishes in a couple of minutes. Match that difficulty EXACTLY: do NOT inflate them, do NOT add artificial complexity, multi-step casework, or above-band machinery. Order easiest→hardest within the band, but even the hardest stays a #${bandHigh}-level problem (still routine — not a back-of-contest stumper). Keep solutions short (1–3 lines). Every problem is free-response with the standard answer format.\n`
        : `\nTarget difficulty band: ${competition} problems ${bandLow}–${bandHigh}. The band is a FLOOR, not a target average — do NOT include any problem easier than #${bandLow}, and the set as a whole must sit at the HARD END of this band. Order easiest→hardest, but the easiest problem is already a #${bandLow}-difficulty problem and the set climbs to genuinely #${bandHigh}-hard. The final problems must be as hard as the TOUGHEST real ${competition} problems at #${bandHigh} — the kind a strong student cannot finish without help. Make that difficulty come from deeper, multi-step reasoning and synthesis of in-level ideas, NEVER from terminology or techniques above the ${competition} level: every problem stays free-response with the same answer format, fully solvable and fully solved using only the in-level toolkit. No openers below the band.\n`
      : "";

  // Anchors framing differs by mode:
  // "scratch" — anchors are calibration CONTEXT; do not copy them, just match difficulty.
  // "variant" — anchors are SEEDS to transform into isomorphic new problems.
  const anchorBlock =
    anchors && anchors.length > 0
      ? mode === "variant"
        ? staged
          ? `\nEach of the following is a real AIME problem, given WITH a STEP-BY-STEP SKETCH of its real solution and its answer. Your job is to TRANSPOSE, not to re-derive — the sketch already hands you the method. For each seed:\n- Produce an ISOMORPHIC VARIANT: perturb a STRUCTURAL PARAMETER — a modulus, a dimension, the number of constraints or cases, or the bound — so the computation genuinely differs and the answer changes, and RE-DRESS the surface completely. A variant that keeps the seed's sentence structure, nouns, and phrasing and merely swaps in new numbers WILL BE REJECTED and wasted: move to a different surface domain (a different object, configuration, or story), rename every variable and label, and write the statement in your own words.\n- TRANSPOSE the given sketch onto your variant step by step: keep each numbered step's role identical, substitute the perturbed parameter, and re-run ONLY the arithmetic of the steps the change actually touches. Carry every unaffected step forward with its structure intact. Do NOT search for a new method — use the one the sketch gives you.\n- Reserve fresh reasoning ONLY for a step the perturbation genuinely breaks (e.g. it forces a case the seed's sketch didn't have). Otherwise the transposition is mechanical — do not over-think it.\n- Recompute the variant's real integer answer (0–999) from the transposed final step. It MUST differ from the seed's answer; if it comes out equal, perturb the parameter further. The "answer" field is the variant's actual value, never the seed's.\n- Emit the variant statement in "problem", the transposed step-by-step sketch (its last line equal to the answer) in "solutionSketch", and the value in "answer". A later step expands the sketch for the student.\n- The variant must be as hard as the seed. A–E answer choices are FORBIDDEN — every variant is free-response.\n\nSeeds to transpose (statement, solution sketch, answer):\n${anchors
              .map(
                (a, i) =>
                  `SEED ${i + 1}. [${a.source}${a.number != null ? ` #${a.number}` : ""}] ${stripChoices(a.statement)}${
                    a.sketch ? `\nSEED ${i + 1} SKETCH: ${a.sketch}` : a.solution ? `\nSEED ${i + 1} SOLUTION: ${a.solution}` : ""
                  }${a.answer ? `\nSEED ${i + 1} ANSWER: ${a.answer}` : ""}`
              )
              .join("\n\n")}\n`
          : adapt
          ? `\nEach of the following is a real AIME problem, given WITH its full worked solution and its answer. For each seed, produce an ISOMORPHIC VARIANT and ADAPT the seed's solution rather than solving from scratch. Work as follows for each seed:\n- Read the seed's solution and identify which parts are INVARIANT (the key insight, the method, the structure of the argument — these carry over to the variant unchanged) and which parts are NUMERIC / EXPRESSION-SPECIFIC (the specific constants, the modulus, the dimension, the bound).\n- Perturb a STRUCTURAL PARAMETER — a modulus, a dimension, the number of constraints or cases, or the bound — so the computation genuinely differs and the answer changes. Then RE-DRESS the problem completely: a variant that keeps the seed's sentence structure, nouns, and phrasing and merely swaps in new numbers WILL BE REJECTED and wasted. Move to a different surface domain (a different object, configuration, or story), rename every variable and label, and write the statement in your own words so it reads as an unrelated problem that merely happens to need the SAME technique. Do NOT reuse the seed's numbers, variable names, wording, or context.\n- Produce the variant's solution by TRANSFORMING the seed's: keep the invariant skeleton, and re-run ONLY the parts of the computation that the perturbed parameter actually affects. Do NOT re-derive from scratch the steps the seed already establishes — carry them forward. This is solution ADAPTATION, not rediscovery.\n- Reserve deep, from-scratch reasoning ONLY for a variant whose perturbation genuinely breaks the seed's method (e.g. it forces a case split the seed didn't have). For a straightforward parameter change the transformation is mostly mechanical — do not over-think it.\n- Compute the variant's real integer answer (0–999) — it MUST differ from the seed's answer; if it comes out equal, perturb the parameter further. The "answer" field is the variant's actual value, never the seed's.\n- Emit a SKETCH in the "solutionSketch" field: the key insight plus the major steps plus the final arithmetic that yields the answer — NOT a full write-up. A later step expands it for the student. The sketch's last line must equal the "answer" field.\n- The variant must be as hard as the seed. A–E answer choices are FORBIDDEN — every variant is free-response.\n\nSeeds to transform (statement, solution, answer):\n${anchors
              .map(
                (a, i) =>
                  `SEED ${i + 1}. [${a.source}${a.number != null ? ` #${a.number}` : ""}] ${stripChoices(a.statement)}${
                    a.solution ? `\nSEED ${i + 1} SOLUTION: ${a.solution}` : ""
                  }${a.answer ? `\nSEED ${i + 1} ANSWER: ${a.answer}` : ""}`
              )
              .join("\n\n")}\n`
          : `\nEach of the following is a real AIME problem. For each seed, produce an ISOMORPHIC VARIANT: identical mathematical structure and solution method, but a COMPLETELY DIFFERENT surface story/context and DIFFERENT numbers. Requirements for each variant:\n- The mathematical skeleton (the key insight, the type of equation/construction, the structural steps) must match the seed exactly — same difficulty, same level of insight required.\n- Perturb a STRUCTURAL PARAMETER — a modulus, a dimension, the number of constraints or cases, or the bound — so the computation genuinely differs from the seed. The variant's final answer MUST differ from the seed's answer; if your first attempt yields the same final value, adjust the structural parameter further until the answer differs.\n- Do NOT reuse the seed's numbers, variable names, or problem context. A variant that keeps the seed's sentence structure and phrasing and only swaps the numbers WILL BE REJECTED and wasted — re-dress it in your own words. Invent a genuinely new scenario (e.g. a different geometric configuration, a different combinatorial setup, a different number-theoretic statement) that requires the SAME mathematical technique.\n- The variant must be as hard as the seed. Do not simplify or soften any step.\n- FULLY RE-SOLVE the variant yourself from scratch. Compute the variant's real integer answer (0–999). Do NOT echo the seed's answer. The "answer" field must be the actual computed value for YOUR new problem.\n- A–E answer choices are FORBIDDEN. Every variant is free-response.\n(Some seeds are from multiple-choice contests; their A–E choices have been removed — do NOT reproduce any choice list in your variant.)\n\nSeeds to transform:\n${anchors
              .map(
                (a, i) =>
                  `SEED ${i + 1}. [${a.source}${a.number != null ? ` #${a.number}` : ""}] ${stripChoices(a.statement)}`
              )
              .join("\n")}\n`
        : `\nReference problems at the EXACT target difficulty — these are real problems of the level you must hit. Match their difficulty and style precisely. Do NOT copy, reword, or trivially reskin them; produce genuinely new problems of equivalent difficulty. (Some are from multiple-choice contests; their A–E choices have been removed and you must NOT reproduce any answer-choice list — generate free-response.):\n${anchors
            .map(
              (a, i) =>
                `${i + 1}. [${a.source}${a.number != null ? ` #${a.number}` : ""}] ${stripChoices(a.statement)}${
                  a.answer ? ` (answer: ${a.answer})` : ""
                }`
            )
            .join("\n")}\n`
      : "";

  // The system block is intentionally count-free and depends only on
  // per-student-stable inputs (rubric/band) plus the topic-trimmed book, so it
  // stays byte-identical across the deficit-retry attempt and qualifies for
  // prompt caching. All volatile, per-call content (student profile, history,
  // randomized anchors, and the count) lives in the user block.
  const system = `You are generating competition math/physics practice problems for a one-on-one tutoring session.
${bookBlock}${rubric}${bandBlock}
Each problem must meet ALL of these requirements:
- Difficulty must match the calibration and the reference problems provided EXACTLY — not easier, not harder. This is the most important requirement. ${routine ? "These are early, ROUTINE problems: keep them quick and single-idea. If you are uncertain whether a problem is at the right level, err SIMPLER, never harder — do NOT add artificial difficulty." : "Generators of these problems tend to come out TOO EASY, so deliberately push to the top of the band; when you are uncertain whether a problem is hard enough, err HARDER, never easier."}
- Use ONLY terminology, notation, named results, and techniques that are standard at the stated competition level. Do NOT introduce any concept, vocabulary, theorem, or method above that level — for AMC/AIME this means no university-level machinery (calculus, linear algebra, complex analysis, or advanced/olympiad theorems a solver at this level would not know); for F=ma, no calculus beyond the basics and no upper-division physics. Every problem must be both STATED and SOLVABLE with the toolkit a student at this level already has. Make the hard problems difficult through deeper, multi-step reasoning and synthesis of in-level ideas — never by reaching for above-level terminology or tools.
- Order the set from easiest to hardest, strictly increasing in difficulty across all the problems. ${routine ? "Routine one-idea problems are exactly right here — these are warm-up-level problems and must stay that way; do NOT escalate them into multi-step or back-of-contest difficulty." : "Every problem is a genuinely difficult competition-style problem — no warm-ups or routine one-idea problems. The back half especially must be hard enough that the student cannot solve them without help."}
- You MUST fully solve every problem yourself. The "answer" field holds the REAL computed final answer and the ${adapt ? `"solutionSketch" field a REAL sketch of the worked solution` : `"solution" field a REAL worked solution`}. NEVER output placeholders like "tbd", "TODO", "?", or "see solution".
- The "answer" field contains ONLY that final answer — no working, no restatement. For AIME-style it is a single integer 0–999; for AMC-style it is the exact computed value (integer, fraction, or exact expression); for F=ma/USAPhO/physics, a SYMBOLIC expression (variables only, e.g. $\frac{2mg}{k}$) — never an option letter or, for physics, a numeric value with units.
- The "problem" field is the bare problem statement ONLY — no title, header, number, difficulty label, hint, explanation, or any extra formatting or commentary inside it.
- The "problem" field contains EXACTLY ONE complete, self-contained problem — never two or more, never a problem followed by a replacement. Commit to a single statement and do not revise it inside the field: NO meta-commentary, NO "actually", NO "disregard", NO "here is the problem instead", NO corrections, restarts, or thinking-out-loud of any kind. If you change your mind about a problem, rewrite it cleanly before emitting — the field must read as one finished problem with zero trace of any abandoned attempt.
- The statement must be COMPLETE: no trailing "...", no ellipses standing in for omitted content, no abandoned or cut-off sentences. Every quantity, length, and relationship is fully written out.
- NEVER reference "the figure", "the diagram", "shown above", an image, or any visual. Every problem must be fully solvable from the text alone — state all coordinates, lengths, angles, and geometric relationships in words. Do not generate figure-dependent problems.
- In the "difficulty" field, give your honest estimate of the problem's difficulty as a competition reference, e.g. "AIME #12", "AMC10 #21", "F=ma #18". This is the only place a difficulty label appears — never inside the problem text.
- Never think out loud in any field. Phrases like "let me restate", "actually", "disregard", "see solution", or "I'll give a clean problem instead" must never appear anywhere. Every field is final and self-contained.
- NEVER present answer options or a multiple-choice list in the problem statement. AMC and F=ma are multiple-choice contests, but generate EVERY problem as FREE-RESPONSE: no "(A) … (E)" choices anywhere in the statement, and the "answer" field is the actual value/expression, never an option letter.
- For F=ma/USAPhO/physics problems: free-response with a symbolic answer expressed in the given variables. Do not reduce to a number with units.
- Each problem must be solvable with competition math/physics knowledge at the stated level.
- ${routine ? "The last problems in the set are the upper end of this routine band — slightly more involved than the first, but still quick, single-idea problems. Do NOT turn them into multi-step or synthesis problems." : "The final five problems (or as many as exist if fewer than five are requested) must each require at least three distinct reasoning steps, must NOT be solvable by a single standard formula or observation, and must reward deeper problem-solving and the synthesis of multiple ideas."}
- ${adapt ? `The "solutionSketch" is a CONCISE sketch (2–5 lines): the key insight, the major steps, and the final arithmetic that yields the answer — not a full prose write-up (a later step expands it for the student).` : `Solutions must be concise (3–5 lines), showing key steps only, and must be a CLEAN, CORRECT, forward derivation that reaches the value in the "answer" field on the first pass.`} NO arithmetic or algebra errors. NO self-correction, backtracking, or narration of checking of ANY kind — the ${adapt ? "sketch" : "solution"} must never contain "wait", "actually", "on second thought", "that's wrong", "I made an error", "redo", "let me ...", "checking:", or any of these verbs in any form: recalculate / recalculating, recompute / recomputing, recheck / rechecking, double-check, verify / verifying, confirm. No crossed-out, revised, or abandoned computation may appear. Do the work internally first; if your initial attempt contains a mistake, fix it silently and emit ONLY the final corrected, linear ${adapt ? "sketch" : "solution"}. For example, NEVER write "x = 5. Wait, let me recheck: x = 7." — emit only "x = 7." The last line of the ${adapt ? "sketch" : "solution"} MUST agree exactly with the "answer" field.
- Math notation: use $...$ for inline LaTeX, $$...$$ for display LaTeX.
- Write any literal dollar/currency sign as \$ (escaped) — a bare $ is reserved as a math delimiter and will break rendering. E.g. write "costs \$80", and inside math use \$ too (e.g. $\$80$). Never an unescaped $ for currency.
- Build on recent topics rather than repeating them.

Solve each problem efficiently — reason just enough to reach a correct answer whose value equals the last line of its solution; do not exhaustively re-derive, re-check, or re-rank the set. Emit only clean final fields, with no trace of any checking, recomputing, or correcting in any field.`;

  // Negative examples from a prior attempt (variant mode only): variants that were
  // rejected for being too close to a seed. Telling the model exactly what NOT to
  // produce breaks the deterministic re-echo of a sticky seed across deficit retries.
  const avoidBlock =
    mode === "variant" && avoidStatements && avoidStatements.length > 0
      ? `\nAlready-rejected variants — each of these earlier attempts was TOO CLOSE to a seed (it reused a seed's distinctive numbers or its structure/wording). Do NOT reproduce any of them or anything resembling them. For every problem you now generate, diverge much further from the seeds: change the structural parameter (a modulus, a size, the number of constraints or cases), use entirely different specific numbers, and a different surface domain.\n${avoidStatements
          .map((s, i) => `${i + 1}. ${s.length > 200 ? `${s.slice(0, 200)}…` : s}`)
          .join("\n")}\n`
      : "";

  const user = `Student profile:
- Level: ${level}
- Today's topic: ${topic || "(not specified — use the level to choose appropriate problems)"}

${historyBlock}
${anchorBlock}${avoidBlock}
Generate exactly ${count} fully-solved problem(s) — not fewer, ordered easiest to hardest. You MUST call the emit_problems tool with all ${count} problems (one entry per problem) and return NOTHING else — no prose, no problems written in the message text; every problem goes in the tool call.`;

  return { system, user };
}

// --- Adapt-path stage prompts ----------------------------------------------
// These stages run on a cheap, thinking-disabled model and use forced tool-use.
// Their tool schemas live with the calls (lib/generation/seed-sketch.ts,
// lib/generation/expand.ts, lib/generation/verifier-model.ts); the prompt TEXT
// lives here, per the single-prompt-file rule.

export type SketchItem = { problem: string; answer: string; solutionSketch: string };
export type SeedItem = { statement: string; solution: string; answer: string | null };

// STAGE A — seed-sketch. Distill each seed's REAL, known-correct worked solution into a
// terse numbered step-by-step sketch. This is pure summarization of a correct artifact
// (no solving), so it runs cheap and thinking-off — and the resulting skeleton is what
// the transpose stage mutates, instead of re-reading prose. Marking which steps are
// structural-invariant vs numeric tells the next stage what carries over untouched.
export function buildSeedSketchPrompt(items: SeedItem[]): { system: string; user: string } {
  const system = `You distill a competition-math problem's KNOWN-CORRECT worked solution into a terse, numbered step-by-step sketch. You are NOT solving anything — the solution is given; condense it faithfully.
For each item, output a numbered list of the solution's major steps, in order, ending with the line that states the final answer.
- One line per step: the action and its result (the key equation, substitution, count, or bound). Drop prose and motivation; keep the math.
- Tag each step with [INVARIANT] if it is structural/method (carries over to a similar problem unchanged) or [NUMERIC] if it depends on the specific constants/modulus/dimension/bound of THIS problem. This tells a later stage which steps to re-run when the numbers change.
- Do NOT introduce a new method, correct, or second-guess the given solution. If the given solution has a gap, sketch it as-is.
- The last line must state the final answer and equal the given answer.
- Math notation: $...$ inline, $$...$$ display.
Call the emit_seed_sketches tool with one sketch string per item, index-aligned to the items below, and return NOTHING else.`;

  const user = `Distill each solution into a numbered sketch (index-aligned):\n${items
    .map(
      (it, i) =>
        `--- Seed ${i + 1} ---\nProblem: ${it.statement}${it.answer ? `\nAnswer: ${it.answer}` : ""}\nSolution: ${it.solution}`
    )
    .join("\n\n")}`;

  return { system, user };
}

// STAGE 3 — expansion. Turn each terse sketch into a clean, student-facing worked
// solution WITHOUT changing the answer or the method. Output must read like the
// scratch-path `solution` field so the same display/guards apply.
export function buildExpandPrompt(items: SketchItem[]): { system: string; user: string } {
  const system = `You expand terse solution sketches into clean, student-facing worked solutions for competition math problems. For each item you are given the problem, its FINAL ANSWER, and a sketch of the solution.
For each item, write a concise but complete forward derivation (3–6 lines) that follows the sketch and reaches EXACTLY the given answer.
- Do NOT change the answer. Do NOT introduce a new method or a different approach — expand the sketch that is given, filling in the steps it abbreviates.
- Clean, linear, forward derivation only. NO backtracking or self-correction: never "wait", "actually", "recheck", "recompute", "let me", "verify", "confirm", "that's wrong", or any crossed-out work.
- The last line must equal the given answer.
- Math notation: $...$ for inline, $$...$$ for display. Write a literal currency sign as \\$ (a bare $ is a math delimiter).
Call the emit_solutions tool with one entry per item, index-aligned to the items below, and return NOTHING else.`;

  const user = `Expand each sketch into a full solution (index-aligned):\n${items
    .map(
      (it, i) =>
        `--- Item ${i + 1} ---\nProblem: ${it.problem}\nAnswer: ${it.answer}\nSketch: ${it.solutionSketch}`
    )
    .join("\n\n")}`;

  return { system, user };
}

// STAGE 2 — verification AUDIT (off unless GENERATION_VERIFY=1). This is a CHECKING
// task, not a solving task: given the problem, the sketch, and the proposed answer,
// decide only whether the sketch's arithmetic actually produces that answer.
export function buildAuditPrompt(items: SketchItem[]): { system: string; user: string } {
  const system = `You audit candidate competition-math solution sketches. For each item you are given a problem, a SKETCH of a solution, and a PROPOSED ANSWER.
Your ONLY job is to check whether the sketch's reasoning and arithmetic actually yield the proposed answer for the stated problem. Do NOT solve the problem from scratch or impose a different method — judge the sketch on its own terms, only catching genuine errors (a wrong arithmetic step, an answer that does not follow from the sketch, or an answer in the wrong format).
Return "pass" if the sketch's computation soundly produces the proposed answer, "fail" if it does not.
Call the emit_audit tool with one verdict per item, index-aligned to the items below, and return NOTHING else.`;

  const user = `Audit each item (index-aligned):\n${items
    .map(
      (it, i) =>
        `--- Item ${i + 1} ---\nProblem: ${it.problem}\nProposed answer: ${it.answer}\nSketch: ${it.solutionSketch}`
    )
    .join("\n\n")}`;

  return { system, user };
}
