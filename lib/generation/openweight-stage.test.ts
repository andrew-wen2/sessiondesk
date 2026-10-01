import { describe, it, expect, afterEach, vi } from "vitest";
import { callOpenWeightWithRetry, openWeightStageCaller } from "./openweight-stage";
import type { CallOpenWeight, CallResult } from "@/lib/generation/cascade/verify-cheap";

afterEach(() => vi.unstubAllEnvs());

const config = {
  functionName: "emit_plan",
  functionDescription: "Return the plan",
  parametersJsonSchema: { type: "object" },
  maxOutputTokens: 1500,
  thinking: "off" as const,
};

function fakeCall(results: CallResult[]) {
  let i = 0;
  const call = vi.fn<CallOpenWeight>(async () => results[Math.min(i++, results.length - 1)]);
  return call;
}

describe("callOpenWeightWithRetry", () => {
  it("returns the validated tool arguments and passes the stage's settings on the rung", async () => {
    const call = fakeCall([{ ok: true, args: { tier: "mid" } }]);
    const out = await callOpenWeightWithRetry("deepseek-ai/DeepSeek-V4.1-Flash", "sys", "user", config, (raw) => raw, () => {}, call);
    expect(out).toEqual({ tier: "mid" });
    const [rung, prompt, tool] = call.mock.calls[0];
    expect(rung).toMatchObject({ provider: "openweight", model: "deepseek-ai/DeepSeek-V4.1-Flash", maxTokens: 1500, thinking: "off", toolChoice: "forced" });
    expect(prompt).toEqual({ system: "sys", user: "user" });
    expect(tool).toEqual({ name: "emit_plan", description: "Return the plan", parameters: { type: "object" } });
  });

  it("applies a model's quirks: GLM-5.3 cannot force the tool or turn thinking off", async () => {
    const call = fakeCall([{ ok: true, args: {} }]);
    await callOpenWeightWithRetry("zai-org/GLM-5.3", "s", "u", config, (raw) => raw, () => {}, call);
    expect(call.mock.calls[0][0]).toMatchObject({ thinking: "low", toolChoice: "auto" });
  });

  it("retries a reply with no tool call, then succeeds", async () => {
    const call = fakeCall([{ ok: false, message: "no tool call" }, { ok: false, message: "malformed tool call" }, { ok: true, args: { ok: 1 } }]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await callOpenWeightWithRetry("m", "s", "u", config, (raw) => raw, () => {}, call)).toEqual({ ok: 1 });
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("gives up as 'no_tool' after three tries", async () => {
    const call = fakeCall([{ ok: false, message: "no tool call" }]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(callOpenWeightWithRetry("m", "s", "u", config, (raw) => raw, () => {}, call)).rejects.toThrow("no_tool");
    expect(call).toHaveBeenCalledTimes(3);
  });

  it("does not retry a truncation or a host error, and keeps their messages", async () => {
    const truncated = fakeCall([{ ok: false, message: "truncated" }]);
    await expect(callOpenWeightWithRetry("m", "s", "u", config, (raw) => raw, () => {}, truncated)).rejects.toThrow("truncated");
    expect(truncated).toHaveBeenCalledTimes(1);
    const paymentRequired = fakeCall([{ ok: false, message: "HTTP 402" }]);
    await expect(callOpenWeightWithRetry("m", "s", "u", config, (raw) => raw, () => {}, paymentRequired)).rejects.toThrow("HTTP 402");
    expect(paymentRequired).toHaveBeenCalledTimes(1);
  });

  it("lets a validation error through", async () => {
    const call = fakeCall([{ ok: true, args: {} }]);
    const validate = () => {
      throw new Error("Lesson output had no usable content");
    };
    await expect(callOpenWeightWithRetry("m", "s", "u", config, validate, () => {}, call)).rejects.toThrow("no usable content");
  });
});

describe("openWeightStageCaller", () => {
  it("names the missing variables instead of calling a host that isn't configured", () => {
    vi.stubEnv("OPENWEIGHT_BASE_URL", "");
    vi.stubEnv("OPENWEIGHT_API_KEY", "");
    expect(() => openWeightStageCaller()).toThrow(/OPENWEIGHT_BASE_URL and OPENWEIGHT_API_KEY/);
  });

  it("refuses a non-https host", () => {
    vi.stubEnv("OPENWEIGHT_BASE_URL", "http://api.example/v1");
    vi.stubEnv("OPENWEIGHT_API_KEY", "k");
    expect(() => openWeightStageCaller()).toThrow(/https/);
  });
});
