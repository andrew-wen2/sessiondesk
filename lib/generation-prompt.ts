// The problem-generation prompt. This file is the product — keep ALL prompt
// logic here, nowhere else. Iterate it via commits: `prompt: <what changed>`.

import type { Anchor } from "@/lib/types";
import { BAND_THRESHOLDS } from "@/lib/calibration";
import type { AnswerFormat, GenerationPlan } from "@/lib/generation/plan";

// Kept as a name alias for callers that imported the prompt-local anchor type.
export type GenerationAnchor = Anchor;

export type GenerationInput = {
  // Everything difficulty- and subject-related now arrives on the plan: for a
  // contest student it carries the competition, band, and the static rubric below;
  // for any other subject it carries a model-written rubric and no competition.
  plan: GenerationPlan;
  profile: string; // the student's free-text profile (subject + level + goals)
  topic: string;
  count: number;
  recentTopics: string[]; // last N session topics, most recent first
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
  // Statements to steer away from: variants rejected for being too close to a seed,
  // or (on any path) the problems already kept, so the deficit retry diverges
  // instead of re-emitting what we just threw away or already have.
  avoidStatements?: string[];
  // Which parallel chunk this prompt is for. Unanchored runs give every chunk the
  // same prompt otherwise, which is how near-duplicate exercises get generated;
  // a per-chunk angle breaks the tie. Ignored when anchors are present, since the
  // anchors already differentiate the chunks.
  chunkIndex?: number;
  // Cascade pipeline: this call writes ONE problem of a larger set, generated
  // independently of its siblings. `index`/`of` place it on the set's easy→hard ramp,
  // `hint` is what distinguishes it from the others (a sub-skill, or "transform the
  // seed below"). Absent on the legacy chunked path.
  slot?: { index: number; of: number; hint: string };
};

// Per-competition difficulty rubric. The structure + number-band semantics are the
// concrete anchor the model calibrates against (alongside the retrieved anchors).
// Exported for the plan stage, which selects one on the fast path and has a model
// write the equivalent for any subject the corpus doesn't cover.
export const RUBRICS: Record<string, string> = {
  AIME: `AIME calibration: 15 fill-in problems, integer answers 0–999, strictly increasing difficulty. #1–5 are routine one-idea problems; #6–10 need a clever idea; #11–15 demand multiple non-obvious insights and careful casework (a strong solver spends 15–25+ min). A problem in the target band must NOT be solvable by a single standard technique if the band is 10–15.`,
  AMC10: `AMC 10 calibration: a 25-problem contest whose difficulty ramps with problem number. #1–10 quick; #11–17 need a solid idea; #18–25 require two or more insights or careful work under time pressure. Match the target number band — a #22 is not a warm-up. Present every problem as FREE-RESPONSE — do NOT include the A–E answer choices; ask for the actual value.`,
  AMC12: `AMC 12 calibration: a 25-problem contest, harder and more advanced than AMC 10 at the same number (more algebra/precalc, trickier). #1–10 quick; #11–17 a solid idea; #18–25 multi-insight. Match the target number band. Present every problem as FREE-RESPONSE — do NOT include the A–E answer choices; ask for the actual value.`,
  Fma: `F=ma calibration (AAPT): 25 multiple-choice mechanics problems (answers A–E), 75 minutes. Topics: kinematics, Newton's laws, energy, momentum, rotation, oscillations, gravitation. Later problems are harder (multi-step, less obvious setup); no calculus beyond basics. Exactly one correct option of five.`,
};

// The answer-format instruction for a non-contest subject, keyed off the plan's
// answerFormat. These mirror what `answerOkFor` enforces in the verifier — keep the
// two in step, or the model will be told one thing and graded on another.
// Exported for lib/generation/solve.ts — the solver's answer-format instruction
// must match what the generator was told, or a format mismatch reads as a false
// disagreement.
export const ANSWER_FORMAT_RULES: Record<AnswerFormat, string> = {
  integer: `It is a single integer.`,
  numeric: `It is the exact computed value (integer, fraction, or exact expression) — never an option letter.`,
  expression: `It is a symbolic expression in the given variables — not a number with units, never an option letter.`,
  "short-text": `It is the word, term, or short phrase that answers the question — never an option letter.`,
  open: `Most problems have a definite answer: give it. Only for work that genuinely has none (a writing, discussion, or open-composition prompt) may "answer" be empty — and in that case the "solution" field must hold a full model response the student can be measured against.`,
};

// AMC/F=ma corpus statements carry the original "(A) … (E)" option list. We generate
// free-response, so strip that list before injecting an anchor — otherwise the model
// is shown multiple-choice formatting to mimic. Conservative: only cut when a full
// span from (A) (or \textbf{(A)}) through (E) is present; otherwise leave untouched.
export function stripChoices(statement: string): string {
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
  competition: string | null | undefined,
  bandHigh: number | null | undefined
): "routine" | "core" | "hard" {
  if (!competition || bandHigh == null) return "routine";
  const { routineMax, hardMin } =
    competition === "AIME" ? BAND_THRESHOLDS.register.AIME : BAND_THRESHOLDS.register.default;
  return bandHigh <= routineMax ? "routine" : bandHigh >= hardMin ? "hard" : "core";
}

// Per-chunk generation angle, used ONLY when there are no anchors to differentiate
// the parallel chunks. Without this every chunk of an unanchored run receives a
// byte-identical prompt and the chunks come back with paraphrases of each other.
const CHUNK_ANGLES = [
  "straightforward application of the core skill",
  "interpretation and conceptual reasoning rather than mechanical work",
  "combining two distinct ideas in one problem",
  "an unfamiliar or applied context the student has to unpack first",
];

// Cascade slot hints: what distinguishes one separately-written problem from its
// siblings. Kept here with the rest of the prompt text.
export function slotHintForSubtopic(subtopic: string): string {
  return `the sub-skill "${subtopic}"`;
}

