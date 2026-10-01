import { afterEach, describe, expect, it, vi } from "vitest";
import { decideDifficulty, difficultyConfigFromEnv, measureDifficulty, parseWindows, type Window } from "./difficulty-filter";
import { LadderConfigError } from "./ladder";
import type { CallOpenWeight } from "./verify-cheap";

afterEach(() => vi.unstubAllEnvs());
const windows: Window[] = [
  { from: 1, to: 5, minRate: 0.67, maxRate: 1 },
  { from: 11, to: 15, minRate: 0, maxRate: 0.67 },
];

describe("config", () => {
  it("is off unless a weak solver is named", () => {
    expect(difficultyConfigFromEnv("easy")).toBeNull();
    vi.stubEnv("CASCADE_DIFFICULTY_SOLVER", "openweight:deepseek-ai/DeepSeek-V4.1-Flash");
    vi.stubEnv("CASCADE_DIFFICULTY_WINDOWS", JSON.stringify(windows));
    const c = difficultyConfigFromEnv("easy")!;
    expect([c.solver.model, c.trials, c.windows.length]).toEqual(["deepseek-ai/DeepSeek-V4.1-Flash", 3, 2]);
  });
  it("rejects malformed windows and bad trial counts", () => {
    expect(() => parseWindows("nope")).toThrow(LadderConfigError);
    expect(() => parseWindows("[]")).toThrow(LadderConfigError);
    expect(() => parseWindows(JSON.stringify([{ from: 5, to: 1, minRate: 0, maxRate: 1 }]))).toThrow(/from<=to/);
    vi.stubEnv("CASCADE_DIFFICULTY_SOLVER", "openweight:deepseek-ai/DeepSeek-V4.1-Flash");
    vi.stubEnv("CASCADE_DIFFICULTY_WINDOWS", JSON.stringify(windows));
    vi.stubEnv("CASCADE_DIFFICULTY_TRIALS", "0");
    expect(() => difficultyConfigFromEnv("easy")).toThrow(/TRIALS/);
  });
});

describe("decideDifficulty", () => {
  it("flags a late slot the weak solver always solves, and an early slot it can't", () => {
    expect(decideDifficulty({ target: 13, solved: 3, answered: 3 }, 3, windows)).toBe("too-easy");
    expect(decideDifficulty({ target: 13, solved: 1, answered: 3 }, 3, windows)).toBeNull();
    expect(decideDifficulty({ target: 2, solved: 1, answered: 3 }, 3, windows)).toBe("too-hard");
  });
  it("makes no call on too few answers, or a target outside every window", () => {
    expect(decideDifficulty({ target: 13, solved: 1, answered: 1 }, 3, windows)).toBeNull();
    expect(decideDifficulty({ target: 8, solved: 3, answered: 3 }, 3, windows)).toBeNull();
  });
});

describe("measureDifficulty", () => {
  it("counts trials matching the answer and leaves errors out", async () => {
    let n = 0;
    const call: CallOpenWeight = async () => {
      const i = n++;
      return i === 2 ? { ok: false, message: "timeout" } : { ok: true, args: { answer: i === 0 ? "\\tfrac{21}{2}" : "13", ambiguous: false } };
    };
    vi.stubEnv("CASCADE_DIFFICULTY_SOLVER", "openweight:deepseek-ai/DeepSeek-V4.1-Flash");
    vi.stubEnv("CASCADE_DIFFICULTY_WINDOWS", JSON.stringify(windows));
    const config = difficultyConfigFromEnv("easy")!;
    const d = await measureDifficulty({
      problem: { problem: "p", answer: "21/2" },
      target: 12,
      plan: { domain: "d", rubric: "r", answerFormat: "numeric" },
      config,
      call,
      signal: new AbortController().signal,
      recordUsage: () => {},
    });
    expect(d).toEqual({ target: 12, solved: 1, answered: 2 });
  });
});
