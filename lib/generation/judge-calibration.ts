// Per-judge calibration of the difficulty judge (cascade/difficulty-judge.ts) onto its
// own scale. Pure apart from reading data/judge-calibration.json.
//
// Why: a judge compresses toward the middle of its anchors. Run over real problems with
// known human ratings (eval:difficulty-judge --range), GLM-5.3 rated AMC 10 #1–5 about
// 0.013 too hard and #21–25 about 0.020 too easy, and AIME #13–15 0.035 too easy. So a
// judge's placement can't be compared with a slot's HUMAN target: real #10–15 problems
// themselves fall short of it. Instead the human target is mapped through a line fitted
// to that judge's placements of real problems (judged ≈ slope × human + intercept), and
// a generated problem is compared with what the same judge gives a real problem there.
//
// The fit holds only for the anchors it was measured with, which is why production and
// the eval share judgeAnchorIds. Built by scripts/fit-judge-calibration.ts.
import table from "@/data/judge-calibration.json";

export type LineFit = { slope: number; intercept: number; n: number };
type Table = { builtAt?: string; judges?: Record<string, Record<string, LineFit & { from?: string }>> };

const TABLE = table as Table;

// Least-squares line through (x, y). Null when x has no spread.
export function fitLine(xs: number[], ys: number[]): LineFit | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  const mx = xs.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const my = ys.slice(0, n).reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, n };
}

// Normalize a judge spec so "openweight:zai-org/GLM-5.3@low" and its env spelling match.
export const judgeKey = (spec: string) => spec.trim();

export function calibrationFor(judgeSpec: string, contest: string, t: Table = TABLE): LineFit | null {
  return t.judges?.[judgeKey(judgeSpec)]?.[contest] ?? null;
}

// A human-scale target mapped onto this judge's scale; null when the judge has no fit
// for the contest (the caller then compares against the human target and says so).
export function judgeScaleTarget(judgeSpec: string, contest: string, humanTarget: number, t: Table = TABLE): number | null {
  const fit = calibrationFor(judgeSpec, contest, t);
  return fit ? fit.slope * humanTarget + fit.intercept : null;
}
