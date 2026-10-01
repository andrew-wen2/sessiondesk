// STAGE 3 (adapt path) — solution expansion. The heavy generation pass emits only a
// terse `solutionSketch`; this turns each sketch into a full student-facing solution
// using a cheap, thinking-disabled model (Haiku) in a single batched, forced-tool call.
// Prompt text lives in lib/generation-prompt.ts (buildExpandPrompt); the tool schema
// lives here with the call. Non-blocking: on any failure each item falls back to its
// own sketch, so `solution` is always a non-empty string.

import Anthropic from "@anthropic-ai/sdk";
import type { SketchItem } from "@/lib/generation-prompt";
import { callGeminiWithRetry, geminiClient } from "@/lib/generation/gemini-call";
import { callOpenWeightWithRetry } from "@/lib/generation/openweight-stage";
import { providerForStage, geminiModelFor, openweightModelFor } from "@/lib/generation/config";

function solutionsByIndex(raw: unknown): Map<number, string> {
  const out = Array.isArray((raw as { solutions?: unknown })?.solutions) ? (raw as { solutions: unknown[] }).solutions : [];
  const byIndex = new Map<number, string>();
  for (const entry of out) {
    const e = entry as { index?: unknown; solution?: unknown };
    if (typeof e?.index === "number" && typeof e?.solution === "string" && e.solution.trim()) {
      byIndex.set(e.index, e.solution);
    }
  }
  return byIndex;
}

// Keyed by `index`, not a bare positional array (Eng finding, both call-tool
// review passes): a model omitting one entry from a plain string[] silently
// re-attaches every LATER solution to the WRONG problem, undetectably. Requiring
// each entry to echo its own index means a gap is a gap, not a shift.
const SOLUTIONS_TOOL: Anthropic.Tool = {
  name: "emit_solutions",
  description: "Return the expanded student-facing solutions, one entry per item.",
  input_schema: {
    type: "object",
    properties: {
      solutions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "The item's position in the input list, 0-based" },
            solution: { type: "string", description: "Full worked solution for this item, LaTeX in $...$ / $$...$$" },
          },
          required: ["index", "solution"],
        },
      },
    },
    required: ["solutions"],
  },
};

export async function expandSolutions(
  client: Anthropic,
  model: string,
  items: SketchItem[],
  build: (items: SketchItem[]) => { system: string; user: string },
  recordUsage: (u: Anthropic.Usage) => void
): Promise<string[]> {
  if (items.length === 0) return [];
  const { system, user } = build(items);
  const maxOutputTokens = Math.min(16000, 1500 + items.length * 1400);
  try {
    let byIndex: Map<number, string>;
    const provider = providerForStage("expand");
    if (provider === "openweight") {
      byIndex = await callOpenWeightWithRetry(
        openweightModelFor("expand"),
        system,
        user,
        {
          functionName: "emit_solutions",
          functionDescription: SOLUTIONS_TOOL.description ?? "",
          parametersJsonSchema: SOLUTIONS_TOOL.input_schema,
          maxOutputTokens,
          thinking: "off",
          timeoutMs: 120_000,
        },
        solutionsByIndex,
        recordUsage
      );
    } else if (provider === "gemini") {
      byIndex = await callGeminiWithRetry(
        geminiClient(),
        geminiModelFor("expand"),
        system,
        user,
        {
          functionName: "emit_solutions",
          functionDescription: SOLUTIONS_TOOL.description ?? "",
          parametersJsonSchema: SOLUTIONS_TOOL.input_schema,
          maxOutputTokens,
          thinkingLevel: "low",
        },
        solutionsByIndex,
        recordUsage
      );
    } else {
      // Headroom matters: math-heavy worked solutions run long, and on truncation the
      // forced tool call is cut off → toolUse is undefined → every item silently falls
      // back to its terse sketch. Size generously (Haiku is cheap) and log truncation.
      const message = await client.messages.create({
        model,
        max_tokens: maxOutputTokens,
        thinking: { type: "disabled" },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: [SOLUTIONS_TOOL],
        tool_choice: { type: "tool", name: "emit_solutions" },
        messages: [{ role: "user", content: user }],
      });
      recordUsage(message.usage);
      const eu = message.usage;
      console.log(
        `[/api/generate] expand call input=${eu.input_tokens} output=${eu.output_tokens} thinking=${eu.output_tokens_details?.thinking_tokens ?? 0}`
      );
      if (message.stop_reason === "max_tokens") {
        console.warn(
          `[/api/generate] expand truncated (max_tokens) — some/all of ${items.length} items fall back to sketches`
        );
      }
      const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      byIndex = solutionsByIndex(toolUse?.input);
    }
    return items.map((it, i) => byIndex.get(i) ?? it.solutionSketch);
  } catch (e) {
    console.warn(
      `[/api/generate] expansion failed, using sketches: ${e instanceof Error ? e.message : String(e)}`
    );
    return items.map((it) => it.solutionSketch);
  }
}
