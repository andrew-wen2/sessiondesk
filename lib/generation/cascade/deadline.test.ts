import { describe, it, expect } from "vitest";
import { admitRung, canStartRung, ladderFeasibility, rungCostMs, USABLE_BUDGET_MS } from "./deadline";
import { defaultLadder, parseLadder } from "./ladder";
import { SOLVER_CLIENT_TIMEOUT_MS } from "@/lib/generation/config";

const threeRung = (tier: "easy" | "mid" | "hard") =>
  parseLadder(tier, "openweight:deepseek-flash,openweight:glm-5.3,anthropic:claude-opus-5-5");

describe("feasibility of the shipped defaults", () => {
  // Hard is verified (adapt path); easy/mid are not.
  const cases = [
    ["easy", false],
    ["mid", false],
    ["hard", true],
  ] as const;

  it.each(cases)("%s: the default ladder's top rung fits the budget", (tier, verified) => {
    expect(ladderFeasibility(defaultLadder(tier), verified, tier).topRungFits).toBe(true);
  });

  it.each(cases)("%s: a cheap rung plus the top rung fits at time zero", (tier, verified) => {
    const f = ladderFeasibility(threeRung(tier), verified, tier);
    expect(f.topRungFits).toBe(true);
    expect(f.cheapRungsUsable).toBe(true);
  });
});

describe("canStartRung", () => {
  const ladder = threeRung("hard");
  const top = ladder.length - 1;

  it("rejects a top-rung start with only the writer's time left (verification needs room too)", () => {
    expect(canStartRung(ladder[top].timeoutMs, ladder, top, true)).toBe(false);
    expect(canStartRung(ladder[top].timeoutMs + SOLVER_CLIENT_TIMEOUT_MS, ladder, top, true)).toBe(true);
  });

  it("makes a cheap rung leave room to still reach the top rung", () => {
    const justCheap = rungCostMs(ladder[0], true);
    expect(canStartRung(justCheap, ladder, 0, true)).toBe(false);
    expect(canStartRung(justCheap + rungCostMs(ladder[top], true), ladder, 0, true)).toBe(true);
  });
});

describe("admitRung", () => {
  const ladder = threeRung("mid");
  it("skips straight to the top rung when a cheap rung no longer fits", () => {
    const onlyTop = rungCostMs(ladder[2], false);
    expect(admitRung(onlyTop, ladder, 0, false)).toBe(2);
  });
  it("admits nothing when even the top rung doesn't fit", () => {
    expect(admitRung(1000, ladder, 0, false)).toBeNull();
  });
  it("admits the wanted rung when it fits", () => {
    expect(admitRung(USABLE_BUDGET_MS, ladder, 1, false)).toBe(1);
  });
});

describe("ladderFeasibility messages", () => {
  it("explains an infeasible top rung", () => {
    const [r] = defaultLadder("hard");
    const f = ladderFeasibility([{ ...r, timeoutMs: 280_000 }], true, "hard");
    expect(f.topRungFits).toBe(false);
    expect(f.message).toMatch(/top rung/);
  });
});
