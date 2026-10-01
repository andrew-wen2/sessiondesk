import { describe, it, expect } from "vitest";
import { costForRun, isPriced } from "./pricing";
import type { StageUsage } from "./gen-meta";

const usage = (provider: string, model: string): StageUsage => ({
  provider,
  model,
  calls: 1,
  inputTokens: 1_000_000,
  outputTokens: 0,
  thinkingTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
});

describe("pricing", () => {
  // REGRESSION: prefix matching priced "claude-opus-5-5" as "claude-opus-5".
  it("prices a model only by its own row", () => {
    expect(costForRun({ a: usage("anthropic", "claude-opus-5-5") }).total).toBe(4);
    expect(costForRun({ a: usage("anthropic", "claude-opus-5") }).total).toBe(15);
  });

  it("still prices a dated snapshot of a known model", () => {
    expect(isPriced("anthropic", "claude-opus-5-20260815")).toBe(true);
  });

  it("reports an unknown model as unpriced rather than guessing", () => {
    expect(isPriced("anthropic", "claude-opus-5-9")).toBe(false);
    expect(costForRun({ a: usage("anthropic", "claude-opus-5-9") }).unpriced).toEqual(["anthropic/claude-opus-5-9"]);
  });

  it("prices the open-weight rungs", () => {
    expect(isPriced("openweight", "deepseek-flash")).toBe(true);
    expect(isPriced("openweight", "glm-5.3")).toBe(true);
  });
});
