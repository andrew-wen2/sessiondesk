// Lesson generation — a structured teaching artifact (objectives, explanation,
// worked examples, practice) for one session. Works for any subject; the corpus
// pipeline is not involved (a lesson is generative teaching content, not calibrated
// contest problems). One tool-forced call via the shared emit_lesson tool.
//
// It does share the problem pipeline's PLAN, so a lesson is calibrated by the same
// inferred domain and difficulty rubric the problems are — previously this path was
// entirely subject-blind and got nothing but the raw level text.

import Anthropic from "@anthropic-ai/sdk";
import type { Lesson } from "@/lib/types";
import type { GenerationPlan } from "@/lib/generation/plan";
import { callGeminiWithRetry, geminiClient } from "@/lib/generation/gemini-call";
import { callOpenWeightWithRetry } from "@/lib/generation/openweight-stage";
import { providerForStage, geminiModelFor, anthropicModelFor, stageModel } from "@/lib/generation/config";

export type LessonInput = {
  profile: string; // the student's free-text profile (subject + level + goals)
  topic: string;
  recentTopics: string[];
  plan: GenerationPlan;
};

const LESSON_TOOL: Anthropic.Tool = {
  name: "emit_lesson",
  description: "Return a structured lesson for the session.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short lesson title" },
      objectives: {
        type: "array",
        items: { type: "string" },
        description: "2–5 concrete things the student should be able to do afterward",
      },
      sections: {
        type: "array",
        description: "The explanation, broken into ordered sections",
        items: {
          type: "object",
          properties: {
            heading: { type: "string" },
            content: { type: "string", description: "Explanation prose; LaTeX in $...$/$$...$$, code in ```fences```" },
          },
          required: ["heading", "content"],
        },
      },
      workedExamples: {
        type: "array",
        description: "2–4 fully worked examples the tutor can walk through",
        items: {
          type: "object",
          properties: {
            problem: { type: "string" },
            solution: { type: "string", description: "Step-by-step worked solution" },
          },
          required: ["problem", "solution"],
        },
      },
      practice: {
        type: "array",
        description: "3–6 practice problems for the student to try",
        items: {
          type: "object",
          properties: {
            problem: { type: "string" },
            answer: { type: "string", description: "Final answer; empty string if open-ended" },
            solution: { type: "string" },
          },
          required: ["problem", "answer", "solution"],
        },
      },
    },
    required: ["title", "objectives", "sections", "workedExamples", "practice"],
  },
};

const LESSON_SYSTEM = `You are an expert tutor writing a single lesson to teach one student one topic.

Produce a lesson that a tutor can teach from directly:
- Objectives: 2–5 concrete, checkable skills the student should have by the end.
- Sections: a clear, well-sequenced explanation built up from what the student likely already knows. Define terms; give intuition before formalism.
- Worked examples: 2–4 examples worked in full, showing the reasoning a tutor would narrate.
- Practice: 3–6 problems for the student to attempt, each with an answer (empty string if the task is open-ended) and a solution.

Calibrate difficulty to the stated level exactly. Write mathematics in LaTeX ($...$ inline, $$...$$ display; never \\( \\) or \\[ \\]). Write code in fenced blocks (\`\`\`lang … \`\`\`). No figures, diagrams, or "as shown" references — everything must be expressible in text.

Return the lesson by calling the emit_lesson tool. Write nothing outside the tool call.`;

function buildLessonPrompt(input: LessonInput): { system: string; user: string } {
  const { profile, topic, recentTopics, plan } = input;
  // The rubric goes in the SYSTEM block: it's stable for this student + topic, so it
  // stays cacheable, and it's the same difficulty standard the problem set is held to.
  const system = plan.rubric ? `${LESSON_SYSTEM}\n\nDifficulty calibration for this student:\n${plan.rubric}` : LESSON_SYSTEM;
  const lines: string[] = [];
  if (plan.domain) lines.push(`Subject: ${plan.domain}`);
  lines.push(`Student profile: ${profile || "(unspecified)"}`);
  lines.push(`Lesson topic: ${topic.trim() || "(choose an appropriate next topic for this level)"}`);
  if (recentTopics.length > 0) {
    lines.push(`Recently covered (build on these, don't repeat): ${recentTopics.join("; ")}`);
  }
  lines.push("");
  lines.push("Write the lesson and return it via emit_lesson.");
  return { system, user: lines.join("\n") };
}

