// The cascade runner: performs what the scheduler decides. It owns everything with a
// side effect — model calls, the rung deadline, cancellation, provider permits, the
// circuit breaker — and reports each finished call back to the pure scheduler.
//
//   start ──▶ launch actions ──▶ attempt(): permit → writer → guards → [verify]
//                  ▲                                  │
//                  └──── onOutcome() ◀── dedup at keep time ◀── first result to settle
//
// Guarantees the review asked for, each covered by run.test.ts:
//  - a candidate aborted (sibling won, set done) is never kept, and its late
//    completion raises no unhandled rejection;
//  - every rung call runs under an AbortSignal that fires at the rung's timeout;
//  - dedup happens when a result is about to be KEPT, not at launch, so two
//    candidates finishing in the same tick can't both land. It ALSO runs once before
//    verification, against what is kept at that moment, so a duplicate doesn't pay for
//    solver calls first (14 of 40 rejections in the last Opus sets were duplicates);
//  - a provider failing repeatedly is skipped for the rest of the request, and if
//    that provider is the top rung (or the solver) the set fails loudly by name.
import type Anthropic from "@anthropic-ai/sdk";
import type { CandidateRejection, CascadeRunMeta, FinishReason, ItemDifficulty, VerificationVerdict } from "@/lib/generation/gen-meta";
import type { RungConfig, RungProvider } from "@/lib/generation/cascade/ladder";
import { rungCostMs } from "@/lib/generation/cascade/deadline";
import {
  initScheduler,
  isDone,
  onOutcome,
  start,
  type Action,
  type CandidateSpec,
  type Outcome,
} from "@/lib/generation/cascade/scheduler";
import { decideVerification, type SolverObservation } from "@/lib/generation/cascade/verify-policy";
import { RungError, type Writers } from "@/lib/generation/cascade/writers";
import type { Semaphore } from "@/lib/generation/cascade/semaphore";
import type { Problem } from "@/lib/types";

// `notApplicable`: this candidate has nothing to verify against (a scratch spec in a
// set that also has seed-based ones, or an "open" answer format). It is kept with the
// "not-applicable" verdict, never mislabeled "unverified".
// `rejection`: a check that isn't a solver vote said no (the well-posedness check, the
// difficulty filter); it replaces the candidate like a disagreement would.
// `difficulty`: the weak-solver pass rate, recorded on the kept item.
export type Verify = (
  problem: Problem,
  spec: CandidateSpec,
  isTopRung: boolean,
  signal: AbortSignal,
  writerModel: string,
  objective: number
) => Promise<{
  observations: SolverObservation[];
  providerDown: boolean;
  notApplicable?: boolean;
  rejection?: CandidateRejection;
  difficulty?: ItemDifficulty;
  placement?: ItemPlacement; // difficulty judge (difficulty-judge.ts), recorded on the kept item
}>;
export type ItemPlacement = { rating: number; target?: number };

export type RunInput = {
  ladder: RungConfig[];
  writers: Writers;
  specs: CandidateSpec[];
  count: number;
  backups: number;
  maxCalls: number;
  verified: boolean; // run `verify` on each candidate before it can be kept
  buildRequest: (args: { objective: number; spec: CandidateSpec; kept: Problem[]; rung: RungConfig }) => { system: string; user: string };
  check: (problem: Problem, spec: CandidateSpec) => CandidateRejection | null;
  isDuplicate: (problem: Problem, kept: Problem[], spec: CandidateSpec) => boolean;
  // Optional async duplicate check (method-level dedup), run once per candidate after
  // the guards and before verification, against what is kept at that moment.
  screen?: (problem: Problem, kept: Problem[], spec: CandidateSpec, signal: AbortSignal) => Promise<boolean>;
  verify?: Verify;
  deadlineAt: number; // epoch ms by which every rung must have finished
  now?: () => number;
  signal?: AbortSignal; // request-level cancellation
  semaphores?: Partial<Record<RungProvider, Semaphore>>;
  breakerThreshold?: number; // provider-level failures before a provider is skipped
  recordUsage: (provider: RungProvider, model: string, u: Anthropic.Usage) => void;
  // Optional per-request spend ceiling: once reached, nothing new launches.
  budget?: { spentUsd: () => number; maxUsd: number };
};