export function slotHintForAngle(index: number): string {
  return CHUNK_ANGLES[index % CHUNK_ANGLES.length];
}

export function slotHintForSeed(label: string): string {
  return `transform the seed problem below (${label}) into an isomorphic variant`;
}

export function buildPrompt(input: GenerationInput): { system: string; user: string } {
  const { plan, profile, topic, count, recentTopics, anchors, mode = "scratch", avoidStatements, chunkIndex, slot } =
    input;
  const { competition, bandLow, bandHigh } = plan;
  // Adapt only applies on the variant path AND only when the seeds actually carry
  // solutions to transform (AIME/AMC do; F=ma seeds are null → statement-only re-solve).
  const adapt = !!input.adapt && mode === "variant" && !!anchors?.some((a) => a.solution);
  // Staged transpose path: the seeds carry a pre-distilled step-by-step SKETCH (Stage A).
  // When present, the adapt block hands the model that numbered skeleton to TRANSPOSE
  // rather than the raw prose solution to re-read — narrowing the task so the heavy
  // re-derivation (and its runaway thinking/truncations) doesn't fire. Falls back to the
  // prose-solution framing when sketches are absent (Stage A skipped or failed).
  const staged = adapt && !!anchors?.some((a) => a.sketch);
  // Routine framing = quick, single-idea problems, kept deliberately easy. For a
  // contest that's the early problem-number bands; without one it's the easy tier.
  const routine = competition ? bandRegister(competition, bandHigh) === "routine" : plan.tier === "easy";

  const historyBlock =
    recentTopics.length > 0
      ? `Recent session topics (most recent first — do NOT repeat these, build on them):\n${recentTopics
          .map((t, i) => `${i + 1}. ${t}`)
          .join("\n")}`
      : "No prior session history — this is the student's first session.";

  // One rubric slot, two sources: the hand-tuned table above for a contest, or the
  // plan stage's model-written rubric for every other subject. For subjects the
  // corpus can't anchor, this rubric is the only concrete calibration the model gets.
  const rubric = plan.rubric ? `\n${plan.rubric}\n` : "";

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

  // What a valid `answer` looks like. The contest wording enumerates all three
  // formats at once (unchanged from when this prompt only ever served contests);
  // every other subject gets the one line its plan's answerFormat calls for, which
  // is also exactly what the verifier will enforce.
  const answerFormatLine = competition
    ? `- The "answer" field contains ONLY that final answer — no working, no restatement. For AIME-style it is a single integer 0–999; for AMC-style it is the exact computed value (integer, fraction, or exact expression); for F=ma/USAPhO/physics, a SYMBOLIC expression (variables only, e.g. $\\frac{2mg}{k}$) — never an option letter or, for physics, a numeric value with units.`
    : `- The "answer" field contains ONLY the final answer — no working, no restatement. ${ANSWER_FORMAT_RULES[plan.answerFormat]}`;

  // The system block is intentionally count-free and depends only on
  // per-student-stable inputs (rubric/band), so it stays byte-identical across
  // the deficit-retry attempt and qualifies for prompt caching. All volatile,
  // per-call content (student profile, history, randomized anchors, the chunk
  // angle, and the count) lives in the user block.
  const opener = competition
    ? `You are generating competition math/physics practice problems for a one-on-one tutoring session.`
    : `You are an expert tutor generating ${plan.domain ? `${plan.domain} ` : ""}practice problems for a one-on-one tutoring session, calibrated to one student.`;

  const requirements = [
    `- Difficulty must match the calibration ${competition ? "and the reference problems provided " : ""}EXACTLY — not easier, not harder. This is the most important requirement. ${routine ? "These are early, ROUTINE problems: keep them quick and single-idea. If you are uncertain whether a problem is at the right level, err SIMPLER, never harder — do NOT add artificial difficulty." : `Generators of these problems tend to come out TOO EASY, so deliberately push to the top of the ${competition ? "band" : "student's stated level"}; when you are uncertain whether a problem is hard enough, err HARDER, never easier.`}`,
    competition
      ? `- Use ONLY terminology, notation, named results, and techniques that are standard at the stated competition level. Do NOT introduce any concept, vocabulary, theorem, or method above that level — for AMC/AIME this means no university-level machinery (calculus, linear algebra, complex analysis, or advanced/olympiad theorems a solver at this level would not know); for F=ma, no calculus beyond the basics and no upper-division physics. Every problem must be both STATED and SOLVABLE with the toolkit a student at this level already has. Make the hard problems difficult through deeper, multi-step reasoning and synthesis of in-level ideas — never by reaching for above-level terminology or tools.`
      : `- Use ONLY concepts, vocabulary, notation, and techniques a student at the stated level already has. Do NOT introduce anything above that level, and do NOT assume material the student has not reached. Every problem must be both STATED and SOLVABLE with the toolkit they already have. Make the hard problems difficult through deeper, multi-step reasoning and the synthesis of in-level ideas — never by reaching for above-level terminology or tools.`,
    `- Order the set from easiest to hardest, strictly increasing in difficulty across all the problems. ${routine ? `Routine one-idea problems are exactly right here — these are warm-up-level problems and must stay that way; do NOT escalate them into multi-step or ${competition ? "back-of-contest" : "back-of-set"} difficulty.` : `Every problem is a genuinely difficult ${competition ? "competition-style" : "level-appropriate"} problem — no warm-ups or routine one-idea problems. The back half especially must be hard enough that the student cannot solve them without help.`}`,
    `- You MUST fully solve every problem yourself. The "answer" field holds the REAL computed final answer and the ${adapt ? `"solutionSketch" field a REAL sketch of the worked solution` : `"solution" field a REAL worked solution`}. NEVER output placeholders like "tbd", "TODO", "?", or "see solution".`,
    answerFormatLine,
    `- The "problem" field is the bare problem statement ONLY — no title, header, number, difficulty label, hint, explanation, or any extra formatting or commentary inside it.`,
    `- The "problem" field contains EXACTLY ONE complete, self-contained problem — never two or more, never a problem followed by a replacement. Commit to a single statement and do not revise it inside the field: NO meta-commentary, NO "actually", NO "disregard", NO "here is the problem instead", NO corrections, restarts, or thinking-out-loud of any kind. If you change your mind about a problem, rewrite it cleanly before emitting — the field must read as one finished problem with zero trace of any abandoned attempt.`,
    `- The statement must be COMPLETE: no trailing "...", no ellipses standing in for omitted content, no abandoned or cut-off sentences. Every quantity, length, and relationship is fully written out.`,
    `- NEVER reference "the figure", "the diagram", "shown above", an image, or any visual. Every problem must be fully solvable from the text alone — state all coordinates, lengths, angles, and geometric relationships in words. Do not generate figure-dependent problems.`,
    competition
      ? `- In the "difficulty" field, give your honest estimate of the problem's difficulty as a competition reference, e.g. "AIME #12", "AMC10 #21", "F=ma #18". This is the only place a difficulty label appears — never inside the problem text.`
      : `- In the "difficulty" field, give your honest estimate of this problem's difficulty relative to the student's stated level (e.g. "on target", "slightly above", or a course/unit reference). This is the only place a difficulty label appears — never inside the problem text.`,
    `- Never think out loud in any field. Phrases like "let me restate", "actually", "disregard", "see solution", or "I'll give a clean problem instead" must never appear anywhere. Every field is final and self-contained.`,
    competition
      ? `- NEVER present answer options or a multiple-choice list in the problem statement. AMC and F=ma are multiple-choice contests, but generate EVERY problem as FREE-RESPONSE: no "(A) … (E)" choices anywhere in the statement, and the "answer" field is the actual value/expression, never an option letter.`
      : `- NEVER present answer options or a multiple-choice list in the problem statement. Generate EVERY problem as FREE-RESPONSE: no "(A) … (E)" choices anywhere in the statement, and the "answer" field is the actual answer, never an option letter.`,
    ...(competition
      ? [
          `- For F=ma/USAPhO/physics problems: free-response with a symbolic answer expressed in the given variables. Do not reduce to a number with units.`,
          `- Each problem must be solvable with competition math/physics knowledge at the stated level.`,
        ]
      : []),
    `- ${routine ? `The last problems in the set are the upper end of this routine ${competition ? "band" : "level"} — slightly more involved than the first, but still quick, single-idea problems. Do NOT turn them into multi-step or synthesis problems.` : "The final five problems (or as many as exist if fewer than five are requested) must each require at least three distinct reasoning steps, must NOT be solvable by a single standard formula or observation, and must reward deeper problem-solving and the synthesis of multiple ideas."}`,
    `- ${adapt ? `The "solutionSketch" is a CONCISE sketch (2–5 lines): the key insight, the major steps, and the final arithmetic that yields the answer — not a full prose write-up (a later step expands it for the student).` : `Solutions must be concise (3–5 lines), showing key steps only, and must be a CLEAN, CORRECT, forward derivation that reaches the value in the "answer" field on the first pass.`} NO arithmetic or algebra errors. NO self-correction, backtracking, or narration of checking of ANY kind — the ${adapt ? "sketch" : "solution"} must never contain "wait", "actually", "on second thought", "that's wrong", "I made an error", "redo", "let me ...", "checking:", or any of these verbs in any form: recalculate / recalculating, recompute / recomputing, recheck / rechecking, double-check, verify / verifying, confirm. No crossed-out, revised, or abandoned computation may appear. Do the work internally first; if your initial attempt contains a mistake, fix it silently and emit ONLY the final corrected, linear ${adapt ? "sketch" : "solution"}. For example, NEVER write "x = 5. Wait, let me recheck: x = 7." — emit only "x = 7." The last line of the ${adapt ? "sketch" : "solution"} MUST agree exactly with the "answer" field.`,
    `- Math notation: use $...$ for inline LaTeX, $$...$$ for display LaTeX.`,
    ...(!competition && (plan.contentType === "code" || plan.contentType === "mixed")
      ? [`- Write any code inside fenced blocks: triple backticks with a language tag, e.g. \`\`\`python … \`\`\`. Everything that is not math or code is plain prose.`]
      : []),
    `- Write any literal dollar/currency sign as \\$ (escaped) — a bare $ is reserved as a math delimiter and will break rendering. E.g. write "costs \\$80", and inside math use \\$ too (e.g. $\\$80$). Never an unescaped $ for currency.`,
    `- Build on recent topics rather than repeating them.`,
  ];

  const system = `${opener}
${rubric}${bandBlock}
Each problem must meet ALL of these requirements:
${requirements.join("\n")}

Solve each problem efficiently — reason just enough to reach a correct answer whose value equals the last line of its solution; do not exhaustively re-derive, re-check, or re-rank the set. Emit only clean final fields, with no trace of any checking, recomputing, or correcting in any field.`;

  // Negative examples fed back from a prior attempt. On the variant path they are
  // variants rejected for hugging a seed; everywhere else they are the problems
  // already kept. Either way, telling the model exactly what NOT to produce is what
  // makes a deficit retry diverge instead of re-emitting the same thing.
  const avoidList =
    avoidStatements && avoidStatements.length > 0
      ? avoidStatements.map((s, i) => `${i + 1}. ${s.length > 200 ? `${s.slice(0, 200)}…` : s}`).join("\n")
      : "";
  const avoidBlock = !avoidList
    ? ""
    : mode === "variant"
      ? `\nAlready-rejected variants — each of these earlier attempts was TOO CLOSE to a seed (it reused a seed's distinctive numbers or its structure/wording). Do NOT reproduce any of them or anything resembling them. For every problem you now generate, diverge much further from the seeds: change the structural parameter (a modulus, a size, the number of constraints or cases), use entirely different specific numbers, and a different surface domain.\n${avoidList}\n`
      : `\nProblems already in this set — do NOT repeat any of them, and do NOT produce a variation that tests the same thing in the same way. Each new problem must exercise a different sub-skill, a different configuration, or a different context.\n${avoidList}\n`;

  // One problem of a set written in parallel: say where it sits on the ramp and what
  // it should focus on, since this call can't see its siblings.
  const slotBlock = slot
    ? `\nThis request is for ONE problem: problem ${slot.index + 1} of a ${slot.of}-problem set whose other problems are being written separately. Pitch its difficulty for position ${slot.index + 1} of ${slot.of} in an easiest-to-hardest set. Focus for this problem: ${slot.hint}.\n`
    : "";

  // Per-chunk angle: only when nothing else distinguishes the parallel chunks.
  const angleBlock =
    !slot && !anchors?.length && chunkIndex != null
      ? `\nFor this batch specifically, lean toward ${CHUNK_ANGLES[chunkIndex % CHUNK_ANGLES.length]}. Stay within the calibrated difficulty — this changes the flavour of the problems, not their level.\n`
      : "";

  const user = `Student profile:
- Profile: ${profile || "(not specified)"}${plan.domain ? `\n- Subject: ${plan.domain}` : ""}
- Today's topic: ${topic || "(not specified — use the profile to choose appropriate problems)"}

${historyBlock}
${anchorBlock}${avoidBlock}${slotBlock}${angleBlock}
Generate exactly ${count} fully-solved problem(s) — not fewer, ordered easiest to hardest. You MUST call the emit_problems tool with all ${count} problems (one entry per problem) and return NOTHING else — no prose, no problems written in the message text; every problem goes in the tool call.`;

  return { system, user };
}