function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// Validate the tool output into a Lesson, dropping malformed sub-items rather than
// failing the whole lesson. Throws only if the top-level shape is unusable.
function validateLesson(raw: unknown): Lesson {
  if (!raw || typeof raw !== "object") throw new Error("Lesson output was empty");
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === "string" ? o.title : "";
  const objectives = isNonEmptyStringArray(o.objectives) ? o.objectives : [];
  const sections = Array.isArray(o.sections)
    ? o.sections
        .map((s) => s as Record<string, unknown>)
        .filter((s) => typeof s.heading === "string" && typeof s.content === "string")
        .map((s) => ({ heading: s.heading as string, content: s.content as string }))
    : [];
  const workedExamples = Array.isArray(o.workedExamples)
    ? o.workedExamples
        .map((s) => s as Record<string, unknown>)
        .filter((s) => typeof s.problem === "string" && typeof s.solution === "string")
        .map((s) => ({ problem: s.problem as string, solution: s.solution as string }))
    : [];
  const practice = Array.isArray(o.practice)
    ? o.practice
        .map((s) => s as Record<string, unknown>)
        .filter((s) => typeof s.problem === "string" && typeof s.solution === "string")
        .map((s) => ({
          problem: s.problem as string,
          answer: typeof s.answer === "string" ? s.answer : "",
          solution: s.solution as string,
        }))
    : [];
  if (sections.length === 0 && workedExamples.length === 0 && practice.length === 0) {
    throw new Error("Lesson output had no usable content");
  }
  return { title, objectives, sections, workedExamples, practice };
}

// A full lesson is one long non-streaming reply; this bounds it well inside the lesson
// route's function limit instead of the open-weight caller's classification-sized default.
const LESSON_TIMEOUT_MS = 240_000;

export type LessonResult = { ok: true; lesson: Lesson } | { ok: false; error: string };

export async function generateLesson(opts: {
  client: Anthropic;
  input: LessonInput;
  recordUsage: (u: Anthropic.Usage) => void;
}): Promise<LessonResult> {
  const { client, input, recordUsage } = opts;
  // Lessons favor quality regardless of tier — a teaching artifact for a beginner is
  // not a cheaper job than one for an advanced student — so this stays on the mid
  // (Sonnet) model rather than following plan.tier down to Haiku. Env-overridable.
  const model = anthropicModelFor("lesson");
  const provider = providerForStage("lesson");
  const { system, user } = buildLessonPrompt(input);
  console.log(
    `[/api/generate-lesson] plan=${input.plan.source} domain="${input.plan.domain}" tier=${input.plan.tier} provider=${provider} model=${stageModel("lesson", model)}`
  );

  try {
    if (provider === "openweight") {
      const lesson = await callOpenWeightWithRetry(
        stageModel("lesson", model),
        system,
        user,
        {
          functionName: "emit_lesson",
          functionDescription: LESSON_TOOL.description ?? "",
          parametersJsonSchema: LESSON_TOOL.input_schema,
          maxOutputTokens: 16000,
          thinking: "off",
          timeoutMs: LESSON_TIMEOUT_MS,
        },
        validateLesson,
        recordUsage
      );
      return { ok: true, lesson };
    }
    if (provider === "gemini") {
      const lesson = await callGeminiWithRetry(
        geminiClient(),
        geminiModelFor("lesson"),
        system,
        user,
        {
          functionName: "emit_lesson",
          functionDescription: LESSON_TOOL.description ?? "",
          parametersJsonSchema: LESSON_TOOL.input_schema,
          maxOutputTokens: 16000,
          thinkingLevel: "low",
        },
        validateLesson,
        recordUsage
      );
      return { ok: true, lesson };
    }
    // Thinking off + forced tool + non-streaming: a single structured lesson is
    // well within one call's budget, and forcing the tool guarantees it fires.
    const message = (await client.messages.create({
      model,
      max_tokens: 16000,
      thinking: { type: "disabled" },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: [LESSON_TOOL],
      tool_choice: { type: "tool", name: "emit_lesson" },
      messages: [{ role: "user", content: user }],
    })) as Anthropic.Message;
    recordUsage(message.usage);
    if (message.stop_reason === "max_tokens") return { ok: false, error: "Lesson was too long — try a narrower topic." };
    const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUse) return { ok: false, error: "Generation failed — try again." };
    return { ok: true, lesson: validateLesson(toolUse.input) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[/api/generate-lesson] generation failed:", msg);
    return {
      ok: false,
      error:
        msg === "truncated"
          ? "Lesson was too long — try a narrower topic."
          : msg === "filtered"
            ? "Lesson generation was blocked by a content filter — try a different topic or try again."
            : "Generation failed — try again.",
    };
  }
}
