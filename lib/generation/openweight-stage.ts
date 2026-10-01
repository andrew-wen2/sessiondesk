// Open-weight tool calls for the stages outside the cascade — plan, lessons, the legacy
// pipeline's easy/mid generation, seed-sketch and expand. Same shape as gemini-call.ts's
// callGeminiWithRetry (system, user, one function, validate, recordUsage; typed error
// strings "truncated" / "no_tool") so a call site switches provider with one branch.
//
// The request itself is the cascade's cheap-verifier caller (verify-cheap.ts): one
// non-streaming OpenAI-compatible chat/completions call that waits out HTTP 429/503.
// The rung is built by ladder.ts's parser, so a model's quirks (GLM-5.3 cannot force a
// tool call or turn thinking off) are applied here exactly as they are on a ladder.
import type Anthropic from "@anthropic-ai/sdk";
import { envOr, SOLVER_CLIENT_TIMEOUT_MS } from "@/lib/generation/config";
import { parseRungSpec, type Thinking } from "@/lib/generation/cascade/ladder";
import { openWeightCaller, type CallOpenWeight } from "@/lib/generation/cascade/verify-cheap";
import { validateOpenWeightBaseUrl } from "@/lib/generation/cascade/writers";

export type OpenWeightStageConfig = {
  functionName: string;
  functionDescription: string;
  parametersJsonSchema: unknown; // reuse an existing Anthropic.Tool.input_schema directly
  maxOutputTokens: number;
  thinking: Thinking;
  // Whole-call deadline. Default is the solver's (a classification-sized call); long
  // outputs (a lesson, a chunk of problems) pass their own.
  timeoutMs?: number;
};

// The host from env. Throws a message that names the missing variables, which the
// callers' existing catch blocks log (and, for the plan stage, fall back from).
export function openWeightStageCaller(timeoutMs = SOLVER_CLIENT_TIMEOUT_MS): CallOpenWeight {
  const baseUrl = envOr("OPENWEIGHT_BASE_URL", "");
  const apiKey = envOr("OPENWEIGHT_API_KEY", "");
  if (!baseUrl || !apiKey) throw new Error("OPENWEIGHT_BASE_URL and OPENWEIGHT_API_KEY must both be set");
  return openWeightCaller(validateOpenWeightBaseUrl(baseUrl), apiKey, timeoutMs);
}

// A reply with no usable tool call is worth one more try (a model that answered in
// prose usually calls the tool the second time); everything else is terminal here —
// the host's own rate limits are already waited out inside the caller.
const RETRYABLE = new Set(["no tool call", "malformed tool call"]);

export async function callOpenWeightWithRetry<T>(
  model: string,
  system: string,
  user: string,
  config: OpenWeightStageConfig,
  validate: (raw: unknown) => T,
  recordUsage: (u: Anthropic.Usage) => void,
  call: CallOpenWeight = openWeightStageCaller(config.timeoutMs)
): Promise<T> {
  const rung = { ...parseRungSpec("easy", `openweight:${model}@${config.thinking}`), maxTokens: config.maxOutputTokens };
  const tool = {
    name: config.functionName,
    description: config.functionDescription,
    parameters: config.parametersJsonSchema as Record<string, unknown>,
  };
  const maxTries = 3;
  for (let t = 1; ; t++) {
    const res = await call(rung, { system, user }, tool, new AbortController().signal, recordUsage);
    if (res.ok) return validate(res.args);
    if (res.message === "truncated") throw new Error("truncated");
    if (!RETRYABLE.has(res.message)) throw new Error(res.message);
    if (t >= maxTries) throw new Error("no_tool");
    console.warn(`[/api/generate] openweight ${model}: ${res.message} (attempt ${t}/${maxTries}) — retrying`);
  }
}
