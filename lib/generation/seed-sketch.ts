// STAGE A (adapt path) — seed-sketch. Distills each seed's REAL corpus solution into a
// terse numbered step-by-step sketch using a cheap, thinking-disabled model (Haiku) in a
// single batched, forced-tool call. The transpose stage then mutates that skeleton
// instead of re-reading the prose solution — which is what suppresses the heavy
// re-derivation. Prompt text lives in lib/generation-prompt.ts (buildSeedSketchPrompt);
// the tool schema lives here with the call. Non-blocking: on any failure the seeds keep
// their prose solution and the transpose stage falls back to the old framing.

import Anthropic from "@anthropic-ai/sdk";
import type { SeedItem } from "@/lib/generation-prompt";

const SEED_SKETCH_TOOL: Anthropic.Tool = {
  name: "emit_seed_sketches",
  description: "Return one step-by-step solution sketch per seed, index-aligned to the seeds.",
  input_schema: {
    type: "object",
    properties: {
      sketches: {
        type: "array",
        items: {
          type: "string",
          description: "Numbered step-by-step sketch of one seed's solution, LaTeX in $...$ / $$...$$",
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
    const eu = message.usage;
    const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const raw = toolUse?.input as { sketches?: unknown } | undefined;
    const out = raw && Array.isArray(raw.sketches) ? raw.sketches : [];
    const got = out.filter((s) => typeof s === "string" && s.trim()).length;
    console.log(
      `[/api/generate] seed-sketch call input=${eu.input_tokens} output=${eu.output_tokens} stop=${message.stop_reason} sketches=${got}/${items.length}`
    );
    return items.map((_, i) => (typeof out[i] === "string" ? (out[i] as string) : ""));
  } catch (e) {
    console.warn(
      `[/api/generate] seed-sketch failed, using prose solutions: ${e instanceof Error ? e.message : String(e)}`
    );
    return items.map(() => "");
  }
}
