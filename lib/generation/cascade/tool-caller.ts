// One tool call against any rung provider, behind the CallOpenWeight signature that
// verify-cheap.ts already defined for open-weight hosts. The difficulty judge and the
// method-dedup judge are configured as ordinary rung specs ("gemini:gemini-3.8-flash",
// "anthropic:claude-opus-5-5@low", "openweight:..."), so each can be moved to whichever
// vendor measures best without code changes.
//
// Never throws: every failure comes back as { ok: false, message }, as the open-weight
// caller does, so callers treat a judge failure as "no signal" rather than an error.
import Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";
import { callGemini } from "@/lib/generation/gemini-call";
import { SOLVER_CLIENT_TIMEOUT_MS } from "@/lib/generation/config";
import type { CallOpenWeight, ToolSpec } from "@/lib/generation/cascade/verify-cheap";
import type { RungConfig } from "@/lib/generation/cascade/ladder";

const EFFORT: Record<RungConfig["thinking"], "low" | "medium" | "high" | undefined> = { off: undefined, low: "low", medium: "medium", high: "high", max: "high" };

export function anthropicToolCaller(client: Anthropic): CallOpenWeight {
  return async (rung, prompt, tool, signal, recordUsage) => {
    try {
      const thinkingOn = rung.thinking !== "off";
      const msg = await client.messages.create(
        {
          model: rung.model,
          max_tokens: rung.maxTokens,
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
          tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters as Anthropic.Tool.InputSchema }],
          tool_choice: rung.toolChoice === "forced" && !thinkingOn ? { type: "tool", name: tool.name } : { type: "auto" },
          thinking: thinkingOn ? ({ type: "adaptive" } as Anthropic.ThinkingConfigParam) : { type: "disabled" },
          ...(thinkingOn && EFFORT[rung.thinking] ? { output_config: { effort: EFFORT[rung.thinking] } } : {}),
        } as Anthropic.MessageCreateParamsNonStreaming,
        { signal, timeout: SOLVER_CLIENT_TIMEOUT_MS }
      );
      recordUsage(msg.usage);
      if (msg.stop_reason === "max_tokens") return { ok: false, message: "truncated" };
      const use = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === tool.name);
      return use ? { ok: true, args: use.input } : { ok: false, message: "no tool call" };
    } catch (e) {
      return { ok: false, message: signal.aborted ? String(signal.reason ?? "aborted") : e instanceof Error ? e.message : String(e) };
    }
  };
}

export function geminiToolCaller(client: GoogleGenAI): CallOpenWeight {
  return async (rung, prompt, tool: ToolSpec, signal, recordUsage) => {
    try {
      const args = await callGemini(
        client,
        rung.model,
        prompt.system,
        prompt.user,
        {
          functionName: tool.name,
          functionDescription: tool.description,
          parametersJsonSchema: tool.parameters,
          maxOutputTokens: rung.maxTokens,
          thinkingLevel: rung.thinking === "off" || rung.thinking === "low" ? "low" : rung.thinking === "medium" ? "medium" : "high",
          abortSignal: signal,
        },
        (raw) => raw,
        recordUsage
      );
      return { ok: true, args };
    } catch (e) {
      return { ok: false, message: signal.aborted ? String(signal.reason ?? "aborted") : e instanceof Error ? e.message : String(e) };
    }
  };
}

// Dispatch by the rung's provider. A provider with no caller configured fails the call
// (never the request).
export function multiProviderCaller(callers: Partial<Record<RungConfig["provider"], CallOpenWeight>>): CallOpenWeight {
  return (rung, prompt, tool, signal, recordUsage) => {
    const c = callers[rung.provider];
    return c ? c(rung, prompt, tool, signal, recordUsage) : Promise.resolve({ ok: false, message: `no ${rung.provider} credentials configured` });
  };
}
