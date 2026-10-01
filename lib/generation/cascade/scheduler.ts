// The objective scheduler: a pure state machine deciding which candidate to launch,
// escalate, replace or abort. No I/O, no clock — the runner feeds it events and the
// remaining time, and performs the actions it returns. That is what lets every
// transition below be unit-tested without a model call.
//
// Vocabulary (design doc glossary):
//   objective — what one kept problem must satisfy; a set has exactly `count` of them
//   candidate — one attempt at an objective, owning a spec (seed or subtopic hint)
//   rung      — one model call for a candidate; failure moves it up the ladder
//
//   objective: open ──kept──▶ filled
//        │  (candidate exhausted + no spec/time left)
//        └──────────────▶ failed   (fails the whole set, named)
//
//   candidate: running ──accepted──▶ kept
//        │   ──rejected/failed──▶ next rung (same candidate) │ exhausted
//        │   ──duplicate──▶ ends; a replacement with a new spec is launched
//        └── objective filled elsewhere / set done ──▶ aborted
import type { RungConfig } from "@/lib/generation/cascade/ladder";
import { admitRung, canLaunchReplacement } from "@/lib/generation/cascade/deadline";

export type CandidateSpec = {
  hint: string; // what makes this candidate different: a subtopic, or a seed's id
  seedIndex?: number; // index into the anchors when the candidate transforms a seed
  // With seedIndex: REVERSE the seed instead of transposing it (hide one given, make the
  // seed's answer a given). The key is the hidden given, known without solving.
  reverse?: boolean;
  // Seeded scratch slot (seed-slots.ts): the ReferenceProblem id the variant is built
  // from, recorded per kept item so later sets never reuse the same real problem.
  seedId?: string;
};

export type CandidateStatus = "running" | "kept" | "ended" | "exhausted" | "aborted";

export type Candidate = {
  id: number;
  objective: number;
  spec: CandidateSpec;
  rung: number;
  status: CandidateStatus;
  history: { rung: number; outcome: OutcomeKind; reason?: string }[];
};

export type ObjectiveState = { index: number; status: "open" | "filled" | "failed"; keptCandidate?: number };

export type SchedulerState = {
  ladder: RungConfig[];
  verified: boolean;
  objectives: ObjectiveState[];
  candidates: Candidate[];
  spares: CandidateSpec[]; // specs not yet assigned to any candidate
  callsMade: number; // physical rung calls started (the per-request cap counts these)
  maxCalls: number;
  nextId: number;
  failure?: { objective: number; reason: string };
  // Set by initScheduler, consumed by start(): one spec per objective, plus backups.
  firstWave?: { specs: CandidateSpec[]; backups: number };
};

export type OutcomeKind = "accepted" | "duplicate" | "rejected" | "failed";
export type Outcome = { kind: OutcomeKind; reason?: string };

export type Action =
  | { type: "launch"; candidate: number; objective: number; rung: number; spec: CandidateSpec }
  | { type: "abort"; candidate: number };

export type InitOptions = {
  ladder: RungConfig[];
  verified: boolean; // adapt path: kept items need solver verification time
  specs: CandidateSpec[]; // one per objective first, the rest are spares
  count: number; // objectives in the set
  backups: number; // extra first-wave candidates, one each on the first objectives
  maxCalls: number;
};

export function initScheduler(o: InitOptions): SchedulerState {
  if (o.specs.length < o.count) {
    throw new Error(`Need at least ${o.count} candidate specs to fill ${o.count} objectives; got ${o.specs.length}.`);
  }
  return {
    ladder: o.ladder,
    verified: o.verified,
    objectives: Array.from({ length: o.count }, (_, index) => ({ index, status: "open" as const })),
    candidates: [],
    spares: o.specs.slice(o.count),
    callsMade: 0,
    maxCalls: o.maxCalls,
    nextId: 0,
    firstWave: { specs: o.specs.slice(0, o.count), backups: o.backups },
  };
}

const running = (s: SchedulerState) => s.candidates.filter((c) => c.status === "running");

// Launch one candidate at `wanted` (or the top rung, if only that still fits).
// Returns the action, or null when neither time nor the call cap allows it.
function launch(
  s: SchedulerState,
  objective: number,
  spec: CandidateSpec,
  wanted: number,
  remainingMs: number
): { state: SchedulerState; action: Action } | null {
  if (s.callsMade >= s.maxCalls) return null;
  const rung = admitRung(remainingMs, s.ladder, wanted, s.verified);
  if (rung === null) return null;
  const c: Candidate = { id: s.nextId, objective, spec, rung, status: "running", history: [] };
  return {
    state: { ...s, nextId: s.nextId + 1, callsMade: s.callsMade + 1, candidates: [...s.candidates, c] },
    action: { type: "launch", candidate: c.id, objective, rung, spec },
  };
}

