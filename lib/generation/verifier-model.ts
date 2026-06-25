// STAGE 2 (adapt path, OFF unless GENERATION_VERIFY=1) — model correctness audit.
// A cheap, thinking-disabled model (Haiku) checks whether each sketch's arithmetic
// actually produces its proposed answer (a CHECKING task, which Haiku is reliable at
// — NOT an independent re-solve, which it is not). Items that fail are escalated by
// the route to a single heavy solve. Prompt text lives in lib/generation-prompt.ts
// (buildAuditPrompt); the tool schema lives here with the call. Non-blocking: on any
// failure every item is treated as "pass" (don't manufacture escalations from a flaky
// audit call).

import Anthropic from "@anthropic-ai/sdk";
import type { SketchItem } from "@/lib/generation-prompt";

export type Verdict = "pass" | "fail";

const AUDIT_TOOL: Anthropic.Tool = {
  name: "emit_audit",
  description: "Return one pass/fail verdict per item, index-aligned to the items.",
  input_schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: { type: "string", enum: ["pass", "fail"], description: "Verdict for one item" },
      },
    },
    required: ["results"],
  },
};

export async function auditSketch(
  client: Anthropic,
  model: string,
  items: SketchItem[],
  build: (items: SketchItem[]) => { system: string; user: string },
  recordUsage: (u: Anthropic.Usage) => void
): Promise<Verdict[]> {
  if (items.length === 0) return [];
  const { system, user } = build(items);
  try {
    const message = await client.messages.create({
      model,
      max_tokens: Math.min(2000, 200 + items.length * 50),
      thinking: { type: "disabled" },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: [AUDIT_TOOL],
      tool_choice: { type: "tool", name: "emit_audit" },
      messages: [{ role: "user", content: user }],
    });
    recordUsage(message.usage);
    const toolUse = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const raw = toolUse?.input as { results?: unknown } | undefined;
    const out = raw && Array.isArray(raw.results) ? raw.results : [];
    // Default to "pass" for any missing/unexpected entry — never escalate on noise.
    return items.map((_, i) => (out[i] === "fail" ? "fail" : "pass"));
  } catch (e) {
    console.warn(
      `[/api/generate] audit failed, treating all as pass: ${e instanceof Error ? e.message : String(e)}`
    );
    return items.map(() => "pass");
  }
}
