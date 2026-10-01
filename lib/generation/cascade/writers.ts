// Model adapters for cascade rungs. Each writes ONE problem through a tool call (the
// cascade's emit_problems, which adds the optional answerCheck/method fields) and
// maps its vendor's failure modes into the closed FinishReason vocabulary
// (lib/generation/gen-meta.ts), keeping the raw vendor text in the message.
//
// Retries are deliberately absent here (the Anthropic client is built with
// maxRetries: 0): the cascade's answer to a failed call is the next rung, and retries
// hidden inside a client would defeat both the per-request call cap and the rung
// deadline. The one exception is the scheduler's own same-rung retry policy.
import Anthropic from "@anthropic-ai/sdk";
import type { GoogleGenAI } from "@google/genai";
import { callTool, CASCADE_PROBLEMS_TOOL as PROBLEMS_TOOL, EMPTY_TOOL_OUTPUT, validateCascadeProblems as validateProblems, type CallConfig } from "@/lib/generation/call-tool";
import { callGemini } from "@/lib/generation/gemini-call";
import type { FinishReason } from "@/lib/generation/gen-meta";
import type { RungConfig, RungProvider } from "@/lib/generation/cascade/ladder";
import type { Problem } from "@/lib/types";

export class RungError extends Error {
  constructor(
    readonly finish: Exclude<FinishReason, "ok">,
    message: string,
    // True when the failure says something about the provider, not this request
    // (rate limits, 5xx, connection errors): the circuit breaker counts these.
    readonly providerLevel = false
  ) {
    super(message);
    this.name = "RungError";
  }
}

export type WriteRequest = {
  rung: RungConfig;
  system: string;
  user: string;
  signal: AbortSignal;
  recordUsage: (u: Anthropic.Usage) => void;
};

export type Writer = (req: WriteRequest) => Promise<Problem>;
export type Writers = Partial<Record<RungProvider, Writer>>;

function firstProblem(problems: Problem[]): Problem {
  const p = problems[0];
  if (!p) throw new RungError("malformed-tool-call", EMPTY_TOOL_OUTPUT);
  return p;
}

function isAbort(e: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (e instanceof Error && (e.name === "AbortError" || e instanceof Anthropic.APIUserAbortError));
}

