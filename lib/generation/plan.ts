// The generation PLAN — the single thing that decides how a set is generated, for
// every subject. It replaces the old two-engine split (a stored `generatorProfile`
// picked between a corpus pipeline and a corpus-free one), so nothing about the
// subject is stored on the student or chosen in the UI: the plan is derived per
// request from the student's free-text `profile` plus the session topic.
//
// Two ways a plan is produced:
//   1. FAST PATH (no model call) — the level text names a real competition, so
//      calibrationFor/tierFor/categoryFor settle everything deterministically and
//      the hand-tuned rubric comes from the static table. Contest students behave
//      exactly as they did before this file existed, and pay nothing for it.
//   2. MODEL PATH — one cheap, thinking-off Haiku call classifies the subject and
//      writes a short calibration rubric. That rubric is the per-subject analogue
//      of RUBRICS: for Spanish or AP Bio there are no corpus anchors to show the
//      model what "the right difficulty" looks like, and an explicit rubric is what
//      replaces them.
//
// Non-blocking, like every other auxiliary stage: any failure falls back to a
// deterministic plan. Generation never fails because planning failed.

import Anthropic from "@anthropic-ai/sdk";
import { calibrationFor, categoryFor, tierFor, type Competition } from "@/lib/calibration";
import { RUBRICS, buildPlanPrompt } from "@/lib/generation-prompt";

// Drives rendering hints and which similarity axes apply — a shared integer means
// something in two math problems and nothing in two Spanish exercises.
export type ContentType = "math" | "prose" | "code" | "mixed";

// What a valid `answer` looks like, so the verifier can enforce format without
// knowing anything about subjects. "open" is the only one that tolerates an empty
// answer (a writing prompt genuinely has none).
export type AnswerFormat = "integer" | "numeric" | "expression" | "short-text" | "open";

export type Tier = "easy" | "mid" | "hard";

export type GenerationPlan = {
  domain: string; // "Competition math (AIME)", "AP Biology", "Spanish"
  contentType: ContentType;
  tier: Tier;
  answerFormat: AnswerFormat;
  rubric: string; // what's too easy / on target / too hard, in prose
  // Non-null only when the corpus can actually help — this is what turns anchor
  // retrieval and the variant/adapt path on, in place of the old profile flag.
  competition: Competition | null;
  bandLow: number | null;
  bandHigh: number | null;
  category: string | null; // corpus retrieval filter
  source: "corpus" | "model" | "fallback"; // provenance, for the log line
};

const PLAN_TOOL: Anthropic.Tool = {
  name: "emit_plan",
  description: "Return the generation plan for this tutoring session.",
  input_schema: {
    type: "object",
    properties: {
      domain: {
        type: "string",
        description: "The subject being tutored, as specifically as the description supports, e.g. 'AP Biology', 'Spanish (intermediate)', 'Python'",
      },
      contentType: {
        type: "string",
        enum: ["math", "prose", "code", "mixed"],
        description: "The dominant form of the work: 'math' for symbolic/quantitative, 'prose' for language/humanities, 'code' for programming, 'mixed' otherwise",
      },
      tier: {
        type: "string",
        enum: ["easy", "mid"],
        description: "'mid' if the work demands multi-step reasoning or advanced/college-level material, 'easy' for introductory or drill-level practice",
      },
      answerFormat: {
        type: "string",
        enum: ["integer", "numeric", "expression", "short-text", "open"],
        description: "The form a correct answer takes: 'numeric' for a computed value, 'expression' for a symbolic result, 'short-text' for a word or phrase, 'open' ONLY when the work genuinely has no single answer (essays, discussion, free writing)",
      },
      rubric: {
        type: "string",
        description: "3-4 sentences calibrating difficulty for this exact student: what a too-easy problem looks like, what an on-target one looks like, and what would be above their level. Be concrete about the specific skills and content involved.",
      },
    },
    required: ["domain", "contentType", "tier", "answerFormat", "rubric"],
  },
};

