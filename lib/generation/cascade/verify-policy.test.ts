import { describe, it, expect } from "vitest";
import { decideVerification, type SolverObservation } from "./verify-policy";

const agree: SolverObservation = { kind: "agree" };
const disagree: SolverObservation = { kind: "disagree", answer: "23" };
const error: SolverObservation = { kind: "error", message: "timeout" };

describe("decideVerification", () => {
  it("keeps a verified item when the solver agrees", () => {
    expect(decideVerification([agree], false)).toEqual({ action: "keep", verdict: "verified" });
  });

  it("keeps an item a majority vote upholds", () => {
    expect(decideVerification([disagree, agree, agree], false)).toEqual({ action: "keep", verdict: "verified" });
  });

  it("replaces an item whose disagreement isn't outvoted", () => {
    expect(decideVerification([disagree], false)).toEqual({ action: "replace", reason: "solver-disagree" });
    expect(decideVerification([disagree, agree], false)).toMatchObject({ action: "replace" });
  });

  // The case the review flagged: writer says 17, solver says 23, the next solve times
  // out. Collapsing that to "error → unverified" would ship a contradicted answer.
  it("never ships an item after a disagreement, even if later votes errored", () => {
    expect(decideVerification([disagree, error, error], false)).toEqual({ action: "replace", reason: "solver-disagree" });
    expect(decideVerification([disagree, agree, error], false)).toMatchObject({ action: "replace" });
  });

  it("keeps an item unverified when the solver only errored", () => {
    expect(decideVerification([error], false)).toEqual({ action: "keep", verdict: "unverified" });
    expect(decideVerification([], false)).toEqual({ action: "keep", verdict: "unverified" });
  });

  it("replaces an ill-posed statement", () => {
    expect(decideVerification([{ kind: "ambiguous", note: "two answers" }], false)).toEqual({
      action: "replace",
      reason: "solver-ambiguous",
    });
  });

  it("fails the set when the solver's provider is down for the request", () => {
    expect(decideVerification([agree], true)).toEqual({ action: "fail-set", reason: "provider-unavailable" });
  });
});