// A caller-side abort (the set is done, or a sibling won) versus the rung deadline
// firing: both arrive as an aborted signal, and the reason tells them apart.
function abortFinish(signal: AbortSignal): RungError {
  return signal.reason === "rung-timeout"
    ? new RungError("timeout", "rung deadline reached")
    : new RungError("aborted", "aborted");
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

const EFFORT: Record<RungConfig["thinking"], "low" | "medium" | "high" | undefined> = {
  off: undefined,
  low: "low",
  medium: "medium",
  high: "high",
  max: "high",
};

export function anthropicCallConfig(rung: RungConfig): CallConfig {
  const thinkingOn = rung.thinking !== "off";
  return {
    thinking: thinkingOn ? ({ type: "adaptive" } as Anthropic.ThinkingConfigParam) : { type: "disabled" },
    effort: EFFORT[rung.thinking],
    toolChoice: rung.toolChoice === "forced" ? { type: "tool", name: PROBLEMS_TOOL.name } : { type: "auto" },
    maxTokens: rung.maxTokens,
    tool: PROBLEMS_TOOL,
    validate: validateProblems,
    stream: true,
  };
}

// An error that will fail EVERY call to this provider, not just this request: bad or
// revoked credentials, or an account out of credit (Anthropic answers that with a 400).
// These count toward the circuit breaker, so the set fails fast as "service
// unavailable" instead of burning its candidates and telling the tutor to broaden the
// profile. Seen live: evals ran out of Anthropic credit (400) and Gemini prepaid
// credit (402 RESOURCE_EXHAUSTED) mid-set.
export function accountLevel(status: unknown, message: string): boolean {
  return status === 401 || status === 402 || status === 403 || (status === 400 && /credit balance|billing|quota/i.test(message));
}

export function mapAnthropicError(e: unknown, signal: AbortSignal): RungError {
  if (e instanceof RungError) return e;
  if (isAbort(e, signal)) return abortFinish(signal);
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new RungError("timeout", e.message, true);
  if (e instanceof Anthropic.APIConnectionError) return new RungError("api-error", e.message, true);
  if (e instanceof Anthropic.APIError) {
    if (e.status === 429) return new RungError("rate-limited", e.message, true);
    return new RungError("api-error", e.message, (typeof e.status === "number" && e.status >= 500) || accountLevel(e.status, e.message));
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === "truncated") return new RungError("max-tokens", msg);
  if (msg === "no_tool") return new RungError("missing-tool-call", msg);
  // EMPTY_TOOL_OUTPUT and per-item validation errors: a tool call arrived but its
  // arguments weren't a usable problem.
  return new RungError("malformed-tool-call", msg);
}

export function anthropicWriter(client: Anthropic): Writer {
  return async ({ rung, system, user, signal, recordUsage }) => {
    try {
      const problems = await callTool(client, rung.model, system, user, anthropicCallConfig(rung), recordUsage, {
        signal,
        timeout: rung.timeoutMs,
      });
      return firstProblem(problems);
    } catch (e) {
      throw mapAnthropicError(e, signal);
    }
  };
}

// ---------------------------------------------------------------------------
// Gemini (function-calling mode only — never raw JSON mode; see gemini-call.ts)
// ---------------------------------------------------------------------------

export function mapGeminiError(e: unknown, signal: AbortSignal): RungError {
  if (e instanceof RungError) return e;
  if (isAbort(e, signal)) return abortFinish(signal);
  const status = (e as { status?: unknown })?.status;
  if (typeof status === "number") {
    if (status === 429) return new RungError("rate-limited", String(e), true);
    return new RungError("api-error", String(e), status >= 500 || accountLevel(status, String(e)));
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (msg === "filtered") return new RungError("filtered", msg);
  if (msg === "truncated") return new RungError("max-tokens", msg);
  if (msg === "malformed_function_call") return new RungError("malformed-tool-call", msg);
  if (msg === "no_tool") return new RungError("missing-tool-call", msg);
  return new RungError("malformed-tool-call", msg);
}

export function geminiWriter(client: GoogleGenAI): Writer {
  return async ({ rung, system, user, signal, recordUsage }) => {
    try {
      const problems = await callGemini(
        client,
        rung.model,
        system,
        user,
        {
          functionName: PROBLEMS_TOOL.name,
          functionDescription: PROBLEMS_TOOL.description ?? "",
          parametersJsonSchema: PROBLEMS_TOOL.input_schema,
          maxOutputTokens: rung.maxTokens,
          thinkingLevel: rung.thinking === "off" || rung.thinking === "low" ? "low" : rung.thinking === "medium" ? "medium" : "high",
          abortSignal: signal,
        },
        validateProblems,
        recordUsage
      );
      return firstProblem(problems);
    } catch (e) {
      throw mapGeminiError(e, signal);
    }
  };
}

// ---------------------------------------------------------------------------
// Open-weight models on an OpenAI-compatible host (DeepSeek, GLM, ...)
// ---------------------------------------------------------------------------

export type OpenWeightOptions = {
  baseUrl: string; // e.g. https://api.deepinfra.com/v1/openai — https only
  apiKey: string;
  fetch?: typeof fetch; // injectable for tests
  // How long a request may go without producing its first token before it is cancelled
  // and resent (ms). Default DEFAULT_FIRST_TOKEN_MS; CASCADE_FIRST_TOKEN_SECONDS sets it.
  firstTokenMs?: number;
};

// DeepInfra's GLM-5.3 sends some requests down a slow path: the first byte arrives at
// about 15s, the first token 25–70s in, sometimes never (16 of 48 probe calls; 2 never
// started in 240s). Healthy requests produce a token within about 1s and finished
// within 32s. It doesn't depend on the prompt or on how many calls run at once. A
// non-streaming call can't tell the two apart and waited out the whole write deadline
// (55 of 194 writes in one run). Streaming shows the first token, so a stuck request is
// cancelled and resent after this long, well before anything was generated.
export const DEFAULT_FIRST_TOKEN_MS = 10_000;

export function validateOpenWeightBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("OPENWEIGHT_BASE_URL is not a valid URL.");
  }
  if (u.protocol !== "https:") throw new Error("OPENWEIGHT_BASE_URL must use https.");
  return u.toString().replace(/\/$/, "");
}

