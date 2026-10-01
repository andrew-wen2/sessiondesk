import { describe, expect, it } from "vitest";
import { calibrationFor, fitLine, judgeScaleTarget } from "./judge-calibration";

describe("fitLine", () => {
  it("recovers a line and refuses points with no spread", () => {
    const fit = fitLine([0.1, 0.2, 0.3], [0.15, 0.2, 0.25])!;
    expect(fit.slope).toBeCloseTo(0.5);
    expect(fit.intercept).toBeCloseTo(0.1);
    expect(fit.n).toBe(3);
    expect(fitLine([0.2, 0.2], [0.1, 0.3])).toBeNull();
    expect(fitLine([0.2], [0.1])).toBeNull();
  });
});

describe("judgeScaleTarget", () => {
  const table = { judges: { "openweight:glm@low": { AMC10: { slope: 0.8, intercept: 0.04, n: 80 } } } };
  it("maps a human target onto the judge's scale", () => {
    expect(judgeScaleTarget("openweight:glm@low", "AMC10", 0.24, table)).toBeCloseTo(0.232);
  });
  it("is null for an uncalibrated judge or contest", () => {
    expect(judgeScaleTarget("openweight:glm@low", "AIME", 0.6, table)).toBeNull();
    expect(calibrationFor("gemini:flash@low", "AMC10", table)).toBeNull();
  });
});
