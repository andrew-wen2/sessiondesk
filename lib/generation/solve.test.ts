import { describe, it, expect, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { solveProblem } from "./solve";

// A minimal fake Anthropic client — solveProblem only ever calls
// client.messages.create, so that's the only surface mocked.
function fakeClient(responses: Array<{ answer: string; ambiguous?: boolean; note?: string } | "truncate" | "no_tool">) {
  let i = 0;
  const create = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r === "truncate") {
      return { stop_reason: "max_tokens", content: [], usage: {} } as unknown as Anthropic.Message;
    }
    if (r === "no_tool") {
      return { stop_reason: "end_turn", content: [], usage: {} } as unknown as Anthropic.Message;
    }
    return {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "t1", name: "emit_solve", input: r }],
      usage: {},
    } as unknown as Anthropic.Message;
  });
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

const baseArgs = {
  effort: "high" as const,
  problem: "What is 2+2?",
  domain: "arithmetic",
  rubric: "",
  answerFormat: "integer" as const,
  generatorAnswer: "4",
  maxEscalations: 3,
  recordUsage: () => {},
};

describe("solveProblem", () => {
  it("agrees with the generator in one call — no escalation", async () => {
    const { client, create } = fakeClient([{ answer: "4", ambiguous: false }]);
    const result = await solveProblem({ client, model: "m", escalateModel: "m", ...baseArgs });
    expect(result.kind).toBe("answer");
    if (result.kind === "answer") {
      expect(result.agreesWithGenerator).toBe(true);
      expect(result.crossFamily).toBe(true);
      expect(result.attempts).toBe(1);
    }
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("escalates on disagreement and reaches majority", async () => {
    const { client, create } = fakeClient([
      { answer: "5", ambiguous: false }, // round 1: disagrees with generator's "4"
      { answer: "5", ambiguous: false }, // escalation: matches round 1 → majority of 2
    ]);
    const result = await solveProblem({ client, model: "m", escalateModel: "m", ...baseArgs });
    expect(result.kind).toBe("answer");
    if (result.kind === "answer") {
      expect(result.answer).toBe("5");
      expect(result.agreesWithGenerator).toBe(false); // "5" != generator's "4"
      expect(result.crossFamily).toBe(false); // majority formed across Opus-only escalation
      expect(result.attempts).toBe(2);
    }
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("reports no-consensus and respects the escalation cap", async () => {
    const { client, create } = fakeClient([
      { answer: "1", ambiguous: false },
      { answer: "2", ambiguous: false },
      { answer: "3", ambiguous: false },
    ]);
    const result = await solveProblem({
      client,
      model: "m",
      escalateModel: "m",
      ...baseArgs,
      maxEscalations: 2, // total attempts capped at 3
    });
    expect(result.kind).toBe("no-consensus");
    if (result.kind === "no-consensus") expect(result.attempts).toBe(3);
    expect(create).toHaveBeenCalledTimes(3); // never exceeds 1 + maxEscalations
  });

  it("skips solving entirely for the open answer format", async () => {
    const { client, create } = fakeClient([{ answer: "irrelevant" }]);
    const result = await solveProblem({
      client,
      model: "m",
      escalateModel: "m",
      ...baseArgs,
      answerFormat: "open",
    });
    expect(result.kind).toBe("not-applicable");
    expect(create).not.toHaveBeenCalled();
  });

  it("reports ambiguous when the solver flags the problem as ill-posed", async () => {
    const { client } = fakeClient([{ answer: "", ambiguous: true, note: "missing a constraint" }]);
    const result = await solveProblem({ client, model: "m", escalateModel: "m", ...baseArgs });
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.note).toBe("missing a constraint");
  });

  it("is non-blocking on a solver error", async () => {
    const create = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const client = { messages: { create } } as unknown as Anthropic;
    const result = await solveProblem({ client, model: "m", escalateModel: "m", ...baseArgs });
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("connection reset");
  });
});
