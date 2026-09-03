// The independent answer solver. This is the correctness oracle the pipeline never
// had: it solves a generated problem from scratch, having seen only the statement
// and the plan's subject/rubric context — never the generator's answer, never the
// corpus seed. The generator's self-reported answer is downgraded from "the stored
// value" to "a hypothesis this confirms or refutes."
//
// Cheap-by-default agreement protocol (the plan's core cost control): solving every
// problem 3x on Opus would likely cost more than the entire prior pipeline.
//   1. One solve. Compare to the generator's answer with answersMatch (strict).
//      Agreement here is genuinely cross-family (generator on one vendor, solver on
//      Opus) and costs exactly one call.
//   2. Disagreement only → escalate, up to `maxEscalations` more solves. Escalation
//      is Opus-vs-Opus, i.e. NOT cross-family — two further Opus solves are
//      correlated samples, so "majority" here is confidence in Opus's own answer,
//      not independent verification. Reported as such in the outcome, not oversold.
//   3. No majority within the escalation budget → no-consensus. The caller drops
//      the item (refilled by the existing deficit loop) or ships it unverified,
//      never blocks the request — same non-blocking convention as every other
//      auxiliary stage in this pipeline.
//
// Non-blocking on error: a solver failure never fails generation. The caller ships
// the item with verdict "unverified" and the failure is recorded in genMeta.

import Anthropic from "@anthropic-ai/sdk";
import { buildSolvePrompt } from "@/lib/generation-prompt";
import { answersMatch } from "@/lib/generation/answer-match";
import type { AnswerFormat } from "@/lib/generation/plan";

const SOLVE_TOOL: Anthropic.Tool = {
  name: "emit_solve",
  description: "Return the solved answer for this problem.",
  input_schema: {
    type: "object",
    properties: {
      answer: { type: "string", description: "Final answer only — no working" },
      ambiguous: {
        type: "boolean",
        description: "true only if the problem itself is genuinely ill-posed or unanswerable as stated",
      },
      note: { type: "string", description: "Brief reason, only meaningful when ambiguous is true" },
    },
    required: ["answer", "ambiguous"],
  },
};

export type SolveOutcome =
  | { kind: "not-applicable" } // answerFormat is "open" — nothing to solve against
  | { kind: "answer"; answer: string; agreesWithGenerator: boolean; crossFamily: boolean; attempts: number }
  | { kind: "no-consensus"; attempts: number }
  | { kind: "ambiguous"; attempts: number; note: string }
  | { kind: "error"; attempts: number; message: string };

async function solveOnce(
  client: Anthropic,
  model: string,
  effort: "low" | "medium" | "high",
  prompt: { system: string; user: string },
  recordUsage: (u: Anthropic.Usage) => void
): Promise<{ answer: string; ambiguous: boolean; note: string }> {
  // output_config is an extension field not yet in the SDK's params typing — same
  // cast-the-whole-object-at-the-call-boundary pattern as call-tool.ts's callTool,
  // rather than mislabeling the object as Anthropic.MessageCreateParamsNonStreaming
  // up front (an inline `output_config` on a strictly-typed literal fails TS's
  // excess-property check even with a `never` cast on the value).
  const params = {
    model,
    max_tokens: 4000,
    thinking: { type: "adaptive" as const },
    output_config: { effort },
    system: [{ type: "text" as const, text: prompt.system, cache_control: { type: "ephemeral" as const } }],
    tools: [SOLVE_TOOL],
    tool_choice: { type: "auto" as const }, // forced tool + thinking is a 400, same constraint as the Sonnet tiers
    messages: [{ role: "user" as const, content: prompt.user }],
  };
  const message = await client.messages.create(
    params as unknown as Anthropic.MessageCreateParamsNonStreaming
  );
  recordUsage(message.usage);
  if (message.stop_reason === "max_tokens") throw new Error("truncated");
  const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!toolUse) throw new Error("no_tool");
  const raw = toolUse.input as { answer?: unknown; ambiguous?: unknown; note?: unknown };
  return {
    answer: typeof raw.answer === "string" ? raw.answer : "",
    ambiguous: raw.ambiguous === true,
    note: typeof raw.note === "string" ? raw.note : "",
  };
}

export async function solveProblem(args: {
  client: Anthropic;
  model: string;
  escalateModel: string;
  effort: "low" | "medium" | "high";
  problem: string;
  domain: string;
  rubric: string;
  answerFormat: AnswerFormat;
  generatorAnswer: string;
  maxEscalations: number;
  recordUsage: (u: Anthropic.Usage) => void;
}): Promise<SolveOutcome> {
  const {
    client,
    model,
    escalateModel,
    effort,
    problem,
    domain,
    rubric,
    answerFormat,
    generatorAnswer,
    maxEscalations,
    recordUsage,
  } = args;

  if (answerFormat === "open") return { kind: "not-applicable" };

  const prompt = buildSolvePrompt({ problem, domain, rubric, answerFormat });
  let attempts = 0;
  const solverAnswers: string[] = [];

  try {
    // Round 1 — genuinely cross-family (the generator is on a different vendor).
    const first = await solveOnce(client, model, effort, prompt, recordUsage);
    attempts++;
    if (first.ambiguous) return { kind: "ambiguous", attempts, note: first.note };
    solverAnswers.push(first.answer);

    if (answersMatch(first.answer, generatorAnswer, { format: answerFormat, strictness: "strict" })) {
      return { kind: "answer", answer: first.answer, agreesWithGenerator: true, crossFamily: true, attempts };
    }

    // Disagreement — escalate. Every escalation attempt is Opus solving again, so
    // this is Opus self-consistency, not further cross-family confirmation.
    while (attempts < 1 + maxEscalations) {
      const next = await solveOnce(client, escalateModel, "high", prompt, recordUsage);
      attempts++;
      if (next.ambiguous) return { kind: "ambiguous", attempts, note: next.note };
      solverAnswers.push(next.answer);

      // Majority among solver attempts so far (Opus-vs-Opus from here on).
      const counts = new Map<string, number>();
      for (const a of solverAnswers) {
        const key = a.trim().toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const majority = [...counts.entries()].find(([, n]) => n > solverAnswers.length / 2);
      if (majority) {
        const majorityAnswer = solverAnswers.find((a) => a.trim().toLowerCase() === majority[0])!;
        return {
          kind: "answer",
          answer: majorityAnswer,
          agreesWithGenerator: answersMatch(majorityAnswer, generatorAnswer, {
            format: answerFormat,
            strictness: "strict",
          }),
          crossFamily: false,
          attempts,
        };
      }
    }

    return { kind: "no-consensus", attempts };
  } catch (e) {
    return { kind: "error", attempts, message: e instanceof Error ? e.message : String(e) };
  }
}
