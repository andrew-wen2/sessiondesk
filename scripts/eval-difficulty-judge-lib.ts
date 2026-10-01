// Rank statistics for the difficulty evals. Pure.

// Spearman rank correlation, average ranks for ties. NaN when either side is constant.
export function spearman(xs: number[], ys: number[]): number {
  const rank = (v: number[]) => {
    const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(v.length);
    for (let k = 0; k < order.length; ) {
      let j = k;
      while (j + 1 < order.length && order[j + 1][0] === order[k][0]) j++;
      for (let m = k; m <= j; m++) r[order[m][1]] = (k + j) / 2;
      k = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

// P(a random `high` item scores above a random `low` item), ties counting half.
export function aucOf(low: number[], high: number[]): number {
  if (low.length === 0 || high.length === 0) return NaN;
  let wins = 0;
  for (const l of low) for (const h of high) wins += h > l ? 1 : h === l ? 0.5 : 0;
  return wins / (low.length * high.length);
}
