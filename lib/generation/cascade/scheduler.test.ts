import { describe, it, expect } from "vitest";
import { initScheduler, isDone, keptCandidates, onOutcome, start, type Action, type CandidateSpec, type SchedulerState } from "./scheduler";
import { parseLadder } from "./ladder";
import { USABLE_BUDGET_MS } from "./deadline";

const ladder = parseLadder("mid", "openweight:deepseek-flash,openweight:glm-5.3,anthropic:claude-opus-5-5");
const specs = (n: number): CandidateSpec[] => Array.from({ length: n }, (_, i) => ({ hint: `h${i}` }));
const FULL = USABLE_BUDGET_MS;

function setup(over: Partial<Parameters<typeof initScheduler>[0]> = {}) {
  const s0 = initScheduler({ ladder, verified: false, specs: specs(20), count: 10, backups: 3, maxCalls: 40, ...over });
  return start(s0, FULL);
}

const launches = (a: Action[]) => a.filter((x): x is Extract<Action, { type: "launch" }> => x.type === "launch");
const aborts = (a: Action[]) => a.filter((x) => x.type === "abort").map((x) => x.candidate);

function acceptAll(s: SchedulerState): SchedulerState {
  let st = s;
  for (const c of st.candidates.filter((x) => x.status === "running")) {
    st = onOutcome(st, c.id, { kind: "accepted" }, FULL).state;
  }
  return st;
}

describe("first wave", () => {
  it("launches one candidate per objective plus the backups, all on rung 0", () => {
    const { state, actions } = setup();
    expect(launches(actions)).toHaveLength(13);
    expect(new Set(launches(actions).map((a) => a.rung))).toEqual(new Set([0]));
    expect(state.callsMade).toBe(13);
    expect(state.spares).toHaveLength(7);
  });

  it("skips straight to the top rung when a cheap rung no longer fits", () => {
    const s0 = initScheduler({ ladder, verified: false, specs: specs(10), count: 10, backups: 0, maxCalls: 40 });
    const { actions } = start(s0, 130_000);
    expect(launches(actions).every((a) => a.rung === 2)).toBe(true);
  });

  it("refuses to start without one spec per objective", () => {
    expect(() => initScheduler({ ladder, verified: false, specs: specs(9), count: 10, backups: 0, maxCalls: 40 })).toThrow();
  });
});

describe("outcomes", () => {
  it("fills the set once every objective has a kept candidate, aborting leftovers", () => {
    const { state } = setup();
    const done = acceptAll(state);
    expect(isDone(done)).toBe(true);
    expect(done.failure).toBeUndefined();
    expect(keptCandidates(done)).toHaveLength(10);
    expect(done.candidates.filter((c) => c.status === "running")).toHaveLength(0);
  });

  it("aborts the sibling on the same objective when one candidate is kept", () => {
    const { state } = setup();
    // Objective 0 has candidate 0 (primary) and candidate 10 (first backup).
    const r = onOutcome(state, 10, { kind: "accepted" }, FULL);
    expect(aborts(r.actions)).toContain(0);
    expect(r.state.objectives[0]).toMatchObject({ status: "filled", keptCandidate: 10 });
  });

  it("ignores a late result from an aborted candidate", () => {
    const { state } = setup();
    const afterBackup = onOutcome(state, 10, { kind: "accepted" }, FULL).state;
    const late = onOutcome(afterBackup, 0, { kind: "accepted" }, FULL);
    expect(late.actions).toEqual([]);
    expect(late.state.objectives[0].keptCandidate).toBe(10);
  });

  it("escalates a rejected candidate to the next rung, same spec", () => {
    const { state } = setup();
    const r = onOutcome(state, 3, { kind: "rejected", reason: "guard-problem" }, FULL);
    expect(launches(r.actions)).toEqual([{ type: "launch", candidate: 3, objective: 3, rung: 1, spec: { hint: "h3" } }]);
    expect(r.state.callsMade).toBe(14);
  });

  it("replaces a duplicate with a fresh spec on rung 0 instead of escalating", () => {
    const { state } = setup();
    const r = onOutcome(state, 5, { kind: "duplicate" }, FULL);
    const [l] = launches(r.actions);
    expect(l).toMatchObject({ objective: 5, rung: 0 });
    expect(l.spec.hint).not.toBe("h5");
    expect(r.state.candidates.find((c) => c.id === 5)?.status).toBe("ended");
  });

  it("replaces a candidate that exhausts every rung", () => {
    let { state } = setup();
    for (let i = 0; i < 2; i++) state = onOutcome(state, 4, { kind: "failed", reason: "timeout" }, FULL).state;
    const r = onOutcome(state, 4, { kind: "failed", reason: "timeout" }, FULL);
    expect(r.state.candidates.find((c) => c.id === 4)?.status).toBe("exhausted");
    expect(launches(r.actions)).toEqual([expect.objectContaining({ objective: 4, rung: 0 })]);
  });

  it("fails the set, naming the objective, when no spec is left", () => {
    const s0 = initScheduler({ ladder, verified: false, specs: specs(10), count: 10, backups: 0, maxCalls: 40 });
    let { state } = start(s0, FULL);
    for (let i = 0; i < 3; i++) state = onOutcome(state, 7, { kind: "failed" }, FULL).state;
    expect(state.failure).toEqual({ objective: 7, reason: "no distinct candidates left" });
    expect(isDone(state)).toBe(true);
    expect(state.candidates.filter((c) => c.status === "running")).toHaveLength(0);
  });

  it("fails the set when time no longer allows a replacement", () => {
    let { state } = setup();
    // Objective 7 has no backup candidate, so exhausting its only one decides it.
    for (let i = 0; i < 2; i++) state = onOutcome(state, 7, { kind: "failed" }, FULL).state;
    const r = onOutcome(state, 7, { kind: "failed" }, 10_000);
    expect(r.state.failure).toEqual({ objective: 7, reason: "not enough time left for another attempt" });
  });

  it("counts every physical call against the cap and stops escalating at it", () => {
    const { state } = setup({ maxCalls: 13 });
    const r = onOutcome(state, 3, { kind: "rejected" }, FULL);
    expect(launches(r.actions)).toHaveLength(0);
    expect(r.state.failure).toMatchObject({ objective: 3 });
  });

  it("does not escalate past the top rung", () => {
    const s0 = initScheduler({ ladder, verified: false, specs: specs(10), count: 10, backups: 0, maxCalls: 40 });
    const { state } = start(s0, 130_000); // everything starts on the top rung
    const r = onOutcome(state, 0, { kind: "rejected" }, 130_000);
    expect(r.state.candidates.find((c) => c.id === 0)?.status).toBe("exhausted");
  });
});
