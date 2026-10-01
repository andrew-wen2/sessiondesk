// Pieces of an OpenAI-compatible chat/completions tool call shared by the cascade's
// cheap verifiers (verify-cheap.ts) and the eval scripts. Each one exists because an
// eval run went wrong without it:
//  - toolChoiceFor: sending "auto" to a rung configured "forced" let DeepSeek (thinking
//    off) work a broken problem in plain text until max_tokens (13 of 16 calls);
//  - readToolCall: a max_tokens cutoff was reported as "no tool call", hiding the cause;
//  - fetchRetrying: with every candidate launched at once, DeepInfra answered 69 of the
//    first 120 cheap-solver calls with HTTP 429, which were dropped as errors.
import type { RungConfig } from "@/lib/generation/cascade/ladder";

export type ChatToolResponse = {
  choices?: { finish_reason?: string; message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

// The rung's own tool policy: forced where the provider allows it (DeepSeek with
// thinking off), otherwise "auto".
export function toolChoiceFor(rung: Pick<RungConfig, "toolChoice">, name: string) {
  return rung.toolChoice === "forced" ? { type: "function", function: { name } } : ("auto" as const);
}

// The request fields that set a rung's thinking level on an OpenAI-compatible host.
export function thinkingFields(rung: Pick<RungConfig, "thinking">): Record<string, unknown> {
  return rung.thinking === "off" ? { thinking: { type: "disabled" } } : { reasoning_effort: rung.thinking === "max" ? "high" : rung.thinking };
}

// The named tool call's arguments, or why there are none. A max_tokens cutoff is
// "truncated" even when a partial call came back, never "no tool call".
export function readToolCall(body: ChatToolResponse, name: string): { ok: true; args: unknown } | { ok: false; message: string } {
  const choice = body.choices?.[0];
  if (choice?.finish_reason === "length") return { ok: false, message: "truncated" };
  const raw = choice?.message?.tool_calls?.find((c) => c.function?.name === name)?.function?.arguments;
  if (!raw) return { ok: false, message: "no tool call" };
  try {
    return { ok: true, args: JSON.parse(raw) };
  } catch {
    return { ok: false, message: "malformed tool call" };
  }
}

// Statuses worth waiting out: the host is rate limiting or briefly overloaded.
export const RETRYABLE_STATUS = new Set([429, 503]);
export const MAX_RETRIES = 6;

// How long to wait before retry number `attempt` (1-based): the host's Retry-After
// when it gives seconds, else exponential backoff from 1s capped at 30s, with jitter
// so a burst of parallel calls doesn't retry in lockstep.
export function retryDelayMs(attempt: number, retryAfter: string | null, random = Math.random): number {
  const seconds = retryAfter != null && /^\d+(\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter) : null;
  if (seconds != null) return Math.min(seconds, 60) * 1000;
  const base = Math.min(30_000, 1000 * 2 ** (attempt - 1));
  return Math.round(base / 2 + random() * (base / 2));
}

// fetch that waits out rate limits. The caller's signal still bounds the whole thing:
// an abort during a wait ends it like an abort mid-request.
export async function fetchRetrying(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, init);
    if (!RETRYABLE_STATUS.has(res.status) || attempt > MAX_RETRIES) return res;
    await res.body?.cancel();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, retryDelayMs(attempt, res.headers.get("retry-after")));
      init.signal.addEventListener("abort", () => (clearTimeout(t), reject(init.signal.reason)), { once: true });
    });
  }
}

// Model family, for "the checker must not be the writer's family": two models from one
// family tend to make the same mistakes, so their agreement says little.
export type Family = "deepseek" | "glm" | "claude" | "gemini" | "other";
export function familyOf(model: string): Family {
  const m = model.toLowerCase();
  if (m.includes("deepseek")) return "deepseek";
  if (m.includes("glm")) return "glm";
  if (m.includes("claude")) return "claude";
  if (m.includes("gemini")) return "gemini";
  return "other";
}
