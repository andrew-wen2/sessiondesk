// The problem-generation prompt. This file is the product — keep ALL prompt
// logic here, nowhere else. Iterate it via commits: `prompt: <what changed>`.

export type GenerationAnchor = {
  source: string;
  number: number | null;
  statement: string;
  answer: string | null;
};

export type GenerationInput = {
  subject: string;
  level: string;
  topic: string;
  count: number;
  recentTopics: string[]; // last N session topics, most recent first
  book?: { title: string; contents: string }; // assigned book for this session, if any
  competition?: string; // "AMC10" | "AMC12" | "AIME" | "Fma" — selects the difficulty rubric
  anchors?: GenerationAnchor[]; // real same-difficulty problems retrieved from the corpus
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

export function buildPrompt(input: GenerationInput): string {
  const { subject, level, topic, count, recentTopics, book, competition, anchors } = input;

  const historyBlock =
    recentTopics.length > 0
      ? `Recent session topics (most recent first — do NOT repeat these, build on them):\n${recentTopics
          .map((t, i) => `${i + 1}. ${t}`)
          .join("\n")}`
      : "No prior session history — this is the student's first session.";

  const bookBlock =
    book && book.contents.trim()
      ? `\nAssigned book: ${book.title}. Today's topic above names chapters from this book. Use the chapter contents below to determine exactly what those chapters cover, and generate problems on those topics.\n\nBook contents:\n${book.contents}\n`
      : book
        ? `\nAssigned book: ${book.title}. Today's topic above may name chapters from it — generate problems matching those chapters.\n`
        : "";

  const rubric = competition && RUBRICS[competition] ? `\n${RUBRICS[competition]}\n` : "";

  const anchorBlock =
    anchors && anchors.length > 0
      ? `\nReference problems at the EXACT target difficulty — these are real problems of the level you must hit. Match their difficulty and style precisely. Do NOT copy, reword, or trivially reskin them; produce genuinely new problems of equivalent difficulty. (Some are from multiple-choice contests; their A–E choices have been removed and you must NOT reproduce any answer-choice list — generate free-response.):\n${anchors
          .map(
            (a, i) =>
              `${i + 1}. [${a.source}${a.number != null ? ` #${a.number}` : ""}] ${stripChoices(a.statement)}${
                a.answer ? ` (answer: ${a.answer})` : ""
              }`
          )
          .join("\n")}\n`
      : "";

  return `You are generating competition math/physics practice problems for a one-on-one tutoring session.

Student profile:
- Subject: ${subject}
- Level: ${level}
- Today's topic: ${topic || "(not specified — use the subject and level to choose appropriate problems)"}

${historyBlock}
${bookBlock}${rubric}${anchorBlock}
Generate exactly ${count} fully-solved problem(s) — not fewer. Requirements:
- Difficulty must match the calibration and the reference problems above EXACTLY — not easier, not harder. This is the most important requirement.
- Order the set from easiest to hardest, strictly increasing in difficulty across all ${count} problem(s). Every problem is a genuinely difficult competition-style problem — no warm-ups or routine one-idea problems. The back half especially must be hard enough that the student cannot solve them without help.
- You MUST fully solve every problem yourself. The "answer" field holds the REAL computed final answer and the "solution" field a REAL worked solution. NEVER output placeholders like "tbd", "TODO", "?", or "see solution". If you cannot solve a problem completely and correctly, discard it and produce a different problem at the SAME difficulty that you can fully solve — better a solid problem you can verify than a harder one you can't.
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
- The final five problems (or as many as exist if ${count} < 5) must each require at least three distinct reasoning steps, must NOT be solvable by a single standard formula or observation, and must reward deeper problem-solving and the synthesis of multiple ideas.
- Solutions must be concise (3–8 lines). Show key steps only.
- Math notation: use $...$ for inline LaTeX, $$...$$ for display LaTeX.
- Build on recent topics rather than repeating them.

Before emitting, verify: every problem is correct; the set is strictly increasing in difficulty; every solution is complete and mathematically sound; no two problems test a duplicate concept or are excessively similar. Fix any failure before returning.

Return all ${count} problem(s) through the emit_problems tool — one entry per problem.`;
}
