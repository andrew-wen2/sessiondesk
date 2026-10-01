// Cheap verification for scratch (non-seed) candidates: the writer's answer must agree
// with independent blind solvers, and a separate check must find the statement
// well-posed. Before this, scratch candidates shipped their writer's answer unchecked.
//
// What the evals showed (easy AMC, scripts/eval-solve-first + eval-accuracy):
//  - a writer's own answer key is often wrong: 70–83% for cheap writers solving
//    forward, 13% for Opus (answer fields contradicting their own solutions);
//  - writer + two blind solvers from different families all agreeing was wrong 0 times
//    in 57 (splits hand-checked), and dropped every Opus key that was wrong;
//  - but agreement can't see a broken problem: both solvers once answered a problem
//    whose conditions had no solution. Hence the separate well-posedness check.
//
// Decisions reuse decideVerification (verify-policy.ts): any disagreement or ambiguity
// replaces the candidate, errors alone keep it "unverified". Model calls go through an
// injectable caller so the rules are tested without a network.
import type Anthropic from "@anthropic-ai/sdk";
import { answersMatch, evaluateAnswer } from "@/lib/generation/answer-match";
import { envOr, SOLVER_CLIENT_TIMEOUT_MS } from "@/lib/generation/config";
import { buildSolvePrompt, buildValidityPrompt } from "@/lib/generation-prompt";
import { SOLVE_TOOL } from "@/lib/generation/solve";
import type { AnswerFormat, GenerationPlan, Tier } from "@/lib/generation/plan";
import { LadderConfigError, parseRungSpec, type RungConfig } from "@/lib/generation/cascade/ladder";
import {
  familyOf,
  fetchRetrying,
  readToolCall,
  thinkingFields,
  toolChoiceFor,
  type ChatToolResponse,
} from "@/lib/generation/cascade/openweight-call";
import type { SolverObservation } from "@/lib/generation/cascade/verify-policy";
import type { Problem } from "@/lib/types";

export const DEFAULT_CHEAP_SOLVERS = "openweight:deepseek-ai/DeepSeek-V4.1-Flash@low,openweight:zai-org/GLM-5.3@low";

export type CheapConfig = {
  solvers: RungConfig[];
  validity: RungConfig | null; // null = the well-posedness check is off
  flagAssumptions: boolean; // solvers veto on an unjustified assumption (CASCADE_ASSUMPTION_VETO)
};

// A thinking solver needs room: at the tier default (6k on easy) eval solves were cut
// off mid-thought and came back as errors.
const SOLVER_MIN_TOKENS = 16_000;
function openWeightOnly(r: RungConfig, name: string): RungConfig {
  if (r.provider !== "openweight") throw new LadderConfigError(`${name}: ${r.provider}:${r.model} must be an openweight model.`);
  return { ...r, maxTokens: Math.max(r.maxTokens, SOLVER_MIN_TOKENS) };
}