export type RunResult = {
  ok: boolean;
  problems: Problem[]; // ordered by objective, i.e. easiest → hardest
  verdicts: VerificationVerdict[];
  failure?: { objective?: number; reason: string; dropReason: "slot-exhausted" | "provider-unavailable" };
  meta: CascadeRunMeta;
};

type AttemptResult = {
  candidate: number;
  rung: number;
  spec: CandidateSpec;
  problem?: Problem;
  finish: FinishReason;
  rejection?: CandidateRejection;
  verdict?: VerificationVerdict;
  failSet?: boolean; // the solver's provider is down
  duplicate?: boolean; // caught by the pre-verification dedup check
  difficulty?: ItemDifficulty;
  placement?: ItemPlacement;
  providerLevel?: boolean;
  message?: string;
  timing?: CandidateTiming;
};

// Where one candidate's time went (ms). queue: waiting for a provider permit; write: the
// writer call (to success, error or its deadline); check: guards, dedup and verification
// after a written problem. Candidates cancelled mid-flight never report back.
type CandidateTiming = { queueMs: number; writeMs?: number; checkMs?: number };

export async function runCascade(input: RunInput): Promise<RunResult> {
  const now = input.now ?? Date.now;
  const remaining = () => input.deadlineAt - now();
  const top = input.ladder.length - 1;
  const threshold = input.breakerThreshold ?? 3;

  const controllers = new Map<number, AbortController>();
  const inflight = new Map<number, Promise<AttemptResult>>();
  const kept = new Map<number, { problem: Problem; verdict: VerificationVerdict; rung: number; difficulty?: ItemDifficulty; placement?: ItemPlacement }>();
  const history = new Map<number, CascadeRunMeta["items"][number]["history"]>();
  const providerFailures = new Map<RungProvider, number>();
  const finishes: CascadeRunMeta["finishes"] = {};
  const rejections: CascadeRunMeta["rejections"] = {};
  let aborted = 0;
  const timings: NonNullable<CascadeRunMeta["timings"]> = [];
  let setFailure: RunResult["failure"];

  const tripped = (p: RungProvider) => (providerFailures.get(p) ?? 0) >= threshold;

  const keptProblems = () => [...kept.values()].map((k) => k.problem);

  async function attempt(candidate: number, rungIndex: number, objective: number, spec: CandidateSpec): Promise<AttemptResult> {
    const marks: { start: number; acquired?: number; written?: number } = { start: now() };
    const r = await attemptInner(candidate, rungIndex, objective, spec, marks);
    const end = now();
    const acquired = marks.acquired ?? end;
    return {
      ...r,
      timing: {
        queueMs: acquired - marks.start,
        ...(marks.acquired !== undefined ? { writeMs: (marks.written ?? end) - marks.acquired } : {}),
        ...(marks.written !== undefined ? { checkMs: end - marks.written } : {}),
      },
    };
  }

  async function attemptInner(
    candidate: number,
    rungIndex: number,
    objective: number,
    spec: CandidateSpec,
    marks: { acquired?: number; written?: number }
  ): Promise<AttemptResult> {
    const rung = input.ladder[rungIndex];
    const controller = new AbortController();
    controllers.set(candidate, controller);
    const onRequestAbort = () => controller.abort("request-aborted");
    input.signal?.addEventListener("abort", onRequestAbort, { once: true });
    let release: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const base = { candidate, rung: rungIndex, spec };
    try {
      if (tripped(rung.provider)) return { ...base, finish: "api-error", message: `${rung.provider} skipped after repeated failures` };
      const writer = input.writers[rung.provider];
      if (!writer) return { ...base, finish: "api-error", message: `no writer configured for ${rung.provider}` };

      release = await input.semaphores?.[rung.provider]?.acquire(controller.signal);
      marks.acquired = now();
      // Admission is rechecked after waiting for a permit: queueing ate into the time
      // the scheduler thought this rung had.
      if (remaining() < rungCostMs(rung, input.verified)) return { ...base, finish: "timeout", message: "no time left after waiting for a permit" };

      timer = setTimeout(() => controller.abort("rung-timeout"), rung.timeoutMs);
      const { system, user } = input.buildRequest({ objective, spec, kept: keptProblems(), rung });
      const write = () =>
        writer({ rung, system, user, signal: controller.signal, recordUsage: (u) => input.recordUsage(rung.provider, rung.model, u) });
      let problem: Problem;
      try {
        problem = await write();
      } catch (e) {
        // The top rung has nowhere to escalate, and with thinking on a model may answer
        // in prose instead of calling the tool: give it one same-rung retry, inside the
        // same deadline, before the candidate counts as failed.
        if (rungIndex === top && e instanceof RungError && e.finish === "missing-tool-call" && !controller.signal.aborted) {
          problem = await write();
        } else throw e;
      }
      clearTimeout(timer);
      timer = undefined;
      marks.written = now();

      const rejection = input.check(problem, spec);
      if (rejection) return { ...base, problem, finish: "ok", rejection };
      if (input.verified && input.verify && input.isDuplicate(problem, keptProblems(), spec)) return { ...base, problem, finish: "ok", duplicate: true };
      if (input.screen && (await input.screen(problem, keptProblems(), spec, controller.signal))) return { ...base, problem, finish: "ok", duplicate: true };

      if (input.verified && input.verify) {
        const v = await input.verify(problem, spec, rungIndex === top, controller.signal, rung.model, objective);
        if (v.notApplicable) return { ...base, problem, finish: "ok", verdict: "not-applicable" };
        const decision = decideVerification(v.observations, v.providerDown);
        if (decision.action === "fail-set") return { ...base, problem, finish: "ok", failSet: true };
        // A named check (a broken statement, off-target difficulty) says more than the
        // solver split it usually causes, so it is recorded first.
        if (v.rejection) return { ...base, problem, finish: "ok", rejection: v.rejection };
        if (decision.action === "replace") return { ...base, problem, finish: "ok", rejection: decision.reason };
        return { ...base, problem, finish: "ok", verdict: decision.verdict, difficulty: v.difficulty, placement: v.placement };
      }
      return { ...base, problem, finish: "ok", verdict: "not-applicable" };
    } catch (e) {
      if (e instanceof RungError) return { ...base, finish: e.finish, providerLevel: e.providerLevel, message: e.message };
      if (controller.signal.aborted) {
        return { ...base, finish: controller.signal.reason === "rung-timeout" ? "timeout" : "aborted" };
      }
      return { ...base, finish: "api-error", message: e instanceof Error ? e.message : String(e) };
    } finally {
      if (timer) clearTimeout(timer);
      release?.();
      input.signal?.removeEventListener("abort", onRequestAbort);
    }
  }

  function perform(actions: Action[]): void {
    for (const a of actions) {
      if (a.type === "abort") {
        controllers.get(a.candidate)?.abort("sibling-kept");
        if (inflight.delete(a.candidate)) aborted++;
        continue;
      }
      if (input.budget && input.budget.spentUsd() >= input.budget.maxUsd) {
        // Spend ceiling reached: report the launch as failed without calling anyone.
        inflight.set(
          a.candidate,
          Promise.resolve({ candidate: a.candidate, rung: a.rung, spec: a.spec, finish: "aborted", message: "spend ceiling reached" })
        );
        continue;
      }
      inflight.set(a.candidate, attempt(a.candidate, a.rung, a.objective, a.spec));
    }
  }

  let { state, actions } = start(
    initScheduler({
      ladder: input.ladder,
      verified: input.verified,
      specs: input.specs,
      count: input.count,
      backups: input.backups,
      maxCalls: input.maxCalls,
    }),
    remaining()
  );
  perform(actions);

  while (!isDone(state) && !setFailure) {
    if (inflight.size === 0) {
      setFailure = { reason: "no candidates in flight", dropReason: "slot-exhausted" };
      break;
    }
    const r = await Promise.race(inflight.values());
    inflight.delete(r.candidate);
    controllers.delete(r.candidate);

    finishes[r.finish] = (finishes[r.finish] ?? 0) + 1;
    if (r.rejection) rejections[r.rejection] = (rejections[r.rejection] ?? 0) + 1;
    const h = history.get(r.candidate) ?? [];
    h.push({ rung: r.rung, finish: r.finish, ...(r.rejection ? { rejection: r.rejection } : {}) });
    if (r.timing) {
      const outcome = r.finish !== "ok" ? r.finish : (r.rejection ?? (r.duplicate ? "duplicate" : "passed"));
      timings.push({ candidate: r.candidate, objective: state.candidates.find((c) => c.id === r.candidate)?.objective ?? -1, outcome, ...r.timing });
    }
    history.set(r.candidate, h);
    if (r.message) console.warn(`[cascade] candidate ${r.candidate} rung ${r.rung}: ${r.finish} — ${r.message}`);

    if (r.failSet) {
      setFailure = { reason: "the solver's provider is unavailable", dropReason: "provider-unavailable" };
      break;
    }
    if (r.providerLevel) {
      const p = input.ladder[r.rung].provider;
      providerFailures.set(p, (providerFailures.get(p) ?? 0) + 1);
      if (tripped(p) && input.ladder[top].provider === p) {
        setFailure = { reason: `${p} (the top rung) is unavailable`, dropReason: "provider-unavailable" };
        break;
      }
    }

    // An input-budget freeze: once the ceiling is hit, stop the scheduler launching.
    if (input.budget && input.budget.spentUsd() >= input.budget.maxUsd) state = { ...state, maxCalls: state.callsMade };

    let outcome: Outcome;
    if (r.finish !== "ok") outcome = { kind: "failed", reason: r.finish };
    else if (r.rejection) outcome = { kind: "rejected", reason: r.rejection };
    else if (r.problem && (r.duplicate || input.isDuplicate(r.problem, keptProblems(), r.spec))) {
      rejections.duplicate = (rejections.duplicate ?? 0) + 1;
      h[h.length - 1] = { ...h[h.length - 1], rejection: "duplicate" };
      outcome = { kind: "duplicate" };
    } else outcome = { kind: "accepted" };

    ({ state, actions } = onOutcome(state, r.candidate, outcome, remaining()));
    const cand = state.candidates.find((c) => c.id === r.candidate);
    if (outcome.kind === "accepted" && cand?.status === "kept" && r.problem) {
      kept.set(cand.objective, { problem: r.problem, verdict: r.verdict ?? "not-applicable", rung: r.rung, difficulty: r.difficulty, placement: r.placement });
    }
    perform(actions);
  }

  // Whatever is still running is no longer needed. Their promises never reject
  // (attempt() catches everything), so nothing surfaces as an unhandled rejection.
  for (const [id, c] of controllers) {
    c.abort("set-decided");
    if (inflight.delete(id)) aborted++;
  }

  const failure: RunResult["failure"] =
    setFailure ??
    (state.failure ? { objective: state.failure.objective, reason: state.failure.reason, dropReason: "slot-exhausted" } : undefined);

  const order = [...kept.keys()].sort((a, b) => a - b);
  const items: CascadeRunMeta["items"] = order.map((objective) => {
    const k = kept.get(objective)!;
    const candidate = state.objectives[objective].keptCandidate!;
    const seedId = state.candidates.find((c) => c.id === candidate)?.spec.seedId;
    return {
      objective,
      rung: k.rung,
      model: input.ladder[k.rung].model,
      verdict: k.verdict,
      history: history.get(candidate) ?? [],
      ...(k.difficulty ? { difficulty: k.difficulty } : {}),
      ...(k.problem.method ? { method: k.problem.method } : {}),
      ...(k.placement ? { placement: k.placement } : {}),
      ...(seedId ? { seedId } : {}),
    };
  });

  const ok = !failure && order.length === input.count;
  return {
    ok,
    problems: order.map((o) => kept.get(o)!.problem),
    verdicts: order.map((o) => kept.get(o)!.verdict),
    failure: ok ? undefined : (failure ?? { reason: "set incomplete", dropReason: "slot-exhausted" }),
    meta: {
      ladder: input.ladder.map((r) => ({ provider: r.provider, model: r.model })),
      items,
      candidatesLaunched: state.nextId,
      candidatesAborted: aborted,
      callsMade: state.callsMade,
      timings,
      finishes,
      rejections,
      ...(failure ? { failure: { objective: failure.objective ?? -1, reason: failure.reason } } : {}),
    },
  };
}
