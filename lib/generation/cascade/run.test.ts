import { describe, it, expect, vi, afterEach } from "vitest";
import { runCascade, type RunInput } from "./run";
import { parseLadder, type RungConfig } from "./ladder";
import { RungError, type Writer, type WriteRequest } from "./writers";
import { Semaphore } from "./semaphore";

// A fake writer driven by a script keyed on (model, call number for that model).
// Each entry is what that call does: return a problem, throw a RungError, or hang
// until its signal aborts (to exercise the rung deadline).
type Step = { problem: string } | { error: RungError } | "hang";

function scriptedWriter(script: (req: WriteRequest, n: number) => Step): { writer: Writer; calls: WriteRequest[] } {
  const calls: WriteRequest[] = [];
  const writer: Writer = (req) => {
    calls.push(req);
    const step = script(req, calls.length - 1);
    if (step === "hang") {
      return new Promise((_, reject) => {
        req.signal.addEventListener("abort", () =>
          reject(new RungError(req.signal.reason === "rung-timeout" ? "timeout" : "aborted", "aborted"))
        );
      });
    }
    if ("error" in step) return Promise.reject(step.error);
    req.recordUsage({ input_tokens: 10, output_tokens: 20 } as never);
    return Promise.resolve({ problem: step.problem, answer: "1", solution: "s" });
  };
  return { writer, calls };
}

const fast = (ladder: RungConfig[]) => ladder.map((r) => ({ ...r, timeoutMs: 40 }));