// --- Construct-first single problem (eval: scripts/eval-solve-first.ts) ------
// One problem, built BACKWARD from an answer the writer picks first; the answer goes
// in a private field and independent solvers answer the statement blind. Unlike
// buildPrompt it asks for no answer/solution fields at all: under buildPrompt plus an
// "ignore the solution fields" override, a thinking writer spent a third of its calls
// reworking constructions until it ran out of time or tokens. So the procedure is
// bounded: one construction, one forward check, and new values instead of repairs.
// The program language for code-computed answers (lib/generation/answer-check.ts).
// Shared by the writer's own answerCheck and the blind program solver, so the two can
// never describe a different subset from the one the sandbox accepts.
export const ANSWER_PROGRAM_LANGUAGE = `Write it in the mathjs expression language: statements separated by ";" or new lines, the last line's value is the answer. Allowed: numbers, + - * / ^, comparisons, "and"/"or"/"not", "c ? a : b", variables ("a = 3"), your own functions ("f(n) = mod(n, 7) == 3"), inclusive integer ranges ("1:100"), arrays ("[2, 3, 5]", indexed from 1), and these functions: abs sqrt cbrt nthRoot pow exp log floor ceil round mod gcd lcm max min sum prod mean median factorial combinations permutations isPrime isInteger map filter size count sort setDistinct polynomialRoot lusolve det fraction sin cos tan atan2 hypot. Define functions only as "f(x) = ..." (no "->" lambdas), no comments, no recursion, and no loops other than map/filter over ranges; enumerate at most about a million values. Example for "how many integers from 1 to 500 are divisible by 3 or 7": "f(n) = mod(n, 3) == 0 or mod(n, 7) == 0; size(filter(1:500, f))". If the answer is not a single number, or cannot be computed this way, write "none".`;

