import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { generateProblems } from "@/lib/generation/problems";
import { acquireSlot, releaseSlot, TOO_MANY_MESSAGE } from "@/lib/generation/rate-limit";

// POST /api/generate — server-only. Uses ANTHROPIC_API_KEY from env; never
// import this route or the SDK in a client component.
//
// Body: { studentId, sessionId, topic? } — nothing subject- or difficulty-related
// comes from the client. The pipeline (lib/generation/problems.ts) derives all of
// it from the student's profile text plus the session topic, scoped to this user.

// Generating hard problems with full solutions is a large, slow streamed call;
// up to two attempts (generate + regenerate the deficit). Needs a Vercel plan
// whose function limit allows this (Hobby caps at 60s).
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Generation is not configured — set ANTHROPIC_API_KEY." },
        { status: 500 }
      );
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

    // Cap concurrent generations per user — bounds Anthropic spend + DB pool
    // pressure if one user fires many at once. Released in the finally below.
    if (!acquireSlot(userId)) {
      return NextResponse.json({ error: TOO_MANY_MESSAGE }, { status: 429 });
    }
    try {
      // Batch all DB reads into parallel queries — student, session, and recent
      // topics. All scoped to the current user so generation can't be driven off
      // another user's student/session.
      const [student, sessionRow, recent] = await Promise.all([
        prisma.student.findFirst({
          where: { id: studentId, userId },
          select: { profile: true },
        }),
        prisma.session.findFirst({
          where: { id: sessionId, userId },
          select: { id: true },
        }),
        // Last 5 non-empty topics for this student, most recent first.
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

      // Per-request, per-stage token accounting → one summary line at the end.
      const accountant = new UsageAccountant();

      // A client-level timeout is REQUIRED for the non-streaming (easy/Haiku) path.
      // The SDK builds a non-streaming request as `timeout: client.timeout ??
      // calculateNonstreamingTimeout(max_tokens)`, and calculateNonstreamingTimeout
      // THROWS ("Streaming is required for operations that may take longer than 10
      // minutes") when max_tokens implies a >10min estimate — which the easy tier's
      // max_tokens (up to 24k) does. A per-request `{ timeout }` can't prevent it (the
      // throw happens while evaluating the default, before options are spread); only a
      // client-level timeout short-circuits the `??`. Pin it to maxDuration (the Vercel
      // function cap, in ms) — past it the request can't finish anyway. Streaming tiers
      // are unaffected by the value.
      const client = new Anthropic({ maxRetries: 4, timeout: maxDuration * 1000 }); // reads ANTHROPIC_API_KEY from env

      const result = await generateProblems({
        client,
        profile: student.profile,
        topic,
        recentTopics: recent.map((s) => s.topic),
        accountant,
      });
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });

      console.log(accountant.summaryLine({ tier: result.plan.tier, count: result.count }));

      await prisma.session.update({
        where: { id: sessionId },
        data: { problems: result.problems as unknown as Prisma.InputJsonValue },
      });

      return NextResponse.json(result.problems);
    } finally {
      releaseSlot(userId);
    }
  } catch (e) {
    console.error("[/api/generate POST]", e);
    return NextResponse.json({ error: "Generation failed — try again." }, { status: 500 });
  }
}
