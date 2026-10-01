// Difficulty filter: does a candidate play like its slot's target position? Measured,
// not asked: a deliberately weak solver attempts it `trials` times, and its pass rate
// against the (verified) answer must fall inside the window configured for the target.
//
// Why measured: with the same prompt and band, DeepSeek wrote problems that played like
// AMC 10 #3 and Opus like #17 (eval:difficulty). Wording can't calibrate every writer;
// a pass-rate window catches drift from any writer, prompt or model change. Asking a
// model "how hard is this" correlates only moderately with real difficulty.
//
// Windows come from a calibration curve: the same weak solver on real corpus problems
// of known position (npm run eval:difficulty). Off by default until a weak solver
// discriminates the band well enough to set them (CASCADE_DIFFICULTY_SOLVER).
import type Anthropic from "@anthropic-ai/sdk";
import { envOr } from "@/lib/generation/config";
import type { GenerationPlan, Tier } from "@/lib/generation/plan";
import type { ItemDifficulty } from "@/lib/generation/gen-meta";
import { LadderConfigError, parseRungSpec, type RungConfig } from "@/lib/generation/cascade/ladder";
import { sameAnswer, solveBlind, type CallOpenWeight } from "@/lib/generation/cascade/verify-cheap";

// For targets in [from, to], a candidate's pass rate must lie in [minRate, maxRate].
export type Window = { from: number; to: number; minRate: number; maxRate: number };
export type DifficultyConfig = { solver: RungConfig; trials: number; windows: Window[] };

export function parseWindows(json: string): Window[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new LadderConfigError("CASCADE_DIFFICULTY_WINDOWS must be JSON: [{from,to,minRate,maxRate}, ...]");
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new LadderConfigError("CASCADE_DIFFICULTY_WINDOWS must be a non-empty array");
  return raw.map((w, i) => {
    const { from, to, minRate, maxRate } = (w ?? {}) as Record<string, unknown>;
    const ok =
      [from, to, minRate, maxRate].every((x) => typeof x === "number" && Number.isFinite(x)) &&
      (from as number) <= (to as number) &&
      (minRate as number) >= 0 &&
      (maxRate as number) <= 1 &&
      (minRate as number) <= (maxRate as number);
    if (!ok) throw new LadderConfigError(`CASCADE_DIFFICULTY_WINDOWS[${i}] must have from<=to and 0<=minRate<=maxRate<=1`);
    return { from, to, minRate, maxRate } as Window;
  });
}

export function difficultyConfigFromEnv(tier: Tier): DifficultyConfig | null {
  const spec = envOr("CASCADE_DIFFICULTY_SOLVER", "off").trim();
  if (spec === "off") return null;
  const solver = parseRungSpec(tier, spec);
  if (solver.provider !== "openweight") throw new LadderConfigError(`CASCADE_DIFFICULTY_SOLVER must be an openweight model, got ${solver.provider}`);
  const trials = Number(envOr("CASCADE_DIFFICULTY_TRIALS", "3"));
  if (!Number.isInteger(trials) || trials < 1 || trials > 8) throw new LadderConfigError("CASCADE_DIFFICULTY_TRIALS must be an integer 1-8");
  return { solver, trials, windows: parseWindows(envOr("CASCADE_DIFFICULTY_WINDOWS", "[]")) };
}

// The decision: too easy (solved more often than the window allows), too hard, or ok.
// No decision when fewer than half the trials came back: errors say nothing about
// difficulty, and a target outside every window is not filtered.
export function decideDifficulty(
  d: ItemDifficulty,
  trials: number,
  windows: Window[]
): "too-easy" | "too-hard" | null {
  if (d.answered < Math.ceil(trials / 2)) return null;
  const w = windows.find((x) => d.target >= x.from && d.target <= x.to);
  if (!w) return null;
  const rate = d.solved / d.answered;
  return rate > w.maxRate ? "too-easy" : rate < w.minRate ? "too-hard" : null;
}

// Run the weak solver `trials` times against the candidate's answer.
export async function measureDifficulty(args: {
  problem: { problem: string; answer: string };
  target: number;
  plan: Pick<GenerationPlan, "domain" | "rubric" | "answerFormat">;
  config: DifficultyConfig;
  call: CallOpenWeight;
  signal: AbortSignal;
  recordUsage: (u: Anthropic.Usage) => void;
}): Promise<ItemDifficulty> {
  const { problem, target, plan, config, call, signal, recordUsage } = args;
  const obs = await Promise.all(
    Array.from({ length: config.trials }, () => solveBlind(call, config.solver, problem.problem, plan, signal, recordUsage))
  );
  const answered = obs.filter((o) => o.kind !== "error");
  const solved = answered.filter((o) => o.kind === "answer" && sameAnswer(problem.answer, o.answer, plan.answerFormat)).length;
  return { target, solved, answered: answered.length };
}
