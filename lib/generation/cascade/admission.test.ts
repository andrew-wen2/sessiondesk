import { describe, it, expect } from "vitest";
import { evaluateAdmission, LATEX_PROBES } from "./admission";

const all = LATEX_PROBES.join(" ");
const without = (cmd: string) => LATEX_PROBES.filter((c) => c !== cmd).join(" ");

describe("evaluateAdmission", () => {
  it("passes when every command survives", () => {
    expect(evaluateAdmission({ problem: `$${all}$`, answer: "1", solution: "ok" }).pass).toBe(true);
  });

  it("passes when the model merely leaves one command out, and reports it", () => {
    const r = evaluateAdmission({ problem: `In a right triangle, $${without("\\right")}$`, answer: "1", solution: "ok" });
    expect(r).toEqual({ pass: true, missing: ["\\right"], corrupted: [] });
  });

  it("flags a backslash eaten by a JSON escape (\\b → backspace)", () => {
    const r = evaluateAdmission({ problem: `$${all.replace("\\binom", "\u0008inom")}$`, answer: "1", solution: "ok" });
    expect(r.pass).toBe(false);
    expect(r.corrupted).toContain("\\binom");
  });

  it("flags \\right turned into a carriage return", () => {
    const r = evaluateAdmission({ problem: `$${all.replace("\\right", "\right")}$`, answer: "1", solution: "ok" });
    expect(r.corrupted).toContain("\\right");
    expect(r.pass).toBe(false);
  });

  it("fails a trial that barely used the probes", () => {
    const r = evaluateAdmission({ problem: "$\\frac{1}{2}$", answer: "1", solution: "ok" });
    expect(r.pass).toBe(false);
    expect(r.corrupted).toEqual([]);
  });
});
