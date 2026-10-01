// Blind program solver: one cheap call writes a program that computes the problem's
// answer from the statement ALONE (it never sees the writer's answer), and the sandbox
// runs it (answer-check.ts). It is a solver in a different MODALITY from the text
// solvers: program-of-thought fails on different problems than chain-of-thought, which
// makes its agreement worth more than a third text solver's (strong models give the
// same wrong answer ~60% of the time when both are wrong).
//
// Used for writers that don't write their own answerCheck (writer-program policy in
// generate.ts). Its result is one more verification observation: agree, disagree, or
// nothing at all when it abstains ("none", unrunnable, non-numeric) — an abstention is
// never evidence against a problem.
import type Anthropic from "@anthropic-ai/sdk";
import { buildProgramSolvePrompt } from "@/lib/generation-prompt";
import { runAnswerCheck } from "@/lib/generation/answer-check";
import type { RungConfig } from "@/lib/generation/cascade/ladder";
import type { CallOpenWeight, ToolSpec } from "@/lib/generation/cascade/verify-cheap";

const PROGRAM_TOOL: ToolSpec = {
  name: "emit_program",
  description: "Return the program that computes the answer.",
  parameters: { type: "object", properties: { program: { type: "string" } }, required: ["program"] },
};

export type ProgramSolve = { kind: "value"; value: number; program: string } | { kind: "abstain"; reason: string; program?: string };

export async function programSolve(args: {
  call: CallOpenWeight;
  rung: RungConfig;
  problem: string;
  domain: string;
  signal: AbortSignal;
  recordUsage: (u: Anthropic.Usage) => void;
}): Promise<ProgramSolve> {
  const r = await args.call(args.rung, buildProgramSolvePrompt({ problem: args.problem, domain: args.domain }), PROGRAM_TOOL, args.signal, args.recordUsage);
  if (!r.ok) return { kind: "abstain", reason: r.message };
  const program = (r.args as { program?: unknown } | null)?.program;
  if (typeof program !== "string") return { kind: "abstain", reason: "no program" };
  const run = runAnswerCheck(program);
  return run.ok ? { kind: "value", value: run.value, program } : { kind: "abstain", reason: run.reason, program };
}