const METHOD_FIELD = `one line naming the key idea and the solution steps, with no numbers, e.g. "set up two linear equations from the totals, eliminate one unknown"`;
const SOLUTION_FIELD = "a short forward solution a student can follow, 3–6 lines, written from your construction and ending with a line that states that same answer";

export type ConstructTarget = {
  number: number; // the contest position this problem should play like
  reference?: Anchor; // a real problem at that position, shown for difficulty only
};

export function buildConstructPrompt(
  input: Omit<GenerationInput, "count" | "mode" | "adapt" | "chunkIndex"> & {
    // "construct": the eval's emit_problem (problem + private intended answer +
    // construction note). "problems": the cascade writers' emit_problems, with a
    // student-facing solution written forward from the construction.
    output?: "construct" | "problems";
    target?: ConstructTarget;
    // Problems this student worked in recent sessions: never reused across sessions.
    seenStatements?: string[];
    // "problems" output only: also write the answerCheck program. Only for writers that
    // reason in a thinking block (Anthropic); others leak the check into the solution.
    answerCheck?: boolean;
    // Seeded slot (cascade/seed-slots.ts): a real in-band problem to build a variant of.
    // The variant keeps the seed's idea and difficulty and changes everything a student
    // could look up. Replaces the difficulty-only reference.
    seed?: Anchor;
  }
): { system: string; user: string } {
  const { plan, profile, topic, recentTopics, anchors, avoidStatements, slot, output = "construct", target, seenStatements, answerCheck = false, seed } = input;
  const { competition, bandLow, bandHigh } = plan;
  const routine = competition ? bandRegister(competition, bandHigh) === "routine" : plan.tier === "easy";
  const hasBand = competition && bandLow != null && bandHigh != null;

  // With a per-slot target the band only frames the student; the target is what this
  // one problem must hit. Without one, fall back to the band as a whole.
  const seedLabel = seed ? `${seed.source}${seed.number != null ? ` #${seed.number}` : ""}` : "";
  const band = !hasBand
    ? ""
    : seed
      ? `\nThe student works at ${competition} #${bandLow}–${bandHigh}. THIS problem must be exactly as hard as the real ${seedLabel} below, which real students found as hard as a problem in that range.\n`
      : target
      ? `\nThe student works at ${competition} #${bandLow}–${bandHigh}. THIS problem's target is ${competition} #${target.number}: make it play like a real #${target.number}, not like either end of the range.\n`
      : `\nTarget difficulty: ${competition} problems ${bandLow}–${bandHigh}. ${routine ? "These are early, routine problems: one main idea, finished in a couple of minutes. Do not inflate them." : `Sit at the hard end of this band: multi-step reasoning with in-level ideas, as hard as a real #${bandHigh}.`}\n`;
  const reference = seed
    ? `\nBuild your problem as a variant of this real ${seedLabel}. Keep what makes it hard: its key idea, the insight a solver needs, and the number of reasoning steps. Change the story or setting, every given number, and at least one structural parameter (a count, a bound, a modulus, a dimension, a number of cases), so your answer differs from its answer and the original's solution can't simply be copied. Do not make it easier: remove no step and give nothing away. Write your statement in your own words.
Real problem: ${stripChoices(seed.statement)}${seed.answer ? `\nIts answer: ${seed.answer}` : ""}${seed.solution ? `\nIts solution (for the idea only; never reuse its numbers):\n${seed.solution.slice(0, 2000)}` : ""}\n`
    : target?.reference
    ? `\nA real ${target.reference.source} #${target.reference.number ?? target.number}, shown ONLY so you can feel the difficulty. Do not reuse its topic, setup, wording, or numbers; today's topic decides what your problem is about:\n${stripChoices(target.reference.statement)}\n`
    : !target && anchors && anchors.length > 0
      ? `\nReference problems at the target difficulty (match their level and style; do not copy or reskin them):\n${anchors
          .map((a, i) => `${i + 1}. [${a.source}${a.number != null ? ` #${a.number}` : ""}] ${stripChoices(a.statement)}`)
          .join("\n")}\n`
      : "";

  const difficultyField = `your estimate${competition ? `, e.g. "${competition} #${target?.number ?? bandHigh ?? 10}"` : ""}`;
  const emit =
    output === "problems"
      ? answerCheck
        ? `Call emit_problems with exactly one entry, filling the fields in this order: "problem" (the statement alone), "answer" (the answer you chose, answer only), "answerCheck" (your step-3 program), "method" (${METHOD_FIELD}), "solution" (${SOLUTION_FIELD}), and "difficulty" (${difficultyField}).
The solution is written last, after the check has passed, so it is clean: a student reads it, so it never corrects itself, never says "wait", and never mentions the check.
"answerCheck" is a short program that a computer runs to confirm the answer. It computes the answer FORWARD from the numbers in the statement, the way a solver would, and must not simply restate the answer you chose. ${ANSWER_PROGRAM_LANGUAGE}`
        : `Call emit_problems with exactly one entry: "problem" (the statement alone), "answer" (the answer you chose, answer only), "method" (${METHOD_FIELD}), "solution" (${SOLUTION_FIELD}), and "difficulty" (${difficultyField}). Leave "answerCheck" out.`
      : `Call emit_problem with: "problem" (the statement alone), "intended" (the answer you chose, answer only), and "construction" (at most two lines: the chosen values and how the givens were computed).`;
  const tool = output === "problems" ? "emit_problems" : "emit_problem";

  const system = `You write ONE ${competition ? "competition math/physics" : `${plan.domain ? `${plan.domain} ` : ""}`} practice problem for a one-on-one tutoring session. Build it backward from its answer, so the answer is known to be right before the problem exists.
${plan.rubric ? `\n${plan.rubric}\n` : ""}${band}
How to build it:
1. Choose the final answer and every intermediate quantity a solver will find (how many of each item, the value of each unknown). Use clean values (integers or simple fractions) that meet the problem's natural constraints (whole-number counts, real solutions, positive lengths). Difficulty comes from the reasoning the problem needs, never from messy numbers.
2. Compute every given number in the statement from those chosen values.
3. Check once by solving your statement forward, and check the answer is unique: enough conditions to pin down every quantity the question depends on, and for "sum of all" or "how many" questions, every case counted.${output === "problems" && answerCheck ? ` Part of this check is writing the "answerCheck" program described below and making sure it gives your answer.` : ""}
4. If the check fails, do not repair it. Choose new values or a simpler setup and repeat steps 1–3.
Keep your reasoning short: one construction and one check. Do not polish the wording again and again.

The problem must:
- Match the target difficulty exactly${routine && !target ? "; if unsure, err simpler" : ""}. Use only terminology and techniques standard at the student's level.
- Be one complete, self-contained, free-response statement: no title, hint, answer choices, figure or diagram reference, or commentary.
- Have exactly one correct answer${competition ? "" : `. ${ANSWER_FORMAT_RULES[plan.answerFormat]}`}.
- Use $...$ for inline LaTeX and $$...$$ for display. Write a currency sign as \\$.

${emit}`;

  const history =
    recentTopics.length > 0
      ? `Recent session topics (build on them, do not repeat them): ${recentTopics.join("; ")}`
      : "No prior session history.";
  const avoid =
    avoidStatements && avoidStatements.length > 0
      ? `\nProblems already in this set (test something different):\n${avoidStatements.map((s, i) => `${i + 1}. ${s.slice(0, 200)}`).join("\n")}\n`
      : "";
  const place = slot
    ? `\nThis is problem ${slot.index + 1} of a ${slot.of}-problem set ordered easiest to hardest; pitch it for that position. Focus: ${slot.hint}.\n`
    : "";
  const seen =
    seenStatements && seenStatements.length > 0
      ? `\nProblems this student already worked in recent sessions. Do not reuse their setup, story, numbers or key trick:\n${seenStatements.map((s, i) => `${i + 1}. ${s.slice(0, 200)}`).join("\n")}\n`
      : "";

  const user = `Student profile: ${profile || "(not specified)"}${plan.domain ? `\nSubject: ${plan.domain}` : ""}
Today's topic: ${topic || "(not specified; use the profile)"}
${history}
${reference}${avoid}${seen}${place}
Write the problem and call ${tool}.`;

  return { system, user };
}