export function cheapConfigFromEnv(tier: Tier): CheapConfig {
  const specs = envOr("CASCADE_SOLVERS", DEFAULT_CHEAP_SOLVERS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (specs.length < 2) throw new LadderConfigError(`CASCADE_SOLVERS needs at least two solvers, got ${specs.length}.`);
  const solvers = specs.map((s) => openWeightOnly(parseRungSpec(tier, s), "CASCADE_SOLVERS"));
  const v = envOr("CASCADE_VALIDITY", specs[specs.length - 1]).trim();
  const validity = v === "off" ? null : openWeightOnly(parseRungSpec(tier, v), "CASCADE_VALIDITY");
  const veto = envOr("CASCADE_ASSUMPTION_VETO", "on");
  if (veto !== "on" && veto !== "off") throw new LadderConfigError(`CASCADE_ASSUMPTION_VETO must be on or off, got "${veto}"`);
  return { solvers, validity, flagAssumptions: veto === "on" };
}

// Every writer on the ladder needs at least one solver outside its own family, or the
// check reduces to a model agreeing with itself. Returns the problem, or null.
export function familyProblem(ladder: RungConfig[], solvers: RungConfig[]): string | null {
  for (const w of ladder) {
    if (!solvers.some((s) => familyOf(s.model) !== familyOf(w.model))) {
      return `writer ${w.model} has no solver from a different model family (CASCADE_SOLVERS: ${solvers.map((s) => s.model).join(", ")})`;
    }
  }
  return null;
}

// Do two answers say the same thing? A rule match or an equal closed-form value. No
// model is asked: a miss counts as disagreement, which only ever costs a rewrite.
export function sameAnswer(a: string, b: string, format: AnswerFormat): boolean {
  if (answersMatch(a, b, { format, strictness: "loose" })) return true;
  const x = evaluateAnswer(a);
  const y = evaluateAnswer(b);
  return x != null && y != null && Math.abs(x - y) <= 1e-6 * Math.max(1, Math.abs(x), Math.abs(y));
}

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
export type CallResult = { ok: true; args: unknown } | { ok: false; message: string };
export type CallOpenWeight = (
  rung: RungConfig,
  prompt: { system: string; user: string },
  tool: ToolSpec,
  signal: AbortSignal,
  recordUsage: (u: Anthropic.Usage) => void
) => Promise<CallResult>;

// The real caller: one chat/completions tool call, bounded by the solver timeout and
// the candidate's signal, waiting out rate limits.
export function openWeightCaller(baseUrl: string, apiKey: string, timeoutMs = SOLVER_CLIENT_TIMEOUT_MS): CallOpenWeight {
  return async (rung, prompt, tool, signal, recordUsage) => {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    try {
      const res = await fetchRetrying(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: rung.model,
          max_tokens: rung.maxTokens,
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
          tools: [{ type: "function", function: tool }],
          tool_choice: toolChoiceFor(rung, tool.name),
          ...thinkingFields(rung),
        }),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
      const body = (await res.json()) as ChatToolResponse;
      recordUsage({ input_tokens: body.usage?.prompt_tokens ?? 0, output_tokens: body.usage?.completion_tokens ?? 0 } as Anthropic.Usage);
      return readToolCall(body, tool.name);
    } catch (e) {
      return { ok: false, message: controller.signal.aborted ? String(controller.signal.reason ?? "aborted") : e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}

const SOLVE: ToolSpec = { name: SOLVE_TOOL.name, description: SOLVE_TOOL.description ?? "", parameters: SOLVE_TOOL.input_schema as Record<string, unknown> };
// The cheap solvers' tool adds "assumed" (buildSolvePrompt's flagAssumptions).
const SOLVE_FLAGGED: ToolSpec = {
  ...SOLVE,
  parameters: {
    ...(SOLVE_TOOL.input_schema as Record<string, unknown>),
    properties: {
      ...((SOLVE_TOOL.input_schema as { properties: Record<string, unknown> }).properties),
      assumed: { type: "string", description: "One line: any assumption the statement did not justify, or empty" },
    },
  },
};
const VALIDITY: ToolSpec = {
  name: "emit_validity",
  description: "Report whether the problem is well-posed, stage by stage.",
  parameters: {
    type: "object",
    properties: {
      conditions: { type: "array", items: { type: "string" } },
      missing: { type: "string" },
      contradiction: { type: "string" },
      notUnique: { type: "string" },
      selfContained: { type: "boolean" },
      wellPosed: { type: "boolean" },
      reason: { type: "string" },
    },
    required: ["conditions", "missing", "contradiction", "notUnique", "selfContained", "wellPosed", "reason"],
  },
};

// An assumption line that says "none" in words is no assumption.
export function realAssumption(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && !/^(none|n\/a|nothing|-|no(ne)?(\s+(assumptions?|needed|required|made|necessary))+)\.?$/i.test(s) ? s : null;
}

export type SolveObs = { kind: "answer"; answer: string } | { kind: "ambiguous"; note: string } | { kind: "error"; message: string };

export async function solveBlind(
  call: CallOpenWeight,
  rung: RungConfig,
  problem: string,
  plan: Pick<GenerationPlan, "domain" | "rubric" | "answerFormat">,
  signal: AbortSignal,
  recordUsage: (u: Anthropic.Usage) => void,
  flagAssumptions = false
): Promise<SolveObs> {
  const r = await call(
    rung,
    buildSolvePrompt({ problem, domain: plan.domain, rubric: plan.rubric, answerFormat: plan.answerFormat, flagAssumptions }),
    flagAssumptions ? SOLVE_FLAGGED : SOLVE,
    signal,
    recordUsage
  );
  if (!r.ok) return { kind: "error", message: r.message };
  const a = (r.args ?? {}) as { answer?: unknown; ambiguous?: unknown; note?: unknown; assumed?: unknown };
  if (a.ambiguous === true) return { kind: "ambiguous", note: typeof a.note === "string" ? a.note : "" };
  // An unjustified assumption is a veto, like "ambiguous": the solver noticed the
  // statement doesn't determine the answer and filled the gap itself.
  const assumed = flagAssumptions ? realAssumption(a.assumed) : null;
  if (assumed) return { kind: "ambiguous", note: `assumed: ${assumed}` };
  return typeof a.answer === "string" && a.answer.trim() ? { kind: "answer", answer: a.answer } : { kind: "error", message: "no answer" };
}

export type CheapVerdict = {
  observations: SolverObservation[];
  invalid?: string; // the well-posedness check's reason, when it found the problem broken
  solverErrorsOnly: boolean; // every solver errored: counts toward "provider down"
};

// The writer's answer against every solver, plus the well-posedness check, all at once.
export async function cheapVerify(args: {
  problem: Problem;
  plan: Pick<GenerationPlan, "domain" | "rubric" | "answerFormat">;
  config: CheapConfig;
  call: CallOpenWeight;
  signal: AbortSignal;
  recordUsage: (model: string, u: Anthropic.Usage) => void;
}): Promise<CheapVerdict> {
  const { problem, plan, config, call, signal, recordUsage } = args;
  const validityPrompt = buildValidityPrompt({ problem: problem.problem, domain: plan.domain, answerFormat: plan.answerFormat });
  const [solves, validity] = await Promise.all([
    Promise.all(config.solvers.map((s) => solveBlind(call, s, problem.problem, plan, signal, (u) => recordUsage(s.model, u), config.flagAssumptions))),
    config.validity ? call(config.validity, validityPrompt, VALIDITY, signal, (u) => recordUsage(config.validity!.model, u)) : null,
  ]);
  const observations: SolverObservation[] = solves.map((o) =>
    o.kind === "answer"
      ? sameAnswer(problem.answer, o.answer, plan.answerFormat)
        ? { kind: "agree" }
        : { kind: "disagree", answer: o.answer }
      : o.kind === "ambiguous"
        ? { kind: "ambiguous", note: o.note }
        : { kind: "error", message: o.message }
  );
  // A validity error is not evidence either way; only an explicit "not well-posed" counts.
  const v = validity?.ok ? ((validity.args ?? {}) as { wellPosed?: unknown; reason?: unknown }) : null;
  const invalid = v && v.wellPosed === false ? (typeof v.reason === "string" && v.reason ? v.reason : "not well-posed") : undefined;
  return { observations, invalid, solverErrorsOnly: observations.every((o) => o.kind === "error") };
}
