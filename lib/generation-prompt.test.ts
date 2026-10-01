import { describe, expect, it } from "vitest";
import { buildConstructPrompt, buildProblemTypesPrompt } from "@/lib/generation-prompt";
import type { GenerationPlan } from "@/lib/generation/plan";

const plan: GenerationPlan = {
  domain: "Competition math (AMC10)",
  contentType: "math",
  tier: "easy",
  answerFormat: "numeric",
  rubric: "AMC 10 calibration: difficulty ramps with problem number.",
  competition: "AMC10",
  bandLow: 1,
  bandHigh: 15,
  category: "algebra",
  source: "corpus",
};

describe("buildConstructPrompt", () => {
  const { system, user } = buildConstructPrompt({
    plan,
    profile: "AMC 10, problems 1-15",
    topic: "linear systems",
    recentTopics: ["quadratics"],
    anchors: [{ source: "AMC10", number: 7, statement: "What is 2+2? (A) 1 (B) 2 (C) 3 (D) 4 (E) 5", answer: "4", solution: "2+2=4" }],
    avoidStatements: [],
    slot: { index: 2, of: 10, hint: "word problem" },
  });

  it("keeps every calibration input the cascade prompt uses", () => {
    expect(system).toContain(plan.rubric);
    expect(system).toContain("AMC10 problems 1–15");
    expect(user).toContain("AMC 10, problems 1-15");
    expect(user).toContain("linear systems");
    expect(user).toContain("quadratics");
    expect(user).toContain("[AMC10 #7] What is 2+2?");
    expect(user).toContain("problem 3 of a 10-problem set");
    expect(user).toContain("word problem");
  });

  it("asks only for the statement, the private answer and the construction", () => {
    expect(system).toContain('"problem"');
    expect(system).toContain('"intended"');
    expect(system).toContain('"construction"');
    // The cascade prompt's fields and solving instructions are what the writer
    // used to dither over; none of them may come back.
    expect(system + user).not.toMatch(/"solution"|solutionSketch|"answer" field|emit_problems|fully solve/);
    // Anchor answers and answer choices would hand the writer a template to copy.
    expect(user).not.toMatch(/\(A\)|answer: 4/);
  });

  it("bounds the construction: one check, and new values instead of repairs", () => {
    expect(system).toMatch(/Check once/);
    expect(system).toMatch(/do not repair it/);
  });
});

describe("buildConstructPrompt for the cascade writers", () => {
  const base = { plan, profile: "AMC 10, problems 1-15", topic: "linear systems", recentTopics: [], avoidStatements: [] };

  it("asks emit_problems for a student-facing solution written from the construction", () => {
    const { system, user } = buildConstructPrompt({ ...base, output: "problems" });
    expect(system).toMatch(/emit_problems with exactly one entry/);
    expect(system).toMatch(/"solution" \(a short forward solution/);
    expect(system + user).not.toMatch(/"intended"|emit_problem\b/);
  });

  it("aims one problem at its slot's target and shows one reference for difficulty only", () => {
    const reference = { source: "AMC10", number: 12, statement: "How many primes divide 2024? (A) 1 (B) 2 (C) 3 (D) 4 (E) 5", answer: "3", solution: null };
    const anchors = [{ source: "AMC10", number: 3, statement: "Band anchor that should not appear", answer: "1", solution: null }];
    const { system, user } = buildConstructPrompt({ ...base, anchors, output: "problems", target: { number: 12, reference } });
    expect(system).toContain("THIS problem's target is AMC10 #12");
    expect(system).not.toMatch(/err simpler|hard end of this band/);
    expect(user).toContain("How many primes divide 2024?");
    expect(user).toMatch(/ONLY so you can feel the difficulty/);
    expect(user).not.toMatch(/\(A\)|Band anchor/);
  });
});

describe("repetition prompts", () => {
  it("tells the writer which problems the student already worked", () => {
    const { user } = buildConstructPrompt({ plan, profile: "p", topic: "t", recentTopics: [], avoidStatements: [], seenStatements: ["Two hoses fill a pool in 6 hours."] });
    expect(user).toMatch(/already worked in recent sessions/);
    expect(user).toContain("Two hoses fill a pool in 6 hours.");
    expect(buildConstructPrompt({ plan, profile: "p", topic: "t", recentTopics: [], avoidStatements: [] }).user).not.toMatch(/recent sessions/);
  });

  it("asks for types that differ in the underlying idea, fresh ones first", () => {
    const { system, user } = buildProblemTypesPrompt({ domain: "Competition math (AMC10)", competition: "AMC10", bandLow: 10, bandHigh: 15, profile: "AMC 10 Problems 10-15", topic: "quadratics", excludedTypes: ["work-rate: two agents"], count: 16 });
    expect(system).toContain("List 16 distinct PROBLEM TYPES");
    expect(system).toContain("AMC10 problems #10–15");
    expect(system).toMatch(/same underlying trick are ONE type/);
    // Exclusion by name, as a hard rule: raw problems + a soft hint got echoed back as types.
    expect(user).toContain("- work-rate: two agents");
    expect(user).toMatch(/EXCLUDED types/);
    expect(system).toMatch(/list NONE of them/);
  });
});