type ChatCompletion = {
  choices?: {
    finish_reason?: string | null;
    message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] | null };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
    completion_tokens_details?: { reasoning_tokens?: number } | null;
  };
};

// Reads an OpenAI-compatible server-sent-event stream into the shape a non-streaming
// reply has, so parseChatCompletion handles both. `onToken` fires on every delta that
// carries generated text: reasoning, content or tool-call arguments.
export async function readChatStream(stream: ReadableStream<Uint8Array>, onToken: () => void): Promise<ChatCompletion> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const calls: { name: string; arguments: string }[] = [];
  let finish: string | null = null;
  let usage: ChatCompletion["usage"];
  let buffer = "";
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let event: {
      usage?: ChatCompletion["usage"];
      choices?: {
        finish_reason?: string | null;
        delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: { index?: number; function?: { name?: string; arguments?: string } }[] };
      }[];
    };
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event.usage) usage = event.usage;
    const choice = event.choices?.[0];
    if (!choice) return;
    const d = choice.delta ?? {};
    if (d.reasoning_content || d.reasoning || d.content || d.tool_calls?.length) onToken();
    for (const tc of d.tool_calls ?? []) {
      const call = (calls[tc.index ?? 0] ??= { name: "", arguments: "" });
      if (tc.function?.name && !call.name) call.name = tc.function.name;
      if (tc.function?.arguments) call.arguments += tc.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      handle(buffer.slice(0, nl).trim());
      buffer = buffer.slice(nl + 1);
    }
  }
  handle(buffer.trim());
  return { choices: [{ finish_reason: finish, message: { tool_calls: calls.filter(Boolean).map((c) => ({ function: c })) } }], usage };
}

// Request body for one rung. Thinking control differs by vendor: DeepSeek takes
// `thinking: {type: "disabled"}` (and rejects a forced tool call unless thinking is
// off), GLM-5.3 ignores "off". `reasoning_effort` is the common OpenAI-compatible knob.
export function openWeightBody(rung: RungConfig, system: string, user: string): Record<string, unknown> {
  return {
    model: rung.model,
    max_tokens: rung.maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: PROBLEMS_TOOL.name,
          description: PROBLEMS_TOOL.description,
          parameters: PROBLEMS_TOOL.input_schema,
        },
      },
    ],
    tool_choice: rung.toolChoice === "forced" ? { type: "function", function: { name: PROBLEMS_TOOL.name } } : "auto",
    ...(rung.thinking === "off"
      ? { thinking: { type: "disabled" } }
      : { reasoning_effort: rung.thinking === "max" ? "high" : rung.thinking }),
  };
}

