// What to do with a candidate once the independent solver has weighed in (adapt path).
// Pure: takes the individual solver observations and returns a decision, so the rules
// the review settled are tested directly rather than inferred from solve.ts's control
// flow. The earlier plan contradicted itself (solver error ⇒ ship unverified, yet an
// outage ⇒ fail); worse, collapsing observations let a transport error erase a real
// disagreement that came before it.
//
//   all answers agree with the writer (majority)        → keep ("verified")
//   a disagreement that isn't outvoted                  → replace (new candidate)
//   an ambiguous-statement verdict                      → replace
//   only transport errors, no disagreement seen         → keep, marked "unverified"
//   a transport error AFTER a disagreement              → replace, never ship
//   the solver's provider is down for the whole request → fail the set loudly

export type SolverObservation =
  | { kind: "agree" }
  | { kind: "disagree"; answer: string }
  | { kind: "ambiguous"; note: string }
  | { kind: "error"; message: string };

export type VerifyDecision =
  | { action: "keep"; verdict: "verified" | "unverified" }
  | { action: "replace"; reason: "solver-disagree" | "solver-ambiguous" }
  | { action: "fail-set"; reason: "provider-unavailable" };

export function decideVerification(obs: SolverObservation[], solverProviderDown: boolean): VerifyDecision {
  if (solverProviderDown) return { action: "fail-set", reason: "provider-unavailable" };
  if (obs.some((o) => o.kind === "ambiguous")) return { action: "replace", reason: "solver-ambiguous" };

  const agree = obs.filter((o) => o.kind === "agree").length;
  const disagree = obs.filter((o) => o.kind === "disagree").length;
  const answered = agree + disagree;

  if (disagree > 0) {
    // Kept only if a strict majority of the answers that came back agree. Errors are
    // not votes: they can neither outvote a disagreement nor count as agreement.
    return agree > disagree && agree * 2 > answered
      ? { action: "keep", verdict: "verified" }
      : { action: "replace", reason: "solver-disagree" };
  }
  if (agree > 0) return { action: "keep", verdict: "verified" };
  // Nothing but errors (or nothing at all): the writer's own answer passed its guards,
  // and there is no evidence against it — today's non-blocking behavior.
  return { action: "keep", verdict: "unverified" };
}
