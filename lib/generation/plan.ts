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
import { callGeminiWithRetry, geminiClient } from "@/lib/generation/gemini-call";
import { providerForStage, geminiModelFor } from "@/lib/generation/config";

// Drives rendering hints and which similarity axes apply — a shared integer means
// something in two math problems and nothing in two Spanish exercises.
export type ContentType = "math" | "prose" | "code" | "mixed";

// What a valid `answer` looks like, so the verifier can enforce format without
// knowing anything about subjects. "open" is the only one that tolerates an empty
// answer (a writing prompt genuinely has none).
export type AnswerFormat = "integer" | "numeric" | "expression" | "short-text" | "open";

export const ANSWER_FORMATS: readonly AnswerFormat[] = [
  "integer",
  "numeric",
  "expression",
  "short-text",
  "open",
];

// genMeta stores answerFormat as a bare `string` and parseGenMeta is an unchecked cast,
// so anything reading it back needs to narrow rather than trust it.
export function isAnswerFormat(raw: unknown): raw is AnswerFormat {
  return typeof raw === "string" && (ANSWER_FORMATS as readonly string[]).includes(raw);
}

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
        // "hard" WAS unreachable here on purpose — it used to mean "the corpus
        // variant path," which needs real seeds no non-contest student has. Now
        // that lib/generation/solve.ts verifies every tier's answer independently,
        // "hard" just means "generate from scratch at the top of this student's
        // difficulty," and problems.ts falls back to the scratch (non-variant) path
        // whenever there's no corpus to anchor a variant to. See Eng review: the
        // real defect was never tierFor (only reached on the corpus fast path) —
        // it was this enum capping every non-contest student below the tier that
        // used to gate verification. Verification is no longer tier-gated, but a
        // non-contest student choosing genuinely hard material should still be able
        // to say so.
        enum: ["easy", "mid", "hard"],
        description: "'hard' for material demanding sustained multi-step reasoning at an advanced/competition-adjacent level, 'mid' for solid multi-step work, 'easy' for introductory or drill-level practice",
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
    // NOT "open" (Eng E5 / Evidence: "plan failure silently disables answer
    // validation"). answerOkFor auto-passes an EMPTY answer whenever the format is
    // "open" — so if this ran on every plan failure, one flaky classification call
    // would turn the answer guard off for the whole set, and for an AIME student
    // that's a silent downgrade to ungradeable with nothing telling anyone. "open"
    // is reserved for genuinely-classified open-ended work (an essay prompt); a
    // FAILURE to classify is not evidence the work has no answer. "short-text"
    // still imposes no shape beyond "real, non-placeholder, non-empty" — the
    // correct floor when nothing is known.
    answerFormat: "short-text",
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
//
// Exported because grading a student's typed answer needs the SAME derivation the
// generator used, and genMeta cannot always supply it: every row written before the
// genMeta migration reads null, and the pipeline's own failure path writes an empty
// string (problems.ts). Falling back to a hardcoded "integer" would be a guess that
// happens to be right most of the time — this is the real answer.
export function competitionAnswerFormat(competition: Competition): AnswerFormat {
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
  const parseRawPlan = (raw: Record<string, unknown>): GenerationPlan => {
    const str = (k: string): string => (typeof raw[k] === "string" ? (raw[k] as string).trim() : "");
    const oneOf = <T extends string>(k: string, allowed: readonly T[], dflt: T): T => {
      const v = str(k);
      return (allowed as readonly string[]).includes(v) ? (v as T) : dflt;
    };
    const base = fallbackPlan(profile, topic, "model");
    return {
      ...base,
      domain: str("domain"),
      contentType: oneOf("contentType", ["math", "prose", "code", "mixed"] as const, "mixed"),
      tier: oneOf("tier", ["easy", "mid", "hard"] as const, base.tier),
      // Falls back to "short-text", not "open" — same reasoning as fallbackPlan: a
      // malformed/off-enum classification is not evidence the work has no answer.
      answerFormat: oneOf(
        "answerFormat",
        ["integer", "numeric", "expression", "short-text", "open"] as const,
        "short-text"
      ),
      rubric: str("rubric"),
    };
  };

  try {
    let raw: Record<string, unknown>;
    if (providerForStage("plan") === "gemini") {
      raw = await callGeminiWithRetry(
        geminiClient(),
        geminiModelFor("plan"),
        system,
        user,
        {
          functionName: "emit_plan",
          functionDescription: "Return the generation plan for this tutoring session.",
          parametersJsonSchema: PLAN_TOOL.input_schema,
          maxOutputTokens: 1500,
          thinkingLevel: "low",
        },
        (r) => r as Record<string, unknown>,
        recordUsage
      );
    } else {
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
      raw = (toolUse?.input ?? {}) as Record<string, unknown>;
    }

    const plan = parseRawPlan(raw);
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