// Tool-call arguments arrive as a JSON string by protocol (not free text), so they are
// parsed here. A LaTeX backslash the host failed to escape shows up as a parse error
// or a silently mangled command — which is exactly what each rung's LaTeX admission
// test exists to catch before the rung is allowed in.
export function parseChatCompletion(body: ChatCompletion): { problem: Problem; usage: Anthropic.Usage } {
  const choice = body.choices?.[0];
  const usage = {
    input_tokens: body.usage?.prompt_tokens ?? 0,
    output_tokens: body.usage?.completion_tokens ?? 0,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    output_tokens_details: { thinking_tokens: body.usage?.completion_tokens_details?.reasoning_tokens ?? 0 },
  } as unknown as Anthropic.Usage;
  const finish = choice?.finish_reason ?? "";
  if (finish === "length") throw Object.assign(new RungError("max-tokens", "finish_reason=length"), { usage });
  if (finish === "content_filter") throw Object.assign(new RungError("filtered", "finish_reason=content_filter"), { usage });
  const call = choice?.message?.tool_calls?.find((c) => c.function?.name === PROBLEMS_TOOL.name);
  if (!call?.function?.arguments) {
    throw Object.assign(new RungError("missing-tool-call", `no tool call (finish_reason=${finish || "none"})`), { usage });
  }
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    throw Object.assign(new RungError("malformed-tool-call", "tool arguments are not valid JSON"), { usage });
  }
  try {
    return { problem: firstProblem(validateProblems(args)), usage };
  } catch (e) {
    throw Object.assign(e instanceof RungError ? e : new RungError("malformed-tool-call", String(e)), { usage });
  }
}

export function openWeightWriter(opts: OpenWeightOptions): Writer {
  const baseUrl = validateOpenWeightBaseUrl(opts.baseUrl);
  const doFetch = opts.fetch ?? fetch;
  const firstTokenMs = opts.firstTokenMs ?? DEFAULT_FIRST_TOKEN_MS;
  return async ({ rung, system, user, signal, recordUsage }) => {
    // Resend a request that produced no token in time, until the rung's own deadline
    // (the outer signal) ends the write.
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) throw abortFinish(signal);
      const controller = new AbortController();
      const onOuterAbort = () => controller.abort(signal.reason);
      signal.addEventListener("abort", onOuterAbort, { once: true });
      let stalled = false;
      const watchdog = setTimeout(() => {
        stalled = true;
        controller.abort("stalled");
      }, firstTokenMs);
      try {
        let res: Response;
        try {
          res = await doFetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
            body: JSON.stringify({ ...openWeightBody(rung, system, user), stream: true, stream_options: { include_usage: true } }),
            signal: controller.signal,
          });
        } catch (e) {
          if (stalled || isAbort(e, signal)) throw e;
          throw new RungError("api-error", e instanceof Error ? e.message : String(e), true);
        }
        if (!res.ok) {
          clearTimeout(watchdog);
          const detail = (await res.text().catch(() => "")).slice(0, 200);
          if (res.status === 429) throw new RungError("rate-limited", `HTTP 429 ${detail}`, true);
          throw new RungError("api-error", `HTTP ${res.status} ${detail}`, res.status >= 500 || accountLevel(res.status, detail));
        }
        let body: ChatCompletion;
        const streamed = (res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body;
        try {
          if (streamed) {
            body = await readChatStream(res.body!, () => clearTimeout(watchdog));
          } else {
            // A host that ignores `stream` answers with one JSON body, as before.
            clearTimeout(watchdog);
            body = (await res.json()) as ChatCompletion;
          }
        } catch (e) {
          if (stalled || isAbort(e, signal)) throw e;
          throw new RungError("api-error", "response body is not JSON", true);
        }
        try {
          const { problem, usage } = parseChatCompletion(body);
          recordUsage(usage);
          return problem;
        } catch (e) {
          const usage = (e as { usage?: Anthropic.Usage }).usage;
          if (usage) recordUsage(usage);
          throw e;
        }
      } catch (e) {
        if (stalled && !signal.aborted) {
          console.warn(`[cascade] ${rung.model}: no token in ${firstTokenMs / 1000}s, resending (attempt ${attempt + 1})`);
          continue;
        }
        if (e instanceof RungError) throw e;
        if (isAbort(e, signal)) throw abortFinish(signal);
        throw new RungError("api-error", e instanceof Error ? e.message : String(e), true);
      } finally {
        clearTimeout(watchdog);
        signal.removeEventListener("abort", onOuterAbort);
      }
    }
  };
}
