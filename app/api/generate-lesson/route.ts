import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { generateLesson } from "@/lib/generation/lesson";
import { planFor } from "@/lib/generation/plan";
import { acquireSlot, releaseSlot, TOO_MANY_MESSAGE } from "@/lib/generation/rate-limit";

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

    // All reads scoped to the current user (IDOR).
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
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
    console.log(accountant.summaryLine({ tier: "lesson", count: 1 }));

    await prisma.session.update({
      where: { id: sessionId },
      data: { lesson: result.lesson as unknown as Prisma.InputJsonValue },
    });

    return NextResponse.json(result.lesson);
    } finally {
      releaseSlot(userId);
    }
  } catch (e) {
    console.error("[/api/generate-lesson POST]", e);
    return NextResponse.json({ error: "Generation failed — try again." }, { status: 500 });
  }
}
