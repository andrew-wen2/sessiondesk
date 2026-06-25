// STAGE 3 (adapt path) — solution expansion. The heavy generation pass emits only a
// terse `solutionSketch`; this turns each sketch into a full student-facing solution
// using a cheap, thinking-disabled model (Haiku) in a single batched, forced-tool call.
// Prompt text lives in lib/generation-prompt.ts (buildExpandPrompt); the tool schema
// lives here with the call. Non-blocking: on any failure each item falls back to its
// own sketch, so `solution` is always a non-empty string.

import Anthropic from "@anthropic-ai/sdk";
import type { SketchItem } from "@/lib/generation-prompt";

const SOLUTIONS_TOOL: Anthropic.Tool = {
  name: "emit_solutions",
  description: "Return the expanded student-facing solutions, index-aligned to the items.",
  input_schema: {
    type: "object",
    properties: {
      solutions: {
        type: "array",
        items: {
          type: "string",
          description: "Full worked solution for one item, LaTeX in $...$ / $$...$$",
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
  try {
    const message = await client.messages.create({
      model,
      // Headroom matters: math-heavy worked solutions run long, and on truncation the
      // forced tool call is cut off → toolUse is undefined → every item silently falls
      // back to its terse sketch. Size generously (Haiku is cheap) and log truncation.
      max_tokens: Math.min(16000, 1500 + items.length * 1400),
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
    const raw = toolUse?.input as { solutions?: unknown } | undefined;
    const out = raw && Array.isArray(raw.solutions) ? raw.solutions : [];
    // Index-aligned; fall back to the sketch for any missing/short/non-string entry.
    return items.map((it, i) => {
      const s = out[i];
      return typeof s === "string" && s.trim() ? s : it.solutionSketch;
    });
  } catch (e) {
    console.warn(
      `[/api/generate] expansion failed, using sketches: ${e instanceof Error ? e.message : String(e)}`
    );
    return items.map((it) => it.solutionSketch);
  }
}
