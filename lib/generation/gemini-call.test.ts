import { describe, it, expect, vi } from "vitest";
import { ApiError, type GoogleGenAI, type GenerateContentResponse } from "@google/genai";
import { callGemini, callGeminiWithRetry, isGeminiTransient } from "./gemini-call";

function fakeResponse(overrides: Record<string, unknown> = {}): GenerateContentResponse {
  return {
    candidates: [{ finishReason: "STOP" }],
    functionCalls: [{ name: "emit_problems", args: { problems: [] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2 },
    ...overrides,
  } as unknown as GenerateContentResponse;
}

function fakeClient(responses: Array<GenerateContentResponse | Error>) {
  let i = 0;
  const generateContent = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return r;
  });
  return { client: { models: { generateContent } } as unknown as GoogleGenAI, generateContent };
}

const baseConfig = {
  functionName: "emit_problems",
  functionDescription: "Return problems",
  parametersJsonSchema: { type: "object" },
  maxOutputTokens: 4000,
  thinkingLevel: "low" as const,
};

describe("callGemini", () => {
  it("returns validated data on a normal STOP response", async () => {
    const { client } = fakeClient([fakeResponse()]);
    const result = await callGemini(client, "gemini-3.8-flash", "sys", "user", baseConfig, (raw) => raw, () => {});
    expect(result).toEqual({ problems: [] });
  });

  it("REGRESSION: throws 'filtered' on RECITATION, not a silent empty result", async () => {
    const { client } = fakeClient([fakeResponse({ candidates: [{ finishReason: "RECITATION" }] })]);
    await expect(
      callGemini(client, "m", "sys", "user", baseConfig, (r) => r, () => {})
    ).rejects.toThrow("filtered");
  });

  it("REGRESSION: throws 'filtered' on SAFETY", async () => {
    const { client } = fakeClient([fakeResponse({ candidates: [{ finishReason: "SAFETY" }] })]);
    await expect(
      callGemini(client, "m", "sys", "user", baseConfig, (r) => r, () => {})
    ).rejects.toThrow("filtered");
  });

  it("throws 'truncated' on MAX_TOKENS", async () => {
    const { client } = fakeClient([fakeResponse({ candidates: [{ finishReason: "MAX_TOKENS" }] })]);
    await expect(
      callGemini(client, "m", "sys", "user", baseConfig, (r) => r, () => {})
    ).rejects.toThrow("truncated");
  });

  it("throws 'no_tool' when the model doesn't call the forced function", async () => {
    const { client } = fakeClient([fakeResponse({ functionCalls: undefined })]);
    await expect(
      callGemini(client, "m", "sys", "user", baseConfig, (r) => r, () => {})
    ).rejects.toThrow("no_tool");
  });

  it("throws 'no_tool' when a function call exists but under a different name", async () => {
    const { client } = fakeClient([fakeResponse({ functionCalls: [{ name: "wrong_function", args: {} }] })]);
    await expect(
      callGemini(client, "m", "sys", "user", baseConfig, (r) => r, () => {})
    ).rejects.toThrow("no_tool");
  });

  it("records usage mapped into the Anthropic.Usage shape UsageAccountant expects", async () => {
    const { client } = fakeClient([fakeResponse()]);
    const recordUsage = vi.fn();
    await callGemini(client, "m", "sys", "user", baseConfig, (r) => r, recordUsage);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        input_tokens: 10,
        output_tokens: 5,
        output_tokens_details: { thinking_tokens: 2 },
      })
    );
  });
});

describe("isGeminiTransient", () => {
  it("treats 429/5xx ApiErrors as transient", () => {
    expect(isGeminiTransient(new ApiError({ message: "rate limited", status: 429 }))).toBe(true);
    expect(isGeminiTransient(new ApiError({ message: "server error", status: 503 }))).toBe(true);
  });

  it("treats 4xx (other than 408/409/429) as non-transient", () => {
    expect(isGeminiTransient(new ApiError({ message: "bad request", status: 400 }))).toBe(false);
  });

  it("treats no_tool as transient (worth one retry) but filtered/truncated as terminal", () => {
    expect(isGeminiTransient(new Error("no_tool"))).toBe(true);
    expect(isGeminiTransient(new Error("filtered"))).toBe(false);
    expect(isGeminiTransient(new Error("truncated"))).toBe(false);
  });
});

describe("callGeminiWithRetry", () => {
  it("retries a transient failure and succeeds", async () => {
    const { client, generateContent } = fakeClient([
      new ApiError({ message: "overloaded", status: 503 }),
      fakeResponse(),
    ]);
    const result = await callGeminiWithRetry(client, "m", "sys", "user", baseConfig, (r) => r, () => {});
    expect(result).toEqual({ problems: [] });
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a filtered (RECITATION) response — terminal", async () => {
    const { client, generateContent } = fakeClient([fakeResponse({ candidates: [{ finishReason: "RECITATION" }] })]);
    await expect(
      callGeminiWithRetry(client, "m", "sys", "user", baseConfig, (r) => r, () => {})
    ).rejects.toThrow("filtered");
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("gives up after 3 attempts on persistent transient failures", async () => {
    const { client, generateContent } = fakeClient([
      new ApiError({ message: "a", status: 500 }),
      new ApiError({ message: "b", status: 500 }),
      new ApiError({ message: "c", status: 500 }),
    ]);
    await expect(
      callGeminiWithRetry(client, "m", "sys", "user", baseConfig, (r) => r, () => {})
    ).rejects.toThrow();
    expect(generateContent).toHaveBeenCalledTimes(3);
  });
});
