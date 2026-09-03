// STAGE A (adapt path) — seed-sketch. Distills each seed's REAL corpus solution into a
// terse numbered step-by-step sketch using a cheap, thinking-disabled model (Haiku) in a
// single batched, forced-tool call. The transpose stage then mutates that skeleton
// instead of re-reading the prose solution — which is what suppresses the heavy
// re-derivation. Prompt text lives in lib/generation-prompt.ts (buildSeedSketchPrompt);
// the tool schema lives here with the call. Non-blocking: on any failure the seeds keep
// their prose solution and the transpose stage falls back to the old framing.

import Anthropic from "@anthropic-ai/sdk";
import type { SeedItem } from "@/lib/generation-prompt";
import { callGeminiWithRetry, geminiClient } from "@/lib/generation/gemini-call";
import { providerForStage, geminiModelFor } from "@/lib/generation/config";

// Shared by both providers: the tool/function always returns {sketches:[{index,sketch}]},
// keyed by the model's own echoed index (see SEED_SKETCH_TOOL's comment).
function sketchesByIndex(raw: unknown): Map<number, string> {
  const out = Array.isArray((raw as { sketches?: unknown })?.sketches) ? (raw as { sketches: unknown[] }).sketches : [];
  const byIndex = new Map<number, string>();
  for (const entry of out) {
    const e = entry as { index?: unknown; sketch?: unknown };
    if (typeof e?.index === "number" && typeof e?.sketch === "string" && e.sketch.trim()) {
      byIndex.set(e.index, e.sketch);
    }
  }
  return byIndex;
}

// Keyed by `index`, not a bare positional array — same correctness fix as
// expand.ts's SOLUTIONS_TOOL. An omitted sketch here would otherwise silently
// re-attach every later sketch to the wrong seed.
const SEED_SKETCH_TOOL: Anthropic.Tool = {
  name: "emit_seed_sketches",
  description: "Return one step-by-step solution sketch per seed.",
  input_schema: {
    type: "object",
    properties: {
      sketches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "The seed's position in the input list, 0-based" },
            sketch: {
              type: "string",
              description: "Numbered step-by-step sketch of this seed's solution, LaTeX in $...$ / $$...$$",
            },
          },
          required: ["index", "sketch"],
        },
      },
    },
    required: ["sketches"],
  },
};

// Returns sketches index-aligned to `items`; an empty string for any item the model
// omitted or returned non-string, so callers can fall back to that seed's prose solution.
export async function sketchSeeds(
  client: Anthropic,
  model: string,
  items: SeedItem[],
  build: (items: SeedItem[]) => { system: string; user: string },
  recordUsage: (u: Anthropic.Usage) => void
): Promise<string[]> {
  if (items.length === 0) return [];
  const { system, user } = build(items);
  try {
    let byIndex: Map<number, string>;
    if (providerForStage("seedSketch") === "gemini") {
      byIndex = await callGeminiWithRetry(
        geminiClient(),
        geminiModelFor("seedSketch"),
        system,
        user,
        {
          functionName: "emit_seed_sketches",
          functionDescription: SEED_SKETCH_TOOL.description ?? "",
          parametersJsonSchema: SEED_SKETCH_TOOL.input_schema,
          maxOutputTokens: Math.min(12000, 1000 + items.length * 700),
          thinkingLevel: "low",
        },
        sketchesByIndex,
        recordUsage
      );
    } else {
      const message = await client.messages.create({
        model,
        max_tokens: Math.min(12000, 1000 + items.length * 700),
        thinking: { type: "disabled" },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: [SEED_SKETCH_TOOL],
        tool_choice: { type: "tool", name: "emit_seed_sketches" },
        messages: [{ role: "user", content: user }],
      });
      recordUsage(message.usage);
      console.log(
        `[/api/generate] seed-sketch call input=${message.usage.input_tokens} output=${message.usage.output_tokens} stop=${message.stop_reason}`
      );
      const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      byIndex = sketchesByIndex(toolUse?.input);
    }
    console.log(`[/api/generate] seed-sketch sketches=${byIndex.size}/${items.length}`);
    return items.map((_, i) => byIndex.get(i) ?? "");
  } catch (e) {
    console.warn(
      `[/api/generate] seed-sketch failed, using prose solutions: ${e instanceof Error ? e.message : String(e)}`
    );
    return items.map(() => "");
  }
}