// Difficulty fallback when the model path is off or fails. This is the whole of the
// old general engine's difficulty model, kept only as a floor under the plan call.
function keywordTier(text: string): Tier {
  const t = text.toLowerCase();
  if (
    /\b(advanced|expert|college|university|ap |a-level|honors|olympiad|competitive|proficient|fluent|hard)\b/.test(t)
  )
    return "mid";
  return "easy";
}

function fallbackPlan(profile: string, topic: string, source: "model" | "fallback"): GenerationPlan {
  return {
    domain: "",
    contentType: "mixed",
    tier: keywordTier(`${profile} ${topic}`),
    // Nothing was classified, so enforcing a format would drop valid work.
    answerFormat: "open",
    rubric: "",
    competition: null,
    bandLow: null,
    bandHigh: null,
    category: null,
    source,
  };
}

// AIME is the only contest whose answer format is unambiguous enough to hard-enforce.
// F=ma answers are symbolic (a lone symbol like E is legitimate), AMC is a computed value.
function competitionAnswerFormat(competition: Competition): AnswerFormat {
  if (competition === "AIME") return "integer";
  if (competition === "Fma") return "expression";
  return "numeric";
}

export async function planFor(args: {
  client: Anthropic;
  profile: string;
  topic: string;
  recentTopics: string[];
  recordUsage: (u: Anthropic.Usage) => void;
}): Promise<GenerationPlan> {
  const { client, profile, topic, recentTopics, recordUsage } = args;

  // --- Fast path: the corpus covers this student, so nothing needs classifying.
  const cal = calibrationFor({ profile });
  if (cal.competition) {
    return {
      domain: `Competition ${cal.competition === "Fma" ? "physics" : "math"} (${cal.competition})`,
      contentType: "math",
      tier: tierFor(cal),
      answerFormat: competitionAnswerFormat(cal.competition),
      rubric: RUBRICS[cal.competition] ?? "",
      competition: cal.competition,
      bandLow: cal.bandLow,
      bandHigh: cal.bandHigh,
      category: categoryFor(profile, topic),
      source: "corpus",
    };
  }

  if (process.env.GENERATION_NO_PLAN === "1") return fallbackPlan(profile, topic, "fallback");

  // --- Model path: one cheap classification + rubric call.
  const { system, user } = buildPlanPrompt({ profile, topic, recentTopics });
  try {
    const message = await client.messages.create({
      model: process.env.GENERATION_MODEL_PLAN ?? "claude-haiku-4-5",
      max_tokens: 1500,
      thinking: { type: "disabled" },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: [PLAN_TOOL],
      tool_choice: { type: "tool", name: "emit_plan" },
      messages: [{ role: "user", content: user }],
    });
    recordUsage(message.usage);
    const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const raw = (toolUse?.input ?? {}) as Record<string, unknown>;

    const str = (k: string): string => (typeof raw[k] === "string" ? (raw[k] as string).trim() : "");
    const oneOf = <T extends string>(k: string, allowed: readonly T[], dflt: T): T => {
      const v = str(k);
      return (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
    };

    const base = fallbackPlan(profile, topic, "model");
    const plan: GenerationPlan = {
      ...base,
      domain: str("domain"),
      contentType: oneOf("contentType", ["math", "prose", "code", "mixed"] as const, "mixed"),
      // The tool only offers easy/mid — "hard" means the corpus variant path, which
      // needs real seeds and is unreachable without a competition.
      tier: oneOf("tier", ["easy", "mid"] as const, base.tier),
      answerFormat: oneOf(
        "answerFormat",
        ["integer", "numeric", "expression", "short-text", "open"] as const,
        "open"
      ),
      rubric: str("rubric"),
    };
    console.log(
      `[/api/generate] plan domain="${plan.domain}" contentType=${plan.contentType} tier=${plan.tier} answerFormat=${plan.answerFormat} rubric=${plan.rubric.length}ch`
    );
    return plan;
  } catch (e) {
    console.warn(
      `[/api/generate] plan stage failed, using the keyword fallback: ${e instanceof Error ? e.message : String(e)}`
    );
    return fallbackPlan(profile, topic, "fallback");
  }
}
