import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { generateLesson } from "@/lib/generation/lesson";
import { planFor } from "@/lib/generation/plan";
import { acquireSlot, releaseSlot, TOO_MANY_MESSAGE } from "@/lib/generation/rate-limit";
import { finishAttempt, startAttempt, type GenerationRunMeta } from "@/lib/generation/gen-meta";
import { writeGenMeta } from "@/lib/generation/gen-meta-db";
import { DAILY_CAP_MESSAGE, overDailyCap, recordAttemptEnd, recordAttemptStart } from "@/lib/generation/attempts";
import { providerForStage, geminiModelFor, anthropicModelFor } from "@/lib/generation/config";

// POST /api/generate-lesson — server-only. Uses ANTHROPIC_API_KEY from env.
// Body: { studentId, sessionId, topic? }. Generates a structured lesson and
// stores it on Session.lesson. Same auth/scoping model as /api/generate.
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: "Generation is not configured — set ANTHROPIC_API_KEY." }, { status: 500 });
    }

    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const body = await request.json();
    const studentId = typeof body.studentId === "string" ? body.studentId : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const topic = typeof body.topic === "string" ? body.topic : "";

    if (!studentId || !sessionId) {
      return NextResponse.json({ error: "Missing student or session." }, { status: 400 });
    }

    if (!acquireSlot(userId)) {
      return NextResponse.json({ error: TOO_MANY_MESSAGE }, { status: 429 });
    }
    try {

    // All reads scoped to the current user (IDOR). genMeta itself is re-read at write
    // time (writeGenMeta), not here: a snapshot taken now would be minutes stale by
    // the time the lesson is written, and would clobber /api/generate's keys.
    const [student, sessionRow, recent] = await Promise.all([
      prisma.student.findFirst({ where: { id: studentId, userId }, select: { profile: true } }),
      prisma.session.findFirst({ where: { id: sessionId, userId }, select: { id: true } }),
      prisma.session.findMany({
        where: { studentId, userId, topic: { not: "" } },
        orderBy: { start: "desc" },
        take: 5,
        select: { topic: true },
      }),
    ]);
    if (!student || !sessionRow) {
      return NextResponse.json({ error: "Student or session not found." }, { status: 404 });
    }

    const startedAt = new Date();
    if (await overDailyCap(userId, startedAt)) {
      return NextResponse.json({ error: DAILY_CAP_MESSAGE }, { status: 429 });
    }
    const attemptId = await recordAttemptStart({ userId, sessionId, kind: "lesson", startedAt });
    await writeGenMeta(sessionId, (existing) => startAttempt(existing, "lesson", startedAt)).catch((e) =>
      console.error("[/api/generate-lesson] failed to persist attempt start", e)
    );

    const accountant = new UsageAccountant();
    const client = new Anthropic({ maxRetries: 4, timeout: maxDuration * 1000 });

    const recentTopics = recent.map((s) => s.topic);
    // Same plan stage the problem pipeline uses, so a lesson is calibrated to the
    // same inferred subject and difficulty rubric as that session's problems.
    const plan = await planFor({
      client,
      profile: student.profile,
      topic,
      recentTopics,
      recordUsage: (u) => accountant.record("plan", u),
    });

    const result = await generateLesson({
      client,
      input: { profile: student.profile, topic, recentTopics, plan },
      recordUsage: (u) => accountant.record("generation", u),
    });

    const lessonMeta: GenerationRunMeta = {
      planSource: plan.source,
      tier: plan.tier,
      answerFormat: plan.answerFormat,
      competition: plan.competition,
      bandLow: plan.bandLow,
      bandHigh: plan.bandHigh,
      usage: {
        plan: accountant.asStageUsage(
          "plan",
          providerForStage("plan"),
          providerForStage("plan") === "gemini" ? geminiModelFor("plan") : anthropicModelFor("plan")
        ) ?? undefined,
        generation:
          accountant.asStageUsage(
            "generation",
            providerForStage("lesson"),
            providerForStage("lesson") === "gemini"
              ? geminiModelFor("lesson")
              : anthropicModelFor("lesson")
          ) ?? undefined,
      },
      drops: result.ok ? [] : [{ reason: "generation-failed", excerpt: result.error }],
      verdicts: [],
      kept: result.ok ? 1 : 0,
      asked: 1,
      escalations: 0,
    };
    await recordAttemptEnd(attemptId, { ok: result.ok, startedAt, tier: plan.tier, kept: result.ok ? 1 : 0, asked: 1 });

    // Merged into the row as it is NOW (writeGenMeta re-reads it), so the
    // {problems: ...} key /api/generate owns survives. genMeta.lesson changes only
    // when a new lesson is actually stored; a failure is recorded as an attempt.
    if (!result.ok) {
      await writeGenMeta(sessionId, (existing) =>
        finishAttempt(existing, "lesson", startedAt, new Date(), lessonMeta, false)
      ).catch((e) => console.error("[/api/generate-lesson] failed to persist genMeta on failure", e));
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
    console.log(accountant.summaryLine({ tier: "lesson", count: 1 }));

    await writeGenMeta(
      sessionId,
      (existing) => finishAttempt(existing, "lesson", startedAt, new Date(), lessonMeta, true),
      { lesson: result.lesson as unknown as Prisma.InputJsonValue }
    );

    return NextResponse.json(result.lesson);
    } finally {
      releaseSlot(userId);
    }
  } catch (e) {
    console.error("[/api/generate-lesson POST]", e);
    return NextResponse.json({ error: "Generation failed — try again." }, { status: 500 });
  }
}