// --- Adapt-path stage prompts ----------------------------------------------
// These stages run on a cheap, thinking-disabled model and use forced tool-use.
// Their tool schemas live with the calls (lib/generation/seed-sketch.ts,
// lib/generation/expand.ts, lib/generation/verifier-model.ts); the prompt TEXT
// lives here, per the single-prompt-file rule.

export type SketchItem = { problem: string; answer: string; solutionSketch: string };
export type SeedItem = { statement: string; solution: string; answer: string | null };

// --- Plan stage -------------------------------------------------------------

// Classify the subject and WRITE THE CALIBRATION RUBRIC for a student the corpus
// can't anchor. The rubric is the important output: with no real reference problems
// to show, an explicit statement of what too-easy / on-target / too-hard look like
// is the only thing standing between the generator and its habit of undershooting.
// Runs on a cheap thinking-off model, so the instructions stay tight and concrete.
export function buildPlanPrompt(args: {
  profile: string;
  topic: string;
  recentTopics: string[];
}): { system: string; user: string } {
  const system = `You plan a practice-problem set for a one-on-one tutoring session. You are NOT writing problems — you are reading a tutor's description of their student and deciding how the set should be calibrated.

Given the student description and today's topic, determine:
- domain: the subject, as specifically as the description supports. If the description names a course, level, or exam, include it.
- contentType: the dominant form the work takes — "math" for symbolic or quantitative work, "prose" for language, humanities, or writing, "code" for programming, "mixed" when it genuinely spans more than one.
- tier: "mid" when the work demands multi-step reasoning, synthesis, or advanced/college-level material; "easy" for introductory, drill, or single-idea practice. When the description is vague, judge from the topic.
- answerFormat: what a correct answer looks like. Choose "open" ONLY when the work genuinely has no single correct answer (an essay, a discussion prompt, free composition). Anything with a determinate answer — including short-answer recall and conceptual questions — must NOT be "open".
- rubric: 3–4 sentences of concrete difficulty calibration for THIS student. Say what a problem that is too easy for them looks like, what an on-target problem looks like, and what would be above their level. Name the actual skills, content, and question types involved — a generic rubric is useless. This text is handed straight to the problem generator as its difficulty standard.

Be decisive: pick the most likely reading of a thin description rather than hedging. Call the emit_plan tool and return NOTHING else.`;

  const historyLine =
    args.recentTopics.length > 0
      ? `\nRecently covered: ${args.recentTopics.join("; ")}`
      : `\nNo prior session history.`;

  const user = `Student description: ${args.profile || "(not specified)"}
Today's topic: ${args.topic || "(not specified)"}${historyLine}

Plan the problem set.`;

  return { system, user };
}

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
Call the emit_seed_sketches tool with one entry per item, each carrying its own "index" field matching the seed number below (0-based), and return NOTHING else.`;

  const user = `Distill each solution into a numbered sketch. Echo each seed's index in your response:\n${items
    .map(
      (it, i) =>
        `--- Seed index=${i} ---\nProblem: ${it.statement}${it.answer ? `\nAnswer: ${it.answer}` : ""}\nSolution: ${it.solution}`
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
Call the emit_solutions tool with one entry per item, each carrying its own "index" field matching the item number below (0-based), and return NOTHING else.`;

  const user = `Expand each sketch into a full solution. Echo each item's index in your response:\n${items
    .map(
      (it, i) =>
        `--- Item index=${i} ---\nProblem: ${it.problem}\nAnswer: ${it.answer}\nSketch: ${it.solutionSketch}`
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

// INDEPENDENT SOLVER (lib/generation/solve.ts). Structurally independent: this
// prompt is built from the problem statement + the plan's subject/rubric context
// ONLY — it never receives the generator's answer or the corpus seed. Agreement
// between this and the generator's self-reported answer is what makes a stored
// answer trustworthy; if this prompt ever leaked the generator's answer, agreement
// would measure nothing.
export function buildSolvePrompt(args: {
  problem: string;
  domain: string;
  rubric: string;
  answerFormat: AnswerFormat;
  // Cascade cheap solvers only: also report any assumption the statement didn't justify.
  // Solvers often notice a flaw mid-solution and answer anyway (MathTrap: 33–39% drops on
  // flawed variants); a separate field turns that noticing into a veto.
  flagAssumptions?: boolean;
}): { system: string; user: string } {
  const { problem, domain, rubric, answerFormat, flagAssumptions = false } = args;
  const system = `You are an expert solver working a practice problem cold — you have not seen it before and no proposed answer exists yet. Solve it completely and correctly.
Subject: ${domain || "general"}. ${rubric ? `Calibration context (not part of the problem): ${rubric}` : ""}
- Work the problem through fully before answering. Do not guess.
- The "answer" field holds ONLY the final answer, no working. ${ANSWER_FORMAT_RULES[answerFormat]}
- If the problem as stated is genuinely ill-posed, ambiguous, or unanswerable (not merely hard), set "ambiguous" to true and explain why in "note" — otherwise leave "ambiguous" false.${
    flagAssumptions
      ? `
- If you had to ASSUME something the statement does not say to reach an answer (a missing quantity, an unstated condition, a choice between two readings), put that assumption in "assumed" in one line. Leave "assumed" empty when you needed nothing beyond the statement; standard conventions (real numbers, positive lengths, fair coins) are not assumptions.`
      : ""
  }
- Math notation: $...$ for inline, $$...$$ for display.
Call the emit_solve tool and return NOTHING else.`;

  const user = `Solve this problem:\n${problem}`;

  return { system, user };
}

// Well-posedness check (cascade verify-cheap.ts). Separate from solving because two
// solvers agreeing is not evidence a problem is well-posed: in an eval, both cheap
// solvers answered a problem whose conditions had no real solution. It sees only the
// statement, never an answer.
export function buildValidityPrompt(args: { problem: string; domain: string; answerFormat: AnswerFormat }): {
  system: string;
  user: string;
} {
  const { problem, domain, answerFormat } = args;
  // Staged, after MathQ-Verify (2025): list the conditions, then check them against each
  // other, then check the goal. The decomposed check beat a single "is this valid?" by
  // up to 25 F1 points, and only ~60% of LLM-written questions in its benchmark were valid.
  const system = `You review a ${domain ? `${domain} ` : ""}practice problem before a student sees it. Decide only whether it is WELL-POSED, not how hard it is. Work in stages:
1. "conditions": list every given condition and quantity, one short item each.
2. "missing": anything a solver needs that is not given (empty string if nothing).
3. "contradiction": any conditions that conflict, or that make the asked quantity impossible (counts that can't be whole, equations without the real solutions the problem assumes); empty string if none.
4. "notUnique": whether the asked quantity has more than one value, or a case is unaccounted for; empty string if it is unique.
5. "selfContained": false if it has answer choices or refers to a figure that isn't described.
6. "wellPosed": true only when stages 2–4 are empty and stage 5 is true; "reason": one sentence, for false what exactly is wrong.
Work it through as far as you need to decide, but do not write up a solution. The expected answer format is: ${ANSWER_FORMAT_RULES[answerFormat]}
Call emit_validity with every field.`;
  return { system, user: `Problem:\n${problem}` };
}

// Problem-type menu for one set (cascade problem-types.ts). Without it, a contest set's
// slots differed only by a generic angle, and on a narrow topic the writer fell back to
// a few favorite setups: two Opus sets on "linear and quadratic equations" shared a
// word-for-word problem, and one set held three shared-root problems. Each slot gets
// one of these types instead, so the set covers different ideas.
//
// Exclusion is by type NAME (excludedTypes, from buildRecentTypesPrompt), not by raw
// problems: asked to infer and avoid the types of 20 raw problems with thinking off, the
// model echoed them back as the list; with thinking on it took 53s.
export function buildProblemTypesPrompt(args: {
  domain: string;
  competition: string | null;
  bandLow: number | null;
  bandHigh: number | null;
  profile: string;
  topic: string;
  excludedTypes: string[];
  count: number;
}): { system: string; user: string } {
  const { domain, competition, bandLow, bandHigh, profile, topic, excludedTypes, count } = args;
  const level = competition && bandLow != null && bandHigh != null ? `${competition} problems #${bandLow}–${bandHigh}` : "the student's level";
  const system = `You plan the variety of a ${domain ? `${domain} ` : ""}practice set for one student at ${level}.
List ${count} distinct PROBLEM TYPES within today's topic. A type names the kind of setup and the key idea a solver needs, in a short phrase, e.g. "work-rate: two agents, combined rate", "integer roots via Vieta and factor-pair casework", "revenue maximization from a linear demand model".
- Every type must need a genuinely different idea or setup. Two stories with the same underlying trick are ONE type.
- Stay inside today's topic and at the student's level. Order does not matter.
- If excluded types are listed, list NONE of them, including the same type under a different name or story.
- Include less obvious types as well as the common ones. For each, give "typicality": the probability (0 to 1) that a typical tutor's set on this topic would include that type.
Call emit_types with the list.`;
  const recent =
    excludedTypes.length > 0
      ? `\n\nEXCLUDED types (this student practiced them recently; list none of them):\n${excludedTypes.map((t) => `- ${t}`).join("\n")}`
      : "";
  const user = `Student profile: ${profile || "(not specified)"}\nToday's topic: ${topic || "(not specified; use the profile)"}${recent}`;
  return { system, user };
}

// Step one of the problem-type menu: name the type each recent problem uses, so the
// menu can exclude them by name. Classification only, fast with thinking off.
export function buildRecentTypesPrompt(args: { domain: string; recentProblems: string[] }): { system: string; user: string } {
  const system = `You classify ${args.domain ? `${args.domain} ` : ""}practice problems by PROBLEM TYPE: the kind of setup and the key idea a solver needs, as a short phrase (e.g. "work-rate: two agents, combined rate", "two quadratics sharing a root, found by subtracting"). Problems with the same key idea share one type even when their stories or numbers differ. Call emit_types with one type per DISTINCT idea among the problems below.`;
  return { system, user: args.recentProblems.map((p, i) => `${i + 1}. ${p.slice(0, 300)}`).join("\n") };
}

// --- Difficulty judge (cascade difficulty-judge.ts) --------------------------
// Relative judgments against REAL problems of known human difficulty, never an absolute
// rating: pairwise comparison tracks empirical difficulty clearly better than asking a
// model to rate one problem alone (Kolesnikova et al. 2026; Ballon et al. 2025), and a
// solver's pass rate tracked it worst of all (r ≈ 0.2), which is why the pass-rate
// filter could not separate AMC #6–10 from #11–15.
const DIFFICULTY_CRITERIA = `Judge difficulty for a strong high-school student working under contest conditions: how many reasoning steps it takes, how standard the key idea is, how easy it is to go wrong, and how long a careful solver needs. Ignore the topic, the length of the statement, and how messy the numbers look. Do not solve the problems fully; judge them.`;

export function buildPairwiseDifficultyPrompt(args: { first: string; second: string; level: string }): { system: string; user: string } {
  const system = `You compare the difficulty of two ${args.level} problems. ${DIFFICULTY_CRITERIA}
Call emit_comparison with "harder": "first" or "second". If they are genuinely equal, pick the one you would expect fewer students to solve.`;
  return { system, user: `First problem:\n${stripChoices(args.first)}\n\nSecond problem:\n${stripChoices(args.second)}` };
}

export function buildLadderDifficultyPrompt(args: { problem: string; ladder: string[]; level: string }): { system: string; user: string } {
  const system = `You place a new ${args.level} problem on a difficulty ladder of real contest problems, which are listed from easiest (1) to hardest (${args.ladder.length}). ${DIFFICULTY_CRITERIA}
Call emit_placement with "harderThan": how many ladder problems the new problem is harder than (0 = easier than all of them, ${args.ladder.length} = harder than all of them).`;
  const user = `Ladder, easiest first:\n${args.ladder.map((s, i) => `${i + 1}. ${stripChoices(s)}`).join("\n\n")}\n\nNew problem:\n${stripChoices(args.problem)}`;
  return { system, user };
}

// Blind program solver (cascade program-solver.ts): a separate cheap call writes the
// answer-computing program from the statement ALONE, never seeing the writer's answer.
// Used when the writer itself shouldn't write the check: cheap writers asked for one
// worked the check out loud and leaked "wait, ..." corrections into 14 of 19 solutions.
export function buildProgramSolvePrompt(args: { problem: string; domain: string }): { system: string; user: string } {
  const system = `You solve a ${args.domain ? `${args.domain} ` : ""}problem by writing a short program that computes its answer. Read the problem, decide how to compute the answer from its givens (by formula, by solving, or by enumerating cases), and write the program. Do not explain.
${ANSWER_PROGRAM_LANGUAGE}
Call emit_program with "program".`;
  return { system, user: `Problem:\n${args.problem}` };
}

// Taxonomy slot selection (cascade generate.ts): which catalog types fit today's topic.
// Selection only, by number from a fixed list, so the model can't echo recent problems
// back as "new" types (the failure the two-call menu worked around); which of the
// fitting types a set actually uses, and excluding what recent sets used, is decided
// in code (lib/generation/taxonomy.ts).
export function buildTypeSelectionPrompt(args: { profile: string; topic: string; level: string; types: string[] }): { system: string; user: string } {
  const system = `You pick problem types for one student's practice set at ${args.level}. From the numbered catalog of real competition problem types, choose EVERY type that fits today's topic: a problem of that type would be practice on the topic. Leave out types that only touch the topic in passing. If the topic is broad, many types fit; if it is narrow, few do.
Call emit_selection with the chosen type numbers.`;
  const user = `Student profile: ${args.profile || "(not specified)"}\nToday's topic: ${args.topic || "(not specified; use the profile)"}\n\nCatalog:\n${args.types.map((t, i) => `${i}. ${t}`).join("\n")}`;
  return { system, user };
}

// Method-level dedup (cascade method-dedup.ts): do two problems need the same key idea?
// The definition the repetition eval groups by, applied per pair: surface dedup
// (shingles) can't see "rectangle area → quadratic" and "age problem → quadratic" as
// the same practice, and that pattern was the most repeated type in the evals.
export function buildSameMethodPrompt(args: { first: string; second: string }): { system: string; user: string } {
  const system = `You check a practice set for repetition. Two problems are the SAME practice when a student who has solved the first would solve the second with the same key idea and the same steps, and only the story, names or numbers differ. They are DIFFERENT when the second needs a genuinely different idea, a different kind of setup, or a meaningfully different technique.
Call emit_same with "same": true or false.`;
  return { system, user: `First problem:\n${args.first}\n\nSecond problem:\n${args.second}` };
}

// Reverse a real problem (cascade reverse.ts; ReverseMath, 2026): hide one given, make
// the seed's verified answer a given, ask for the hidden value. The new key is the
// hidden given, read off the seed rather than computed, so it is correct whenever the
// seed's key is and the reversal determines the value uniquely.
export function buildReversePrompt(args: {
  plan: GenerationPlan;
  seed: Anchor;
  avoidStatements?: string[];
  slot?: { index: number; of: number; hint: string };
}): { system: string; user: string } {
  const { plan, seed, avoidStatements, slot } = args;
  const system = `You write ONE free-response ${plan.competition ?? "competition"} problem by REVERSING a real problem whose answer is known.
1. Pick one given number N in the original that its answer depends on, such that knowing the original answer pins N down to exactly ONE value. If hiding a number would allow several values, pick another.
2. Write the new problem: the original answer becomes a stated fact, N is hidden, and the question asks for N. Re-dress it: new story, names and wording, the same mathematics. It must read as a natural problem, not as "the answer to this was ...".
3. The new answer is N itself. ${plan.competition === "AIME" ? "It must be an integer from 0 to 999." : ""}
4. Check by solving your new problem forward that N is the only value that works.
No answer choices, no figure references. Use $...$ for inline LaTeX and $$...$$ for display.
Call emit_problems with exactly one entry: "problem", "answer" (N only), "masked" (N exactly as written in the original), "method" (${METHOD_FIELD}), "solution" (a short forward solution of the NEW problem that a student can follow, ending with a line that states N), and "difficulty" (your estimate, e.g. "${plan.competition ?? "AIME"} #${seed.number ?? 10}").`;
  const avoid =
    avoidStatements && avoidStatements.length > 0
      ? `\nProblems already in this set (test something different):\n${avoidStatements.map((st, i) => `${i + 1}. ${st.slice(0, 200)}`).join("\n")}\n`
      : "";
  const place = slot ? `\nThis is problem ${slot.index + 1} of a ${slot.of}-problem set.\n` : "";
  const user = `Original problem (${seed.source}${seed.number != null ? ` #${seed.number}` : ""}):\n${stripChoices(seed.statement)}\n\nIts verified answer: ${seed.answer}\n${avoid}${place}\nWrite the reversed problem and call emit_problems.`;
  return { system, user };
}
