import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { applyAttempt } from "@/lib/apply-attempt";
import {
  MAX_ATTEMPTS,
  isWellFormedToken,
  linkState,
  resolveAnswerFormat,
  type StoredResult,
} from "@/lib/worksheet";
import type { Problem } from "@/lib/types";

// POST /api/w/[token]/check — the student commits ONE answer.
//
// This is the app's first unauthenticated write endpoint. It lives under `/api/w`, which
// middleware treats as public BY PREFIX, so nothing upstream checks anything: the token
// check below is the entire access control.
//
// Thin by design (the /api/generate precedent): parse, authorize, hand to a pure function,
// persist, respond. vitest here is `environment: "node"` with no DB harness, so anything
// that stays in this file is permanently uncoverable — the state machine lives in
// lib/apply-attempt.ts and is tested there.

const MAX_ANSWER_LEN = 512;
const MAX_CAS_RETRIES = 3;

function fail(reason: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: reason, ...extra }, { status });
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    // Before any query. A nullish value reaching a `where: { shareToken }` matches an
    // arbitrary row rather than nothing.
    if (!isWellFormedToken(token)) return fail("This link isn't valid.", 404, { reason: "unknown" });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail("Couldn't read your answer — reload and try again.", 400);
    }
    const { index, answer } = (body ?? {}) as { index?: unknown; answer?: unknown };

    // Fail closed on every non-integer shape BEFORE indexing anything: "3", 3.0, -0,
    // 1e1, NaN and arrays all reach here from a hand-rolled client.
    if (!Number.isInteger(index) || (index as number) < 0) return fail("Bad request.", 400);
    if (typeof answer !== "string" || answer.length > MAX_ANSWER_LEN) {
      return fail("That answer is too long.", 400);
    }

    const session = await prisma.session.findUnique({
      where: { shareToken: token },
      select: {
        id: true,
        userId: true,
        studentId: true,
        status: true,
        shareToken: true,
        sentAt: true,
        sentSet: true,
        genMeta: true,
        student: { select: { profile: true } },
        submission: { select: { id: true, results: true, version: true } },
      },
    });
    if (!session) return fail("This link isn't valid.", 404, { reason: "unknown" });

    // Discriminated so the client can say "expired on Sep 15" or "turned off" rather than
    // one generic string — a student mid-set at the 14-day boundary should not be told
    // their tutor switched it off.
    const state = linkState(session, new Date());
    if (state !== "live") {
      const message =
        state === "expired"
          ? "This link has expired. Ask your tutor for a new one."
          : "This link was turned off. Ask your tutor for a new one.";
      return fail(message, 404, { reason: state });
    }

    const sentSet = (session.sentSet ?? []) as unknown as Problem[];
    if (!Array.isArray(sentSet) || (index as number) >= sentSet.length) {
      return fail("Bad request.", 400);
    }
    const target = sentSet[index as number];

    const { format, fallback } = resolveAnswerFormat(session.genMeta, session.student.profile);

    // Compare-and-swap loop. `results` is a Json column, so appending is a
    // read-modify-write with no atomicity under Read Committed: without the version
    // guard, N concurrent requests all read the same prior array and exactly one write
    // survives — which spends ONE attempt for fifty parallel guesses and silently loses a
    // commit whenever two tabs are open.
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const current =
        attempt === 0
          ? session.submission
          : await prisma.submission.findUnique({
              where: { sessionId: session.id },
              select: { id: true, results: true, version: true },
            });

      const prior = (current?.results ?? []) as unknown as StoredResult[];
      const outcome = applyAttempt(prior, {
        index: index as number,
        answer,
        stored: { answer: target.answer, solution: target.solution },
        format,
        formatFallback: fallback,
        maxAttempts: MAX_ATTEMPTS,
      });

      // Already settled: reconcile the client to the stored state instead of painting a
      // failure on a problem they may well have got right.
      if (outcome.alreadyResolved) {
        return NextResponse.json(
          {
            alreadyResolved: true,
            verdict: outcome.verdict,
            attempts: outcome.attempts,
            attemptsLeft: 0,
            reveal: outcome.reveal,
          },
          { status: 409 }
        );
      }

      try {
        if (!current) {
          // userId and studentId come from the session row we loaded, NEVER from the
          // request body — an unauthenticated endpoint that trusts a body userId is a
          // cross-tenant write.
          await prisma.submission.create({
            data: {
              userId: session.userId,
              studentId: session.studentId,
              sessionId: session.id,
              results: outcome.results as unknown as Prisma.InputJsonValue,
            },
          });
        } else {
          await prisma.submission.update({
            where: { sessionId: session.id, version: current.version },
            data: {
              results: outcome.results as unknown as Prisma.InputJsonValue,
              version: { increment: 1 },
            },
          });
        }
      } catch (e) {
        // P2025: the version moved under us. P2002: two requests both saw no submission
        // and both tried to create one. Both mean "re-read and reapply", not "fail".
        const code = e instanceof Prisma.PrismaClientKnownRequestError ? e.code : null;
        if ((code === "P2025" || code === "P2002") && attempt < MAX_CAS_RETRIES - 1) continue;
        throw e;
      }

      return NextResponse.json({
        verdict: outcome.verdict,
        attempts: outcome.attempts,
        attemptsLeft: outcome.attemptsLeft,
        // Null until the problem is settled. This is the product: the answer is not on
        // the page until it has been earned or the attempts are spent.
        reveal: outcome.reveal,
      });
    }

    return fail("Couldn't save that — try again.", 409);
  } catch (e) {
    console.error("[/api/w/check]", e);
    return fail("Couldn't check that — try again.", 500);
  }
}
