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

// Gemini rates are intentionally absent until Stage 3 confirms a real model id and
// its published price — see the plan's "Verification caveat on the model." Looking
// one up here returns null cost rather than a guessed number.
const RATES: Record<string, Record<string, Rates>> = {
  anthropic: ANTHROPIC_RATES,
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

export function costForRun(usage: Partial<Record<string, StageUsage>>): number {
  let total = 0;
  for (const u of Object.values(usage)) {
    if (!u) continue;
    const c = costForStage(u);
    if (c != null) total += c;
  }
  return total;
}
