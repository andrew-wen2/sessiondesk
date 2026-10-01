// Pure logic for scripts/eval-repetition.ts: given problems labeled by set and a
// grouping of them by underlying problem type (from one model call), count repetition
// within a set and across sets. No model calls here.

export type Item = { set: number; index: number }; // index is global across all sets
export type Group = { type: string; members: number[] }; // members are global indices

export type RepetitionStats = {
  sets: number;
  problems: number;
  types: number; // distinct types across everything
  withinSetRepeats: number; // problems beyond the first of their type inside the same set
  crossSetRepeatedTypes: number; // types appearing in more than one set
  crossSetPairs: number; // (set pair, type) combinations where both sets have the type
};

// Every item belongs to exactly one group; items the model left out become their own.
export function normalizeGroups(groups: Group[], total: number): Group[] {
  const seen = new Set<number>();
  const out: Group[] = [];
  for (const g of groups) {
    const members = [...new Set(g.members)].filter((m) => Number.isInteger(m) && m >= 0 && m < total && !seen.has(m));
    members.forEach((m) => seen.add(m));
    if (members.length) out.push({ type: g.type, members });
  }
  for (let i = 0; i < total; i++) if (!seen.has(i)) out.push({ type: `(ungrouped #${i})`, members: [i] });
  return out;
}

export function repetitionStats(items: Item[], groups: Group[]): RepetitionStats {
  const setOf = new Map(items.map((it) => [it.index, it.set]));
  const sets = new Set(items.map((it) => it.set)).size;
  let withinSetRepeats = 0;
  let crossSetRepeatedTypes = 0;
  let crossSetPairs = 0;
  for (const g of normalizeGroups(groups, items.length)) {
    const perSet = new Map<number, number>();
    for (const m of g.members) {
      const s = setOf.get(m)!;
      perSet.set(s, (perSet.get(s) ?? 0) + 1);
    }
    for (const n of perSet.values()) withinSetRepeats += n - 1;
    const k = perSet.size;
    if (k > 1) {
      crossSetRepeatedTypes++;
      crossSetPairs += (k * (k - 1)) / 2;
    }
  }
  return { sets, problems: items.length, types: normalizeGroups(groups, items.length).length, withinSetRepeats, crossSetRepeatedTypes, crossSetPairs };
}

// --- Diversity scores ---------------------------------------------------------
// Vendi score (Friedman & Dieng 2022): exp of the Shannon entropy of the eigenvalues of
// K/n, for a similarity matrix K with ones on the diagonal. It reads as "the effective
// number of distinct items": n for n unrelated items, 1 for n copies. Reported next to
// the type counts so a change is judged on one continuous number as well.
export function vendiScore(K: number[][]): number {
  const n = K.length;
  if (n === 0) return 0;
  const eig = symmetricEigenvalues(K.map((row) => row.map((x) => x / n)));
  let h = 0;
  for (const l of eig) if (l > 1e-12) h -= l * Math.log(l);
  return Math.exp(h);
}

// The type-level analogue: exp(entropy) of the type distribution, i.e. the Vendi score
// of the kernel "1 when two problems share a type". 10 problems over 10 types → 10;
// over 5 types, two each → 5.
export function effectiveTypes(groupSizes: number[]): number {
  const n = groupSizes.reduce((a, b) => a + b, 0);
  if (n === 0) return 0;
  let h = 0;
  for (const c of groupSizes) if (c > 0) h -= (c / n) * Math.log(c / n);
  return Math.exp(h);
}

// Per-set diversity averaged over sets, plus the pooled type diversity across sets
// (which falls when sets repeat each other's types).
export function diversityStats(
  items: Item[],
  groups: Group[],
  statements: string[], // by global index
  similarity: (a: string, b: string) => number
): { statementVendiPerSet: number; effectiveTypesPerSet: number; effectiveTypesPooled: number } {
  const bySet = new Map<number, number[]>();
  for (const it of items) bySet.set(it.set, [...(bySet.get(it.set) ?? []), it.index]);
  const typeOf = new Map<number, number>();
  normalizeGroups(groups, items.length).forEach((g, gi) => g.members.forEach((m) => typeOf.set(m, gi)));
  let vendi = 0;
  let types = 0;
  for (const members of bySet.values()) {
    vendi += vendiScore(members.map((a) => members.map((b) => (a === b ? 1 : similarity(statements[a], statements[b])))));
    const counts = new Map<number, number>();
    for (const m of members) counts.set(typeOf.get(m)!, (counts.get(typeOf.get(m)!) ?? 0) + 1);
    types += effectiveTypes([...counts.values()]);
  }
  const pooled = new Map<number, number>();
  for (const it of items) pooled.set(typeOf.get(it.index)!, (pooled.get(typeOf.get(it.index)!) ?? 0) + 1);
  const k = Math.max(1, bySet.size);
  return { statementVendiPerSet: vendi / k, effectiveTypesPerSet: types / k, effectiveTypesPooled: effectiveTypes([...pooled.values()]) };
}

// Cyclic Jacobi rotation: exact enough for the ≤100×100 symmetric matrices here, and
// no dependency.
export function symmetricEigenvalues(input: number[][]): number[] {
  const n = input.length;
  const a = input.map((r) => [...r]);
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
      }
    }
  }
  return a.map((r, i) => r[i]);
}
