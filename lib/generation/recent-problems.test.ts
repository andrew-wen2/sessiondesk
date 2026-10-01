import { describe, expect, it } from "vitest";
import { MAX_RECENT_PROBLEMS, recentGenerationMemory, recentProblemStatements } from "./recent-problems";

describe("recentProblemStatements", () => {
  it("collects statements from the most recent sessions, newest first", () => {
    const rows = [{ problems: [{ problem: " A " }, { problem: "B" }] }, { problems: [{ problem: "C" }] }];
    expect(recentProblemStatements(rows)).toEqual(["A", "B", "C"]);
  });
  it("skips malformed values and stops at the caps", () => {
    const rows = [{ problems: null }, { problems: "x" }, { problems: [null, 3, { problem: "" }, { problem: 4 }, { problem: "ok" }] }, { problems: [{ problem: "4th session" }] }];
    expect(recentProblemStatements(rows)).toEqual(["ok"]);
    const many = [{ problems: Array.from({ length: 50 }, (_, i) => ({ problem: `p${i}` })) }];
    expect(recentProblemStatements(many)).toHaveLength(MAX_RECENT_PROBLEMS);
  });
});

describe("recentGenerationMemory", () => {
  it("pairs each recent statement with its method, and collects type ids, ignoring junk", () => {
    const rows = [
      {
        problems: [{ problem: "P1" }, { problem: "P2" }, { problem: "P3" }],
        genMeta: { v: 1, problems: { cascade: { typeIds: ["algebra:1", "algebra:2"], items: [{ method: "factor, then Vieta" }, { method: "" }, {}] } } },
      },
      { problems: [{ problem: "Q" }], genMeta: null },
      { problems: [{ problem: "R" }], genMeta: { v: 1, problems: { cascade: { typeIds: "nope", items: [{ method: "m" }, { method: "extra" }] } } } },
    ];
    expect(recentGenerationMemory(rows)).toEqual({ typeIds: ["algebra:1", "algebra:2"], methods: [{ problem: "P1", method: "factor, then Vieta" }], seedIds: [] });
  });

  it("collects the real problems recent sets were seeded from, even when items don't line up", () => {
    const rows = [
      { problems: [{ problem: "P1" }], genMeta: { v: 1, problems: { cascade: { items: [{ seedId: "r1" }, { seedId: 7 }, { seedId: "r2" }] } } } },
      { problems: [], genMeta: { v: 1, problems: { cascade: { items: [{ seedId: "r1" }] } } } },
    ];
    expect(recentGenerationMemory(rows).seedIds).toEqual(["r1", "r2"]);
  });
});
