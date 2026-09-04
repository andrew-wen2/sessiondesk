// Dollar cost, computed at READ time from stored tokens + model id — never stored
// as a derived figure next to its inputs (Eng C1/DX F23: UsageAccountant has no price
// table, and a stored dollar amount goes stale silently and retroactively mislabels
// historical rows the moment a vendor repriced). genMeta stores tokens and model ids
// only; this file is the one place a $/token number is asserted, dated, and can be
// updated without touching a single stored row.
//
// PRICES LAST VERIFIED: 2026-09-03, from published Anthropic pricing at that date.
// Verify against current vendor pricing before trusting a cost comparison — pinning
// a model id (per CLAUDE.md) doesn't pin its price.

import type { StageUsage } from "@/lib/generation/gen-meta";

// $ per million tokens.
type Rates = { input: number; output: number; cacheWrite: number; cacheRead: number };

const ANTHROPIC_RATES: Record<string, Rates> = {
  "claude-opus-5": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
};

// Gemini rates are STILL intentionally absent: nobody has confirmed a published
// price for the pinned model id, and a guessed rate is worse than a missing one
// because it produces a confident wrong number instead of an obvious gap.
//
// The consequence is load-bearing, so it is handled rather than hidden: under the
// default provider policy (config.ts — everything but the hard tier runs on Gemini)
// MOST stages price as null, so `costForRun` reports them in `unpriced` and every
// caller must say so. Fill this in with real published numbers before using any
// figure from this file as a go/no-go on spend.
const GEMINI_RATES: Record<string, Rates> = {
  // "gemini-3.8-flash": { input: ?, output: ?, cacheWrite: ?, cacheRead: ? },
};

const RATES: Record<string, Record<string, Rates>> = {
  anthropic: ANTHROPIC_RATES,
  gemini: GEMINI_RATES,
};

// Longest-prefix match so a dated snapshot id ("claude-opus-5-20260815") still
// prices against its family's rate without a table entry per snapshot.
function ratesFor(provider: string, model: string): Rates | null {
  const table = RATES[provider];
  if (!table) return null;
  if (table[model]) return table[model];
  const prefix = Object.keys(table).find((k) => model.startsWith(k));
  return prefix ? table[prefix] : null;
}

export function costForStage(u: StageUsage): number | null {
  const r = ratesFor(u.provider, u.model);
  if (!r) return null;
  return (
    (u.inputTokens * r.input +
      u.outputTokens * r.output +
      u.cacheWriteTokens * r.cacheWrite +
      u.cacheReadTokens * r.cacheRead) /
    1_000_000
  );
}

export type RunCost = {
  /** Dollars for the stages this file can price. NOT the run's cost when `unpriced` is non-empty. */
  total: number;
  /** `provider/model` for every stage with no rate table entry. */
  unpriced: string[];
};

// Returns the unpriced stages alongside the total, and callers MUST surface them.
//
// This used to return a bare number and skip unpriced stages silently
// (`if (c != null) total += c`). Under the default provider policy every stage but
// the hard tier runs on Gemini, and Gemini has no rate table below — so the "total"
// was an Anthropic-only subtotal wearing the name of a full cost, and any decision
// made on it (is a set too expensive to send?) was made on a number that was not
// the cost. A partial total presented as a total is worse than no number at all.
export function costForRun(usage: Partial<Record<string, StageUsage>>): RunCost {
  let total = 0;
  const unpriced: string[] = [];
  for (const u of Object.values(usage)) {
    if (!u) continue;
    const c = costForStage(u);
    if (c == null) unpriced.push(`${u.provider}/${u.model}`);
    else total += c;
  }
  return { total, unpriced: [...new Set(unpriced)] };
}

// One-line summary safe to print anywhere: never claims a total it doesn't have.
export function formatRunCost(cost: RunCost): string {
  const base = `$${cost.total.toFixed(2)}`;
  if (cost.unpriced.length === 0) return base;
  return `${base}+ (UNPRICED: ${cost.unpriced.join(", ")} — figure is a partial subtotal)`;
}
