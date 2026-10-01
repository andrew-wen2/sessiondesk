// Pure logic for scripts/eval-difficulty.ts: how hard do generated problems play,
// measured against real contest problems of known position?
//
// A deliberately weak solver (a different family from the writer) answers real
// corpus problems at every problem number, several trials each. Its accuracy by
// number is the calibration curve: it should fall as the number rises. The same
// solver then answers the generated problems, and where their accuracy lands on the
// curve is the problem number they play like. No model calls here.

export type Trial = { correct: boolean } | { error: string };

export type DifficultyItem = {
  id: string;
  kind: "real" | "generated";
  number: number | null; // contest position for real items
  trials: Trial[];
};

// Deterministic pick of `perNumber` rows at each position, so a rerun measures the
// same problems. Rows at a position are ordered by a hash of their id.
export function pickPerNumber<T extends { id: string; number: number | null }>(rows: T[], perNumber: number, lo: number, hi: number): T[] {
  const hash = (s: string) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  };
  const out: T[] = [];
  for (let n = lo; n <= hi; n++) {
    out.push(...rows.filter((r) => r.number === n).sort((a, b) => hash(a.id) - hash(b.id)).slice(0, perNumber));
  }
  return out;
}

// Share of answered trials that were correct. Errors are not attempts: a timeout says
// nothing about difficulty.
export function accuracy(items: DifficultyItem[]): { correct: number; answered: number; rate: number | null } {
  let correct = 0;
  let answered = 0;
  for (const it of items)
    for (const t of it.trials) {
      if ("error" in t) continue;
      answered++;
      if (t.correct) correct++;
    }
  return { correct, answered, rate: answered ? correct / answered : null };
}

export type BandPoint = { lo: number; hi: number; mid: number; correct: number; answered: number; rate: number | null };

export function bandCurve(real: DifficultyItem[], width: number, lo: number, hi: number): BandPoint[] {
  const out: BandPoint[] = [];
  for (let a = lo; a <= hi; a += width) {
    const b = Math.min(hi, a + width - 1);
    const acc = accuracy(real.filter((r) => r.number != null && r.number >= a && r.number <= b));
    out.push({ lo: a, hi: b, mid: (a + b) / 2, ...acc });
  }
  return out;
}

// Pool-adjacent-violators: the closest non-increasing sequence (weighted by trials),
// because harder positions can't truly be easier and sampling noise says otherwise.
export function nonIncreasing(values: number[], weights: number[]): number[] {
  const blocks: { v: number; w: number; n: number }[] = [];
  values.forEach((v, i) => {
    blocks.push({ v, w: weights[i], n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].v < blocks[blocks.length - 1].v) {
      const b = blocks.pop()!;
      const a = blocks.pop()!;
      blocks.push({ v: (a.v * a.w + b.v * b.w) / (a.w + b.w || 1), w: a.w + b.w, n: a.n + b.n });
    }
  });
  return blocks.flatMap((b) => Array(b.n).fill(b.v));
}

// Where does `rate` fall on the (smoothed) curve? Returns an estimated problem
// number, or a bound when the rate is off either end of the curve.
export type Placement = { kind: "at"; number: number } | { kind: "easier-than"; number: number } | { kind: "harder-than"; number: number };

export function placeOnCurve(curve: BandPoint[], rate: number): Placement | null {
  const pts = curve.filter((p) => p.rate != null && p.answered > 0);
  if (pts.length === 0) return null;
  const smooth = nonIncreasing(
    pts.map((p) => p.rate!),
    pts.map((p) => p.answered)
  );
  // Strictly beyond an end is a bound; equal to an end plays like that band.
  if (rate > smooth[0]) return { kind: "easier-than", number: pts[0].mid };
  if (rate < smooth[smooth.length - 1]) return { kind: "harder-than", number: pts[pts.length - 1].mid };
  if (rate === smooth[0]) return { kind: "at", number: pts[0].mid };
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [smooth[i], smooth[i + 1]];
    if (rate <= a && rate >= b) {
      const t = a === b ? 0.5 : (a - rate) / (a - b);
      return { kind: "at", number: pts[i].mid + t * (pts[i + 1].mid - pts[i].mid) };
    }
  }
  return null;
}

// Is the curve steep enough to place anything? If the solver aces the whole contest
// (or fails all of it), the measurement can't tell positions apart.
export function curveSpread(curve: BandPoint[]): number | null {
  const rates = curve.map((p) => p.rate).filter((r): r is number => r != null);
  return rates.length < 2 ? null : Math.max(...rates) - Math.min(...rates);
}

// The standing gate for a writer rung. A set spreads its problems across the band, so
// it should play like the band's MIDDLE, not merely somewhere inside it: "inside
// #1-15" would pass a set of nothing but #1s (an end-to-end easy set placed at #3 and
// passed the first version of this gate). Tolerance: a quarter of the band width, at
// least 2 positions. It refuses to pass on a curve too flat to tell positions apart.
export const MIN_CURVE_SPREAD = 0.25;
export function gateVerdict(place: Placement | null, spread: number | null, band: [number, number]): { pass: boolean; reason: string } {
  const [lo, hi] = band;
  if (spread == null || spread < MIN_CURVE_SPREAD) return { pass: false, reason: `the curve is too flat to measure (spread ${spread == null ? "n/a" : Math.round(spread * 100) + "%"}); use a weaker solver` };
  if (!place) return { pass: false, reason: "no generated problems to place" };
  if (place.kind === "easier-than") return { pass: false, reason: `plays easier than the easiest band (target #${lo}-${hi})` };
  if (place.kind === "harder-than") return { pass: false, reason: `plays harder than the hardest band (target #${lo}-${hi})` };
  const n = place.number;
  const mid = (lo + hi) / 2;
  const tol = Math.max(2, (hi - lo) / 4);
  const range = `#${(mid - tol).toFixed(1)}-${(mid + tol).toFixed(1)}, the middle of #${lo}-${hi}`;
  return Math.abs(n - mid) <= tol
    ? { pass: true, reason: `plays like #${n.toFixed(1)}, within ${range}` }
    : { pass: false, reason: `plays like #${n.toFixed(1)}, outside ${range}` };
}