// The first wave: one candidate per objective, plus `backups` extra candidates on the
// first objectives (drawn from the spares) so an early failure already has a sibling.
export function start(state: SchedulerState, remainingMs: number): { state: SchedulerState; actions: Action[] } {
  const wave = state.firstWave;
  let s: SchedulerState = { ...state, firstWave: undefined };
  const actions: Action[] = [];
  const specs = wave?.specs ?? [];
  specs.forEach((spec, objective) => {
    const r = launch(s, objective, spec, 0, remainingMs);
    if (r) {
      s = r.state;
      actions.push(r.action);
    }
  });
  for (let b = 0; b < (wave?.backups ?? 0) && s.spares.length > 0; b++) {
    const objective = b % s.objectives.length;
    const [spec, ...rest] = s.spares;
    const r = launch({ ...s, spares: rest }, objective, spec, 0, remainingMs);
    if (!r) break;
    s = r.state;
    actions.push(r.action);
  }
  return settle(s, actions, remainingMs);
}

function update(s: SchedulerState, id: number, patch: Partial<Candidate>): SchedulerState {
  return { ...s, candidates: s.candidates.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

// Handle one finished rung call. `remainingMs` is the time left when it finished.
export function onOutcome(
  state: SchedulerState,
  candidateId: number,
  outcome: Outcome,
  remainingMs: number
): { state: SchedulerState; actions: Action[] } {
  const c = state.candidates.find((x) => x.id === candidateId);
  // A result for a candidate that was aborted (or is otherwise finished) is ignored:
  // late completions after abort are never kept.
  if (!c || c.status !== "running") return { state, actions: [] };
  let s = update(state, c.id, { history: [...c.history, { rung: c.rung, outcome: outcome.kind, reason: outcome.reason }] });
  const actions: Action[] = [];
  const obj = s.objectives[c.objective];

  if (outcome.kind === "accepted") {
    if (obj.status !== "open") {
      // Another candidate already filled it; this surplus result is discarded.
      s = update(s, c.id, { status: "aborted" });
    } else {
      s = update(s, c.id, { status: "kept" });
      s = { ...s, objectives: s.objectives.map((o) => (o.index === obj.index ? { ...o, status: "filled", keptCandidate: c.id } : o)) };
      // Siblings working on the same objective are no longer needed.
      for (const sib of running(s).filter((x) => x.objective === obj.index)) {
        s = update(s, sib.id, { status: "aborted" });
        actions.push({ type: "abort", candidate: sib.id });
      }
    }
    return settle(s, actions, remainingMs);
  }

  if (outcome.kind === "duplicate") {
    // A diversity problem, not a quality one: don't spend a stronger model on it.
    // End this candidate and let settle() launch a replacement with a fresh spec.
    s = update(s, c.id, { status: "ended" });
    return settle(s, actions, remainingMs);
  }

  // rejected / failed: escalate the same candidate to the next rung, if time allows.
  const next = c.rung + 1;
  if (next < s.ladder.length && s.callsMade < s.maxCalls) {
    const rung = admitRung(remainingMs, s.ladder, next, s.verified);
    if (rung !== null) {
      s = update(s, c.id, { rung });
      s = { ...s, callsMade: s.callsMade + 1 };
      actions.push({ type: "launch", candidate: c.id, objective: c.objective, rung, spec: c.spec });
      return settle(s, actions, remainingMs);
    }
  }
  s = update(s, c.id, { status: "exhausted" });
  return settle(s, actions, remainingMs);
}

// After any transition: give every open objective with nothing running a replacement,
// fail an objective that can't get one, and abort everything once the set is decided.
function settle(state: SchedulerState, actions: Action[], remainingMs: number): { state: SchedulerState; actions: Action[] } {
  let s = state;
  if (!s.failure) {
    for (const obj of s.objectives) {
      if (obj.status !== "open") continue;
      if (running(s).some((c) => c.objective === obj.index)) continue;
      const canReplace = s.spares.length > 0 && canLaunchReplacement(remainingMs, s.ladder, s.verified);
      const r = canReplace ? launch({ ...s, spares: s.spares.slice(1) }, obj.index, s.spares[0], 0, remainingMs) : null;
      if (r) {
        s = r.state;
        actions.push(r.action);
        continue;
      }
      const reason =
        s.spares.length === 0
          ? "no distinct candidates left"
          : s.callsMade >= s.maxCalls
            ? "call budget exhausted"
            : "not enough time left for another attempt";
      s = {
        ...s,
        objectives: s.objectives.map((o) => (o.index === obj.index ? { ...o, status: "failed" } : o)),
        failure: { objective: obj.index, reason },
      };
      break;
    }
  }
  if (isDone(s)) {
    for (const c of running(s)) {
      s = update(s, c.id, { status: "aborted" });
      actions.push({ type: "abort", candidate: c.id });
    }
  }
  return { state: s, actions };
}

export function isDone(s: SchedulerState): boolean {
  return Boolean(s.failure) || s.objectives.every((o) => o.status === "filled");
}

export function keptCandidates(s: SchedulerState): Candidate[] {
  return s.objectives
    .map((o) => (o.keptCandidate === undefined ? undefined : s.candidates.find((c) => c.id === o.keptCandidate)))
    .filter((c): c is Candidate => Boolean(c));
}
