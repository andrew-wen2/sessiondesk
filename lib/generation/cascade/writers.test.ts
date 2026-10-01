import { describe, it, expect, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import {
  RungError,
  anthropicCallConfig,
  mapAnthropicError,
  mapGeminiError,
  openWeightBody,
  openWeightWriter,
  parseChatCompletion,
  validateOpenWeightBaseUrl,
} from "./writers";
import { parseLadder } from "./ladder";

const [deepseekEasy] = parseLadder("easy", "openweight:deepseek-flash,anthropic:claude-opus-5-5");
const [deepseekMid] = parseLadder("mid", "openweight:deepseek-flash,anthropic:claude-opus-5-5");
const [glm] = parseLadder("mid", "openweight:glm-5.3,anthropic:claude-opus-5-5");
const live = new AbortController().signal;

const toolCall = (args: string, finish = "tool_calls") => ({
  choices: [{ finish_reason: finish, message: { tool_calls: [{ function: { name: "emit_problems", arguments: args } }] } }],
  usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 30 } },
});
const oneProblem = JSON.stringify({ problems: [{ problem: "Find $\\binom{5}{2}$.", answer: "10", solution: "$\\binom{5}{2}=10$", difficulty: "x" }] });

describe("openWeightBody", () => {
  it("forces the tool call and turns thinking off where the rung allows it (DeepSeek, easy)", () => {
    const b = openWeightBody(deepseekEasy, "s", "u");
    expect(b.tool_choice).toEqual({ type: "function", function: { name: "emit_problems" } });
    expect(b.thinking).toEqual({ type: "disabled" });
  });

  it("uses auto tool choice with thinking on (DeepSeek mid, GLM)", () => {
    expect(openWeightBody(deepseekMid, "s", "u")).toMatchObject({ tool_choice: "auto", reasoning_effort: "high" });
    expect(openWeightBody(glm, "s", "u").tool_choice).toBe("auto");
  });
});

describe("parseChatCompletion", () => {
  it("keeps LaTeX backslashes intact through the tool-call arguments", () => {
    const { problem, usage } = parseChatCompletion(toolCall(oneProblem));
    expect(problem.problem).toBe("Find $\\binom{5}{2}$.");
    expect(usage).toMatchObject({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 40 });
    expect(usage.output_tokens_details?.thinking_tokens).toBe(30);
  });

  it.each([
    [{ choices: [{ finish_reason: "length", message: {} }] }, "max-tokens"],
    [{ choices: [{ finish_reason: "content_filter", message: {} }] }, "filtered"],
    [{ choices: [{ finish_reason: "stop", message: { tool_calls: null } }] }, "missing-tool-call"],
    [toolCall("{not json"), "malformed-tool-call"],
    [toolCall(JSON.stringify({ problems: [] })), "malformed-tool-call"],
  ])("maps a bad completion to its finish reason", (body, finish) => {
    try {
      parseChatCompletion(body as never);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RungError);
      expect((e as RungError).finish).toBe(finish);
    }
  });
});

