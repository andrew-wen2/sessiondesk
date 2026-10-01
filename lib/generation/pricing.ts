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
  // UNVERIFIED — from web research on 2026-09-23 (the cascade's top rung). That same
  // research put claude-opus-5 at $5/$25, which contradicts the row below; confirm
  // both against Anthropic's pricing page before trusting a cost comparison.
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
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
  // UNVERIFIED — ai.google.dev/gemini-api/docs/pricing as fetched by web research on
  // 2026-09-23: $0.75 / $3.75, guaranteed only through 2026-12-31 (Google says most 3.x
  // prices roughly double on 2027-01-01). Cache reads are billed at the full input
  // rate here: an upper bound, since no cached-read price was confirmed.
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cacheWrite: 0.75, cacheRead: 0.75 },
};

// Open-weight rungs served through an OpenAI-compatible US host. UNVERIFIED — from
// web research on 2026-09-23 (DeepInfra list prices via OpenRouter's endpoint
// listing); a different host charges differently. cacheWrite has no separate price
// on these hosts, so it is billed as input.
const OPENWEIGHT_RATES: Record<string, Rates> = {
  "deepseek-flash": { input: 0.14, output: 0.42, cacheWrite: 0.14, cacheRead: 0.0042 },
  "deepseek-ai/DeepSeek-V4.1-Flash": { input: 0.14, output: 0.42, cacheWrite: 0.14, cacheRead: 0.0042 },
  "glm-5.3": { input: 0.5625, output: 2.5, cacheWrite: 0.5625, cacheRead: 0.125 },
  "zai-org/GLM-5.3": { input: 0.5625, output: 2.5, cacheWrite: 0.5625, cacheRead: 0.125 },
  "glm-5.3-flash": { input: 0.075, output: 0.25, cacheWrite: 0.075, cacheRead: 0.015 },
  "zai-org/GLM-5.3-Flash": { input: 0.075, output: 0.25, cacheWrite: 0.075, cacheRead: 0.015 },
};

const RATES: Record<string, Record<string, Rates>> = {
  anthropic: ANTHROPIC_RATES,
  gemini: GEMINI_RATES,
  openweight: OPENWEIGHT_RATES,
};

// Exact id, or the id with a trailing dated-snapshot suffix removed
// ("claude-opus-5-20260815" → "claude-opus-5"). This used to be a longest-prefix
// match, which silently priced "claude-opus-5-5" as "claude-opus-5": a new model must
// get its own row, and until it does it reports as unpriced.
function ratesFor(provider: string, model: string): Rates | null {
  const table = RATES[provider];
  if (!table) return null;
  return table[model] ?? table[model.replace(/-\d{8}$/, "")] ?? null;
}

// For gen:check: does this provider/model have a price row?
export function isPriced(provider: string, model: string): boolean {
  return ratesFor(provider, model) !== null;
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
