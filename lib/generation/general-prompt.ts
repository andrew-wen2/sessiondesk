// Prompt text for the corpus-free "general" profile (any subject). Mirrors the
// system/user split of lib/generation-prompt.ts so the stable system block is
// prompt-cached across a student's repeat generations, but carries none of the
// competition-math rubric/anchor machinery — the model generates from the subject
// + level description alone.

export type GeneralPromptInput = {
  subject: string; // e.g. "Spanish", "AP Physics", "Python"
  level: string; // free-text level/goals
  topic: string; // what this session covers
  count: number;
  recentTopics: string[]; // last few non-empty topics, for continuity + variety
};

// Stable across a student's generations (no count / topic-specific text) → cached.
const GENERAL_SYSTEM = `You are an expert tutor generating practice problems calibrated to one student.

Rules for every problem you emit:
- Generate FREE-RESPONSE problems only — never multiple-choice; never include answer options like "(A) … (E)".
- Each problem must be fully self-contained in text: no figures, diagrams, images, or "as shown" references (they can't be rendered).
- Match the subject and the student's stated level exactly — not easier, not harder.
- Provide a correct, final \`answer\` for problems that have one. For open-ended work (e.g. a writing or discussion prompt) the answer may be empty, but still give a model \`solution\` / exemplar.
- Provide a concise \`solution\` that shows the reasoning or worked steps a tutor would walk through — no thinking-out-loud, no self-correction ("wait, actually…"), no backtracking.

Formatting:
- Write mathematics in LaTeX using dollar delimiters: $...$ inline, $$...$$ for display. Never use \\( \\) or \\[ \\].
- Write code inside fenced blocks: triple backticks with a language tag, e.g. \`\`\`python … \`\`\`.
- Everything else is plain prose.

Return the problems by calling the emit_problems tool. Do not write anything outside the tool call.`;

export function buildGeneralProblemPrompt(input: GeneralPromptInput): { system: string; user: string } {
  const { subject, level, topic, count, recentTopics } = input;
  const lines: string[] = [];
  lines.push(`Subject: ${subject || "(unspecified — infer from the level description)"}`);
  lines.push(`Student level / goals: ${level || "(unspecified)"}`);
  if (topic.trim()) lines.push(`Focus for this session: ${topic.trim()}`);
  if (recentTopics.length > 0) {
    lines.push(
      `Recently covered (build on these for continuity, but don't repeat the same problems): ${recentTopics.join("; ")}`
    );
  }
  lines.push("");
  lines.push(
    `Generate ${count} distinct practice problems that fit the subject and level above. Vary the sub-skills so the set isn't repetitive. Call emit_problems with all ${count}.`
  );
  return { system: GENERAL_SYSTEM, user: lines.join("\n") };
}
