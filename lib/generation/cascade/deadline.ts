// Time budget for one generation request. Pure: every function takes "now" or the
// remaining time as an argument, so the rules are unit-tested without a clock.
//
// The review found the first draft's hard tier infeasible: a top-rung writer plus
// three sequential solver votes needed 270s of a 285s budget, so no cheaper rung could
// ever start and replacements were dead code. Two changes fix it: top-rung votes run
// in parallel (one solver timeout, not three), and every rung reserves the time needed
// to still reach the top rung after it.
import { SOLVER_CLIENT_TIMEOUT_MS } from "@/lib/generation/config";
import type { RungConfig } from "@/lib/generation/cascade/ladder";

// Must match app/api/generate/route.ts's maxDuration (seconds → ms).
export const ROUTE_BUDGET_MS = 300_000;
// Held back for planning, retrieval and persisting the result.
export const ROUTE_RESERVE_MS = 15_000;
export const USABLE_BUDGET_MS = ROUTE_BUDGET_MS - ROUTE_RESERVE_MS;

// Verification a kept candidate needs after writing. Only the adapt path is solved
// (see problems.ts's useAdapt gate); at the top rung its votes run in parallel.
export function verifyMs(verified: boolean): number {
  return verified ? SOLVER_CLIENT_TIMEOUT_MS : 0;
}

// Worst-case time for one rung: the writer runs to its timeout, then verification.
export function rungCostMs(r: RungConfig, verified: boolean): number {
  return r.timeoutMs + verifyMs(verified);
}

// May a slot start rung `index` with `remainingMs` left? A lower rung must leave room
// for the top rung to still run after it fails; the top rung needs only its own cost.
export function canStartRung(remainingMs: number, ladder: RungConfig[], index: number, verified: boolean): boolean {
  const top = ladder.length - 1;
  const own = rungCostMs(ladder[index], verified);
  const needed = index === top ? own : own + rungCostMs(ladder[top], verified);
  return remainingMs >= needed;
}

// The rung a slot should run next, given the rung it would like: the wanted rung if it
// fits, otherwise the top rung if that still fits (skip the cheap rungs), else null.
export function admitRung(remainingMs: number, ladder: RungConfig[], wanted: number, verified: boolean): number | null {
  if (wanted < ladder.length && canStartRung(remainingMs, ladder, wanted, verified)) return wanted;
  const top = ladder.length - 1;
  if (wanted <= top && canStartRung(remainingMs, ladder, top, verified)) return top;
  return null;
}

export type Feasibility = {
  topRungFits: boolean; // the backstop alone fits in the usable budget
  cheapRungsUsable: boolean; // rung 0 can start at time zero and still leave the top reachable
  message: string;
};

// Used by gen:check and at startup: a ladder whose backstop cannot complete inside the
// route budget is a configuration error, not a runtime surprise.
export function ladderFeasibility(ladder: RungConfig[], verified: boolean, tierLabel: string): Feasibility {
  const topRungFits = canStartRung(USABLE_BUDGET_MS, ladder, ladder.length - 1, verified);
  const cheapRungsUsable = ladder.length > 1 && canStartRung(USABLE_BUDGET_MS, ladder, 0, verified);
  const top = ladder[ladder.length - 1];
  const message = !topRungFits
    ? `${tierLabel}: the top rung (${top.model}) needs ${rungCostMs(top, verified) / 1000}s, more than the ${USABLE_BUDGET_MS / 1000}s budget.`
    : ladder.length > 1 && !cheapRungsUsable
      ? `${tierLabel}: cheaper rungs can never start — rung 0 plus the top rung exceeds ${USABLE_BUDGET_MS / 1000}s.`
      : `${tierLabel}: ok.`;
  return { topRungFits, cheapRungsUsable, message };
}

// Replacement candidates exist only while a fresh top-rung attempt can still finish.
export function canLaunchReplacement(remainingMs: number, ladder: RungConfig[], verified: boolean): boolean {
  return canStartRung(remainingMs, ladder, ladder.length - 1, verified);
}
