import { describe, it, expect } from "vitest";
import { applyAttempt } from "./apply-attempt";
import type { StoredResult } from "./worksheet";

const stored = { answer: "14", solution: "Because reasons, the answer is 14." };
const base = { index: 0, stored, format: "integer" as const, maxAttempts: 2 };

describe("applyAttempt", () => {
  it("reveals immediately on a correct first attempt", () => {
    const out = applyAttempt([], { ...base, answer: "14" });
    expect(out.verdict).toBe("correct");
    expect(out.reveal).toEqual(stored);
    expect(out.attemptsLeft).toBe(0);
    expect(out.results[0].attempts).toEqual(["14"]);
  });

  it("withholds the reveal on a first wrong attempt and leaves one try", () => {
    const out = applyAttempt([], { ...base, answer: "13" });
    expect(out.verdict).toBe("wrong");
    // The whole product is that you don't get the answer until you've committed or
    // run out. Leaking it here would make the first guess free.
    expect(out.reveal).toBeNull();
    expect(out.attemptsLeft).toBe(1);
    expect(out.results[0].revealedAt).toBeUndefined();
  });

  it("reveals once attempts are exhausted", () => {
    const first = applyAttempt([], { ...base, answer: "13" });
    const second = applyAttempt(first.results, { ...base, answer: "12" });
    expect(second.verdict).toBe("wrong");
    expect(second.reveal).toEqual(stored);
    expect(second.attemptsLeft).toBe(0);
    expect(second.results[0].attempts).toEqual(["13", "12"]);
    expect(second.results[0].revealedAt).toBeTruthy();
  });

  it("accepts a correct SECOND attempt", () => {
    const first = applyAttempt([], { ...base, answer: "13" });
    const second = applyAttempt(first.results, { ...base, answer: "14" });
    expect(second.verdict).toBe("correct");
    expect(second.reveal).toEqual(stored);
  });

  // Two tabs, or a client that retried a request which had actually landed. This must
  // reconcile to the settled state, never surface as a failure on a problem the student
  // already got right.
  it("reports alreadyResolved without consuming an attempt or mutating results", () => {
    const done = applyAttempt([], { ...base, answer: "14" });
    const again = applyAttempt(done.results, { ...base, answer: "99" });
    expect(again.alreadyResolved).toBe(true);
    expect(again.verdict).toBe("correct");
    expect(again.reveal).toEqual(stored);
    expect(again.results).toEqual(done.results);
    expect(again.results[0].attempts).toEqual(["14"]);
  });

  it("treats an exhausted-but-wrong problem as resolved too", () => {
    let r: StoredResult[] = [];
    r = applyAttempt(r, { ...base, answer: "1" }).results;
    r = applyAttempt(r, { ...base, answer: "2" }).results;
    const again = applyAttempt(r, { ...base, answer: "14" });
    expect(again.alreadyResolved).toBe(true);
    expect(again.verdict).toBe("wrong");
    expect(again.results).toEqual(r);
  });

  it("grades loosely — a student writing the variable back is correct", () => {
    const out = applyAttempt([], { ...base, answer: "x=14" });
    expect(out.verdict).toBe("correct");
  });

  it("keeps entries keyed and sorted by index across interleaved problems", () => {
    let r: StoredResult[] = [];
    r = applyAttempt(r, { ...base, index: 2, answer: "14" }).results;
    r = applyAttempt(r, { ...base, index: 0, answer: "14" }).results;
    r = applyAttempt(r, { ...base, index: 1, answer: "13" }).results;
    expect(r.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(r.find((e) => e.index === 1)?.verdict).toBe("wrong");
  });

  it("records the format fallback so a wrong grade is explainable later", () => {
    const out = applyAttempt([], { ...base, answer: "14", formatFallback: true });
    expect(out.results[0].formatFallback).toBe(true);
  });
});
