// GenerationAttempt rows: one per generation attempt, used to count failures (the
// denominator the cascade's rollout check needs) and to enforce the per-user daily
// generation cap. Writes are telemetry — a failed write is logged and never blocks
// generation — except the cap check, which fails OPEN for the same reason: a database
// hiccup reading a counter shouldn't stop a tutor mid-session.
import { prisma } from "@/lib/prisma";
import { envOr } from "@/lib/generation/config";

export type AttemptKind = "problems" | "lesson";

export function dailyGenerationCap(): number {
  const n = Number(envOr("GENERATION_DAILY_CAP", "60"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60;
}

// Start of the current UTC day. The cap is a spend guard, not a user-facing calendar
// feature, so a UTC boundary is fine.
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export const DAILY_CAP_MESSAGE = "Daily generation limit reached — try again tomorrow.";

export async function overDailyCap(userId: string, now: Date): Promise<boolean> {
  try {
    const used = await prisma.generationAttempt.count({ where: { userId, startedAt: { gte: utcDayStart(now) } } });
    return used >= dailyGenerationCap();
  } catch (e) {
    console.error("[generation-attempts] cap check failed; allowing the request", e);
    return false;
  }
}

export async function recordAttemptStart(args: {
  userId: string;
  sessionId: string;
  kind: AttemptKind;
  startedAt: Date;
}): Promise<string | null> {
  try {
    const row = await prisma.generationAttempt.create({
      data: { userId: args.userId, sessionId: args.sessionId, kind: args.kind, startedAt: args.startedAt },
      select: { id: true },
    });
    return row.id;
  } catch (e) {
    console.error("[generation-attempts] failed to record attempt start", e);
    return null;
  }
}

export async function recordAttemptEnd(
  id: string | null,
  outcome: {
    ok: boolean;
    startedAt: Date;
    pipeline?: "legacy" | "cascade";
    tier?: string;
    kept?: number;
    asked?: number;
  }
): Promise<void> {
  if (!id) return;
  const finishedAt = new Date();
  try {
    await prisma.generationAttempt.update({
      where: { id },
      data: {
        status: outcome.ok ? "ok" : "failed",
        finishedAt,
        wallTimeMs: finishedAt.getTime() - outcome.startedAt.getTime(),
        pipeline: outcome.pipeline ?? null,
        tier: outcome.tier ?? null,
        kept: outcome.kept ?? null,
        asked: outcome.asked ?? null,
      },
    });
  } catch (e) {
    console.error("[generation-attempts] failed to record attempt outcome", e);
  }
}