describe("openWeightWriter", () => {
  const req = (over = {}) => ({ rung: deepseekEasy, system: "s", user: "u", signal: live, recordUsage: vi.fn(), ...over });

  it("posts to the chat completions endpoint and records usage", async () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(toolCall(oneProblem)), { status: 200 }));
    const r = req();
    const w = openWeightWriter({ baseUrl: "https://host.example/v1/", apiKey: "k", fetch: fetch as never });
    const p = await w(r);
    expect(p.answer).toBe("10");
    expect(fetch.mock.calls[0][0]).toBe("https://host.example/v1/chat/completions");
    expect(r.recordUsage).toHaveBeenCalledOnce();
  });

  it("treats 429 and 5xx as provider-level failures", async () => {
    for (const [status, finish] of [
      [429, "rate-limited"],
      [503, "api-error"],
    ] as const) {
      const fetch = vi.fn(async () => new Response("busy", { status }));
      const w = openWeightWriter({ baseUrl: "https://h.example", apiKey: "k", fetch: fetch as never });
      await expect(w(req())).rejects.toMatchObject({ finish, providerLevel: true });
    }
  });

  it("does not count a 400 against the provider", async () => {
    const fetch = vi.fn(async () => new Response("bad tool_choice", { status: 400 }));
    const w = openWeightWriter({ baseUrl: "https://h.example", apiKey: "k", fetch: fetch as never });
    await expect(w(req())).rejects.toMatchObject({ finish: "api-error", providerLevel: false });
  });

  // Server-sent events carrying one tool call, split across chunks the way hosts send it.
  const sse = (args: string) => {
    const events = [
      { choices: [{ delta: { reasoning_content: "thinking" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "emit_problems", arguments: args.slice(0, 10) } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(10) } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } },
    ];
    const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const argsOf = () => toolCall(oneProblem).choices[0].message.tool_calls[0].function.arguments;
  // A request on the host's slow path: headers arrive, then nothing until cancelled.
  const stuck = (init?: RequestInit) =>
    new Response(
      new ReadableStream({
        start(ctrl) {
          init?.signal?.addEventListener("abort", () => ctrl.error(Object.assign(new Error("aborted"), { name: "AbortError" })));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );

  it("asks for a stream and assembles the tool call and usage from it", async () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => sse(argsOf()));
    const r = req();
    const p = await openWeightWriter({ baseUrl: "https://h.example", apiKey: "k", fetch: fetch as never })(r);
    expect(p.answer).toBe("10");
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(r.recordUsage.mock.calls[0][0]).toMatchObject({ input_tokens: 5, output_tokens: 7 });
  });

  it("resends a request that produces no token in time, instead of waiting out the deadline", async () => {
    let calls = 0;
    const fetch = vi.fn(async (_u: string, init?: RequestInit) => (++calls === 1 ? stuck(init) : sse(argsOf())));
    const w = openWeightWriter({ baseUrl: "https://h.example", apiKey: "k", fetch: fetch as never, firstTokenMs: 30 });
    const p = await w(req());
    expect(p.answer).toBe("10");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops resending when the write's own deadline passes", async () => {
    const c = new AbortController();
    setTimeout(() => c.abort("rung-timeout"), 100);
    const fetch = vi.fn(async (_u: string, init?: RequestInit) => stuck(init));
    const w = openWeightWriter({ baseUrl: "https://h.example", apiKey: "k", fetch: fetch as never, firstTokenMs: 30 });
    await expect(w(req({ signal: c.signal }))).rejects.toMatchObject({ finish: "timeout" });
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not resend a slow request once it has started producing tokens", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls++;
      const body = sse(argsOf());
      const text = await body.text();
      // First token arrives immediately; the rest trickles in after the first-token window.
      return new Response(
        new ReadableStream({
          async start(ctrl) {
            const cut = text.indexOf("\n\n") + 2;
            ctrl.enqueue(new TextEncoder().encode(text.slice(0, cut)));
            await new Promise((r) => setTimeout(r, 80));
            ctrl.enqueue(new TextEncoder().encode(text.slice(cut)));
            ctrl.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });
    const w = openWeightWriter({ baseUrl: "https://h.example", apiKey: "k", fetch: fetch as never, firstTokenMs: 30 });
    expect((await w(req())).answer).toBe("10");
    expect(calls).toBe(1);
  });

  it("reports a deadline abort as a timeout", async () => {
    const c = new AbortController();
    const fetch = vi.fn(async () => {
      c.abort("rung-timeout");
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const w = openWeightWriter({ baseUrl: "https://h.example", apiKey: "k", fetch: fetch as never });
    await expect(w(req({ signal: c.signal }))).rejects.toMatchObject({ finish: "timeout" });
  });

  it("refuses a non-https base URL", () => {
    expect(() => validateOpenWeightBaseUrl("http://h.example")).toThrow(/https/);
    expect(() => validateOpenWeightBaseUrl("nope")).toThrow(/valid URL/);
  });
});

describe("Anthropic and Gemini error mapping", () => {
  it("maps the call-tool failure strings", () => {
    expect(mapAnthropicError(new Error("truncated"), live).finish).toBe("max-tokens");
    expect(mapAnthropicError(new Error("no_tool"), live).finish).toBe("missing-tool-call");
    expect(mapGeminiError(new Error("malformed_function_call"), live).finish).toBe("malformed-tool-call");
    expect(mapGeminiError(new Error("filtered"), live).finish).toBe("filtered");
  });

  it("maps a 429 to a provider-level rate limit", () => {
    const e = new Anthropic.RateLimitError(429, undefined, "slow down", new Headers());
    expect(mapAnthropicError(e, live)).toMatchObject({ finish: "rate-limited", providerLevel: true });
    expect(mapGeminiError(Object.assign(new Error("x"), { status: 429 }), live)).toMatchObject({ finish: "rate-limited" });
  });

  it("treats an out-of-credit or unauthorized account as provider-level", () => {
    const credit = new Anthropic.BadRequestError(400, undefined, "Your credit balance is too low to access the Anthropic API.", new Headers());
    expect(mapAnthropicError(credit, live)).toMatchObject({ finish: "api-error", providerLevel: true });
    const auth = new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", new Headers());
    expect(mapAnthropicError(auth, live).providerLevel).toBe(true);
    expect(mapGeminiError(Object.assign(new Error("prepayment credits are depleted"), { status: 402 }), live).providerLevel).toBe(true);
    const bad = new Anthropic.BadRequestError(400, undefined, "messages: field required", new Headers());
    expect(mapAnthropicError(bad, live).providerLevel).toBe(false);
  });

  it("uses adaptive thinking with auto tool choice when thinking is on", () => {
    const [opusMid] = parseLadder("mid", "anthropic:claude-opus-5-5");
    expect(anthropicCallConfig(opusMid)).toMatchObject({ thinking: { type: "adaptive" }, toolChoice: { type: "auto" } });
    // Opus 5.5 rejects disabled thinking, so even the easy tier sends adaptive + auto.
    const [opusEasy] = parseLadder("easy", "anthropic:claude-opus-5-5");
    expect(anthropicCallConfig(opusEasy)).toMatchObject({ thinking: { type: "adaptive" }, toolChoice: { type: "auto" } });
    const [sonnetEasy] = parseLadder("easy", "anthropic:claude-sonnet-4-6");
    expect(anthropicCallConfig(sonnetEasy)).toMatchObject({ thinking: { type: "disabled" }, toolChoice: { type: "tool" } });
  });
});
