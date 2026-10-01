import { describe, it, expect } from "vitest";
import { UsageAccountant } from "./usage-accounting";

const u = (input: number, output: number) => ({ input_tokens: input, output_tokens: output }) as never;

describe("UsageAccountant.recordFor", () => {
  it("splits one stage across the models that served it", () => {
    const a = new UsageAccountant();
    a.recordFor("generation", "openweight", "deepseek-flash", u(10, 1));
    a.recordFor("generation", "openweight", "deepseek-flash", u(5, 1));
    a.recordFor("generation", "anthropic", "claude-opus-5-5", u(7, 2));
    const per = a.perModelUsage();
    expect(per["generation:openweight:deepseek-flash"]).toMatchObject({ calls: 2, inputTokens: 15 });
    expect(per["generation:anthropic:claude-opus-5-5"]).toMatchObject({ calls: 1, inputTokens: 7 });
    expect(a.totals("generation")).toMatchObject({ calls: 3, input: 22 });
  });
});
