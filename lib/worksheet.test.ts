import { describe, it, expect } from "vitest";
import {
  isWellFormedToken,
  linkState,
  linkExpiresAt,
  mintToken,
  progressSummary,
  publicProblems,
  resolveAnswerFormat,
  type StoredResult,
} from "./worksheet";
import type { Problem } from "./types";

const p = (n: number): Problem => ({
  problem: `Problem ${n}?`,
  answer: String(n),
  solution: `Solution ${n}.`,
});
const SET = [p(1), p(2), p(3)];

const live = { shareToken: "t".repeat(43), sentAt: new Date("2026-09-01"), status: "scheduled" };

describe("mintToken / isWellFormedToken", () => {
  it("mints 256 bits as 43 base64url chars", () => {
    const t = mintToken();
    expect(t).toHaveLength(43);
    expect(isWellFormedToken(t)).toBe(true);
  });

  it("rejects anything that isn't the right shape, before any query runs", () => {
    // A nullish value reaching findFirst({ where: { shareToken } }) matches an arbitrary
    // row — this guard is what stops that, so it has to reject non-strings too.
    expect(isWellFormedToken(undefined)).toBe(false);
    expect(isWellFormedToken(null)).toBe(false);
    expect(isWellFormedToken("")).toBe(false);
    expect(isWellFormedToken("short")).toBe(false);
    expect(isWellFormedToken("a/b+c")).toBe(false);
    expect(isWellFormedToken("x".repeat(44))).toBe(false);
  });
});

describe("linkState", () => {
  it("is live inside the window", () => {
    expect(linkState(live, new Date("2026-09-10"))).toBe("live");
  });

  it("expires 14 days after SENT, not after the session", () => {
    expect(linkState(live, new Date("2026-09-14T23:00:00Z"))).toBe("live");
    expect(linkState(live, new Date("2026-09-16"))).toBe("expired");
    expect(linkExpiresAt(live.sentAt).toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });

  it("has no link when the token is revoked, but that is not 'expired'", () => {
    // Distinct states because the student needs different copy: "turned off" vs
    // "expired on Sep 15" vs a plain 404.
    expect(linkState({ ...live, shareToken: null }, new Date("2026-09-10"))).toBe("no-link");
  });

  it("closes on a cancelled session but stays open for completed and no_show", () => {
    // Homework is normally done AFTER the session, so those two must stay live.
    expect(linkState({ ...live, status: "cancelled" }, new Date("2026-09-10"))).toBe("cancelled");
    expect(linkState({ ...live, status: "completed" }, new Date("2026-09-10"))).toBe("live");
    expect(linkState({ ...live, status: "no_show" }, new Date("2026-09-10"))).toBe("live");
    // An unknown legacy value must degrade, not throw.
    expect(linkState({ ...live, status: "nonsense" }, new Date("2026-09-10"))).toBe("live");
  });
});

describe("publicProblems — the containment rule", () => {
  it("never carries an answer or solution for an unresolved problem", () => {
    const out = publicProblems(SET, []);
    expect(JSON.stringify(out)).not.toContain("Solution");
    expect(out.every((x) => x.resolved === false)).toBe(true);
  });

  it("returns the reveal for problems already resolved, so a revisit isn't blank", () => {
    // The failure this guards: a student does 1-2 at night, comes back, and sees empty
    // cards the check endpoint then refuses as already resolved — stuck, with nothing to
    // show for the work.
    const results: StoredResult[] = [
      { index: 0, attempts: ["1"], verdict: "correct" },
      { index: 1, attempts: ["9", "8"], verdict: "wrong" },
    ];
    const out = publicProblems(SET, results);
    expect(out[0]).toMatchObject({ resolved: true, answer: "1", solution: "Solution 1." });
    expect(out[1]).toMatchObject({ resolved: true, verdict: "wrong", answer: "2" });
    expect(out[2].resolved).toBe(false);
  });

  it("keeps a part-attempted problem unresolved and reports the attempts left", () => {
    const out = publicProblems(SET, [{ index: 0, attempts: ["9"], verdict: "wrong" }]);
    expect(out[0]).toMatchObject({ resolved: false, attempts: ["9"], attemptsLeft: 1 });
    expect(JSON.stringify(out[0])).not.toContain("Solution 1");
  });
});

describe("progressSummary", () => {
  it("counts checked, right, second-try, and 1-based missed indices", () => {
    const results: StoredResult[] = [
      { index: 0, attempts: ["1"], verdict: "correct" },
      { index: 1, attempts: ["9", "8"], verdict: "wrong" },
      { index: 2, attempts: ["9", "3"], verdict: "correct" },
    ];
    expect(progressSummary(SET, results)).toEqual({
      total: 3,
      checked: 3,
      right: 2,
      missed: [2],
      secondTry: 1,
    });
  });

  it("ignores a problem that is only part-attempted", () => {
    const out = progressSummary(SET, [{ index: 0, attempts: ["9"], verdict: "wrong" }]);
    expect(out).toMatchObject({ checked: 0, right: 0, missed: [] });
  });
});

describe("resolveAnswerFormat", () => {
  it("uses a valid stored format", () => {
    const meta = { v: 1, problems: { answerFormat: "expression" } };
    expect(resolveAnswerFormat(meta, "AIME, problems 10-15")).toEqual({
      format: "expression",
      fallback: false,
    });
  });

  it("derives the format when genMeta is absent — every legacy row", () => {
    expect(resolveAnswerFormat(null, "AIME, problems 10-15")).toEqual({
      format: "integer",
      fallback: true,
    });
  });

  it("derives it when the stored value is an EMPTY STRING, which the failure path writes", () => {
    // Keying the fallback on `genMeta == null` would sail straight past this — and these
    // are precisely the rows most likely to be wrong.
    const meta = { v: 1, problems: { answerFormat: "" } };
    expect(resolveAnswerFormat(meta, "AIME, problems 10-15")).toEqual({
      format: "integer",
      fallback: true,
    });
  });

  it("falls back to short-text, never open, for a non-contest profile", () => {
    // answersMatch refuses to grade "open" at all, so falling back to it would silently
    // mark every answer wrong.
    expect(resolveAnswerFormat(null, "AP Biology, unit 3 genetics")).toEqual({
      format: "short-text",
      fallback: true,
    });
  });
});
