// Low-level Gemini function-calling primitives, mirroring call-tool.ts's shape
// (callTool/callToolWithRetry/isTransient/CallConfig) so problems.ts, plan.ts,
// seed-sketch.ts, expand.ts, and lesson.ts can switch providers per stage without
// restructuring their call sites.
//
// FUNCTION-CALLING ONLY — NEVER raw JSON mode (responseSchema + responseMimeType:
// "application/json"). Confirmed by direct investigation (see the session's debug
// report): raw JSON mode silently under-escapes backslashes before letters that
// collide with a JSON single-character escape (\binom -> \b + inom, eating the
// "b"), producing valid-but-wrong JSON with no parse error. Function-calling mode
// (tools + forced toolConfig) showed zero such corruption across 24 real
// LaTeX-heavy fields targeting the exact commands most at risk (\binom \frac
// \right \left \rho \neq \tan \theta \times \to). This is the same protection
// forcing a tool call gives the Anthropic path (call-tool.ts's header comment) —
// use it exclusively for anything containing LaTeX.
//
// Existing JSON-schema tool definitions (Anthropic.Tool.input_schema, already
// plain JSON Schema) are reused as-is via FunctionDeclaration.parametersJsonSchema
// — no schema-translation layer needed.

import { GoogleGenAI, ApiError, ThinkingLevel, FunctionCallingConfigMode } from "@google/genai";
import type Anthropic from "@anthropic-ai/sdk";

let sharedClient: GoogleGenAI | null = null;
export function geminiClient(): GoogleGenAI {
  if (!sharedClient) sharedClient = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
  return sharedClient;
}

export type GeminiThinkingLevel = "low" | "medium" | "high";
function toThinkingLevel(effort: GeminiThinkingLevel): ThinkingLevel {
  return effort === "low" ? ThinkingLevel.LOW : effort === "medium" ? ThinkingLevel.MEDIUM : ThinkingLevel.HIGH;
}

export type GeminiCallConfig = {
  functionName: string;
  functionDescription: string;
  parametersJsonSchema: unknown; // reuse an existing Anthropic.Tool.input_schema directly
  maxOutputTokens: number;
  thinkingLevel: GeminiThinkingLevel;
};

// Adapts Gemini's usage shape into the Anthropic.Usage shape UsageAccountant
// already expects, so genMeta/cost tracking work identically regardless of which
// provider served a given stage — avoids widening UsageAccountant's type for a
// single new caller. cache WRITE has no Gemini equivalent surfaced here (Gemini's
// caching model is an explicit CachedContent resource, not an inline marker — see
// the plan's Evidence section); only cache READ (cachedContentTokenCount) maps.
function toAnthropicUsageShape(u: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}): Anthropic.Usage {
  return {
    input_tokens: u.promptTokenCount ?? 0,
    output_tokens: u.candidatesTokenCount ?? 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: u.cachedContentTokenCount ?? 0,
    output_tokens_details: { thinking_tokens: u.thoughtsTokenCount ?? 0 } as Anthropic.Usage["output_tokens_details"],
  } as Anthropic.Usage;
}

// One function-forced generation call -> validated Problem[] (or whatever shape
// `validate` extracts). Throws typed error strings so callers map them the same
// way they already map Anthropic's: "truncated" / "no_tool" / "filtered".
// "filtered" is a NEW class Anthropic tool-use never had (Eng H3) — Gemini's
// RECITATION and SAFETY finishReasons block output when it detects the response
// reproducing training data or tripping a safety filter. The adapt path feeds
// verbatim corpus statements + their published solutions, which is exactly the
// shape that risks RECITATION.
export async function callGemini<T>(
  client: GoogleGenAI,
  model: string,
  system: string,
  user: string,
  config: GeminiCallConfig,
  validate: (raw: unknown) => T,
  recordUsage: (u: Anthropic.Usage) => void
): Promise<T> {
  const tool = {
    functionDeclarations: [
      {
        name: config.functionName,
        description: config.functionDescription,
        parametersJsonSchema: config.parametersJsonSchema,
      },
    ],
  };
  const response = await client.models.generateContent({
    model,
    contents: user,
    config: {
      systemInstruction: system,
      maxOutputTokens: config.maxOutputTokens,
      thinkingConfig: { thinkingLevel: toThinkingLevel(config.thinkingLevel) },
      tools: [tool],
      toolConfig: {
        functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [config.functionName] },
      },
    },
  });

  if (response.usageMetadata) recordUsage(toAnthropicUsageShape(response.usageMetadata));

  const finishReason = response.candidates?.[0]?.finishReason;
  console.log(`[/api/generate] gemini call finishReason=${finishReason} prompt=${response.usageMetadata?.promptTokenCount} out=${response.usageMetadata?.candidatesTokenCount} thinking=${response.usageMetadata?.thoughtsTokenCount}`);

  if (finishReason === "RECITATION" || finishReason === "SAFETY") throw new Error("filtered");
  if (finishReason === "MAX_TOKENS") throw new Error("truncated");

  const call = response.functionCalls?.find((c) => c.name === config.functionName);
  if (!call || !call.args) throw new Error("no_tool");

  return validate(call.args);
}

// A transient failure is worth retrying — mirrors call-tool.ts's isTransient, but
// against Gemini's ApiError (a real, unified class with a numeric .status) rather
// than Anthropic's error hierarchy. "filtered" and "truncated" are terminal, same
// as Anthropic: retrying a content-filtered or truncated response won't change
// the outcome (the caller's deficit-refill loop handles those, not a retry here).
export function isGeminiTransient(e: unknown): boolean {
  if (e instanceof ApiError) return e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
  return e instanceof Error && e.message === "no_tool";
}

export async function callGeminiWithRetry<T>(
  client: GoogleGenAI,
  model: string,
  system: string,
  user: string,
  config: GeminiCallConfig,
  validate: (raw: unknown) => T,
  recordUsage: (u: Anthropic.Usage) => void
): Promise<T> {
  const maxTries = 3;
  for (let t = 1; ; t++) {
    try {
      return await callGemini(client, model, system, user, config, validate, recordUsage);
    } catch (e) {
      if (t >= maxTries || !isGeminiTransient(e)) throw e;
      const name = e instanceof Error ? e.message || e.name : "unknown";
      console.warn(`[/api/generate] gemini transient failure (attempt ${t}/${maxTries}): ${name} — retrying`);
      await new Promise((r) => setTimeout(r, 400 * t));
    }
  }
}