function baseInput(over: Partial<RunInput> = {}): RunInput {
  const ladder = fast(parseLadder("mid", "openweight:deepseek-flash,anthropic:claude-opus-5-5"));
  return {
    ladder,
    writers: {},
    specs: Array.from({ length: 6 }, (_, i) => ({ hint: `h${i}` })),
    count: 3,
    backups: 0,
    maxCalls: 40,
    verified: false,
    buildRequest: ({ objective, spec }) => ({ system: "sys", user: `obj${objective}:${spec.hint}` }),
    check: () => null,
    isDuplicate: (p, kept) => kept.some((k) => k.problem === p.problem),
    deadlineAt: Date.now() + 285_000,
    recordUsage: () => {},
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("runCascade", () => {
  it("fills every objective on the first rung and orders by objective", async () => {
    const { writer } = scriptedWriter((req) => ({ problem: `P-${req.user}` }));
    const r = await runCascade(baseInput({ writers: { openweight: writer } }));
    expect(r.ok).toBe(true);
    expect(r.problems.map((p) => p.problem)).toEqual(["P-obj0:h0", "P-obj1:h1", "P-obj2:h2"]);
    expect(r.meta.items.every((i) => i.rung === 0)).toBe(true);
  });

  it("escalates a failed call to the next rung and records why", async () => {
    const cheap = scriptedWriter((req) =>
      req.user.startsWith("obj1") ? { error: new RungError("malformed-tool-call", "bad args") } : { problem: `C-${req.user}` }
    );
    const top = scriptedWriter((req) => ({ problem: `T-${req.user}` }));
    const r = await runCascade(baseInput({ writers: { openweight: cheap.writer, anthropic: top.writer } }));
    expect(r.ok).toBe(true);
    expect(r.problems[1].problem).toBe("T-obj1:h1");
    expect(r.meta.items[1]).toMatchObject({ rung: 1, model: "claude-opus-5-5" });
    expect(r.meta.items[1].history[0]).toMatchObject({ rung: 0, finish: "malformed-tool-call" });
  });

  it("skips verification for a candidate that already duplicates a kept problem", async () => {
    // obj1's first candidate repeats obj0's problem and arrives after obj0 is kept.
    let obj1Calls = 0;
    const writer: Writer = async (req) => {
      if (req.user.startsWith("obj1") && obj1Calls++ === 0) {
        await new Promise((r) => setTimeout(r, 15));
        return { problem: "P-obj0:h0", answer: "1", solution: "s" };
      }
      return { problem: `P-${req.user}`, answer: "1", solution: "s" };
    };
    const verified: string[] = [];
    const r = await runCascade(
      baseInput({
        writers: { openweight: writer },
        ladder: parseLadder("mid", "openweight:deepseek-flash"),
        count: 2,
        verified: true,
        verify: async (p) => (verified.push(p.problem), { observations: [{ kind: "agree" }], providerDown: false }),
      })
    );
    expect(r.ok).toBe(true);
    expect(r.meta.rejections.duplicate).toBe(1);
    expect(verified.filter((p) => p === "P-obj0:h0")).toHaveLength(1);
  });

  it("an async screen can mark a candidate a duplicate before it is verified", async () => {
    const { writer } = scriptedWriter((req) => ({ problem: `P-${req.user}` }));
    const verified: string[] = [];
    let screened = 0;
    const r = await runCascade(
      baseInput({
        writers: { openweight: writer },
        ladder: parseLadder("mid", "openweight:deepseek-flash"),
        verified: true,
        verify: async (p) => (verified.push(p.problem), { observations: [{ kind: "agree" }], providerDown: false }),
        // The first candidate for objective 2 is "the same practice" as something kept.
        screen: async (p) => p.problem.startsWith("P-obj2") && screened++ === 0,
      })
    );
    expect(r.ok).toBe(true);
    expect(r.meta.rejections.duplicate).toBe(1);
    expect(verified.filter((p) => p.startsWith("P-obj2"))).toHaveLength(1);
  });

  it("escalates a guard rejection, not only a provider failure", async () => {
    const cheap = scriptedWriter((req) => ({ problem: `C-${req.user}` }));
    const top = scriptedWriter((req) => ({ problem: `T-${req.user}` }));
    const r = await runCascade(
      baseInput({
        writers: { openweight: cheap.writer, anthropic: top.writer },
        check: (p) => (p.problem === "C-obj2:h2" ? "guard-problem" : null),
      })
    );
    expect(r.problems[2].problem).toBe("T-obj2:h2");
    expect(r.meta.rejections["guard-problem"]).toBe(1);
  });

  it("aborts a hung call at the rung deadline and escalates it", async () => {
    const cheap = scriptedWriter((req) => (req.user.startsWith("obj0") ? "hang" : { problem: `C-${req.user}` }));
    const top = scriptedWriter((req) => ({ problem: `T-${req.user}` }));
    const r = await runCascade(baseInput({ writers: { openweight: cheap.writer, anthropic: top.writer } }));
    expect(r.ok).toBe(true);
    expect(r.meta.items[0].history[0]).toMatchObject({ finish: "timeout" });
    expect(cheap.calls[0].signal.aborted).toBe(true);
  });

  it("replaces a duplicate found at keep time with a new spec instead of escalating", async () => {
    // Every candidate for objectives 0 and 1 writes the same statement on its first
    // spec; the dedup check at keep time must catch the second one.
    const cheap = scriptedWriter((req) =>
      req.user === "obj1:h1" ? { problem: "SAME" } : req.user === "obj0:h0" ? { problem: "SAME" } : { problem: `C-${req.user}` }
    );
    const top = scriptedWriter((req) => ({ problem: `T-${req.user}` }));
    const r = await runCascade(baseInput({ writers: { openweight: cheap.writer, anthropic: top.writer } }));
    expect(r.ok).toBe(true);
    expect(new Set(r.problems.map((p) => p.problem)).size).toBe(3);
    expect(r.meta.rejections.duplicate).toBe(1);
    expect(top.calls).toHaveLength(0); // a diversity problem never buys a stronger model
  });

  it("never keeps a late result from an aborted sibling", async () => {
    let releaseSlow: (() => void) | undefined;
    const slowDone = new Promise<void>((res) => (releaseSlow = res));
    const writer: Writer = (req) => {
      // Objective 0's backup answers immediately; its primary answers after abort.
      if (req.user === "obj0:h0") {
        return new Promise((resolve) => {
          req.signal.addEventListener("abort", () => {
            releaseSlow?.();
            resolve({ problem: "LATE", answer: "1", solution: "s" });
          });
        });
      }
      return Promise.resolve({ problem: `P-${req.user}`, answer: "1", solution: "s" });
    };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const r = await runCascade(baseInput({ writers: { openweight: writer }, backups: 1 }));
    await slowDone;
    process.off("unhandledRejection", unhandled);
    expect(r.ok).toBe(true);
    expect(r.problems.map((p) => p.problem)).not.toContain("LATE");
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("fails the set by name when the top rung's provider keeps failing", async () => {
    const down = () => ({ error: new RungError("api-error", "HTTP 503", true) });
    const cheap = scriptedWriter(down);
    const top = scriptedWriter(down);
    const r = await runCascade(
      baseInput({ writers: { openweight: cheap.writer, anthropic: top.writer }, breakerThreshold: 2 })
    );
    expect(r.ok).toBe(false);
    expect(r.failure).toMatchObject({ dropReason: "provider-unavailable" });
    expect(r.failure?.reason).toMatch(/anthropic/);
  });

  it("skips a tripped cheap provider without calling it again", async () => {
    const cheap = scriptedWriter(() => ({ error: new RungError("rate-limited", "429", true) }));
    const top = scriptedWriter((req) => ({ problem: `T-${req.user}` }));
    const r = await runCascade(
      baseInput({ writers: { openweight: cheap.writer, anthropic: top.writer }, count: 3, breakerThreshold: 2, specs: Array.from({ length: 8 }, (_, i) => ({ hint: `h${i}` })) })
    );
    expect(r.ok).toBe(true);
    expect(r.meta.finishes["rate-limited"]).toBe(3); // the first wave, before the breaker could trip
  });

  it("fails loudly when the solver's provider is down", async () => {
    const { writer } = scriptedWriter((req) => ({ problem: `P-${req.user}` }));
    const r = await runCascade(
      baseInput({
        writers: { openweight: writer },
        verified: true,
        verify: async () => ({ observations: [], providerDown: true }),
      })
    );
    expect(r.ok).toBe(false);
    expect(r.failure?.dropReason).toBe("provider-unavailable");
  });

  it("replaces a candidate the solver contradicts and marks kept items verified", async () => {
    const cheap = scriptedWriter((req) => ({ problem: `C-${req.user}` }));
    const top = scriptedWriter((req) => ({ problem: `T-${req.user}` }));
    const r = await runCascade(
      baseInput({
        writers: { openweight: cheap.writer, anthropic: top.writer },
        verified: true,
        verify: async (p) => ({
          observations: [p.problem === "C-obj0:h0" ? { kind: "disagree", answer: "9" } : { kind: "agree" }],
          providerDown: false,
        }),
      })
    );
    expect(r.ok).toBe(true);
    expect(r.problems[0].problem).toBe("T-obj0:h0");
    expect(r.verdicts).toEqual(["verified", "verified", "verified"]);
    expect(r.meta.rejections["solver-disagree"]).toBe(1);
  });

  it("stops launching once the spend ceiling is reached", async () => {
    const { writer, calls } = scriptedWriter(() => ({ error: new RungError("malformed-tool-call", "x") }));
    const r = await runCascade(
      baseInput({ writers: { openweight: writer, anthropic: writer }, budget: { spentUsd: () => 1, maxUsd: 1 } })
    );
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("holds calls to a provider's permit count", async () => {
    let active = 0;
    let peak = 0;
    const writer: Writer = async (req) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { problem: `P-${req.user}`, answer: "1", solution: "s" };
    };
    const r = await runCascade(baseInput({ writers: { openweight: writer }, semaphores: { openweight: new Semaphore(2) } }));
    expect(r.ok).toBe(true);
    expect(peak).toBe(2);
  });

  it("records usage against the provider and model that made the call", async () => {
    const recordUsage = vi.fn();
    const { writer } = scriptedWriter((req) => ({ problem: `P-${req.user}` }));
    await runCascade(baseInput({ writers: { openweight: writer }, recordUsage }));
    expect(recordUsage).toHaveBeenCalledWith("openweight", "deepseek-flash", expect.anything());
  });
});

describe("top-rung retry", () => {
  it("retries the top rung once when the model answers without calling the tool", async () => {
    let calls = 0;
    const top: Writer = async (req) => {
      calls++;
      if (calls === 1) throw new RungError("missing-tool-call", "prose reply");
      return { problem: `T-${req.user}`, answer: "1", solution: "s" };
    };
    const ladder = fast(parseLadder("mid", "anthropic:claude-opus-5-5"));
    const r = await runCascade(baseInput({ ladder, writers: { anthropic: top }, count: 1, specs: [{ hint: "h0" }, { hint: "h1" }] }));
    expect(r.ok).toBe(true);
    expect(calls).toBe(2);
    expect(r.meta.candidatesLaunched).toBe(1);
  });
});
