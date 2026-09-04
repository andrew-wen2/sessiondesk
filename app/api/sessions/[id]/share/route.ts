import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import { mintToken, resolveAnswerFormat } from "@/lib/worksheet";
import type { Problem } from "@/lib/types";

// POST   /api/sessions/[id]/share — mint a practice link for the student
// DELETE /api/sessions/[id]/share — revoke it
//
// Authenticated and ownership-checked, unlike /api/w/* which the student uses.

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const session = await prisma.session.findFirst({
      where: { id, userId },
      select: {
        id: true,
        problems: true,
        sentSet: true,
        genMeta: true,
        student: { select: { profile: true } },
        submission: { select: { id: true } },
      },
    });
    if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });

    const problems = (session.problems ?? []) as unknown as Problem[];
    if (!Array.isArray(problems) || problems.length === 0) {
      return NextResponse.json(
        { error: "Generate problems before sending a link." },
        { status: 400 }
      );
    }

    // answersMatch refuses to grade "open" at all, so a set in that format would mark
    // every answer wrong. Refuse to send rather than ship a worksheet that cannot work.
    const { format } = resolveAnswerFormat(session.genMeta, session.student.profile);
    if (format === "open") {
      return NextResponse.json(
        { error: "These problems have no single answer to check — send the student copy instead." },
        { status: 400 }
      );
    }

    // Freeze the set ONLY on a first send. A re-send after a revoke must not re-freeze
    // when work already exists, or every stored result's index points at a different
    // problem than the one it was answered against.
    const freeze = session.submission ? {} : { sentSet: problems as unknown as Prisma.InputJsonValue };

    // One write, so "sentSet is null but shareToken is set" is unrepresentable.
    const token = mintToken();
    await prisma.session.update({
      where: { id: session.id },
      data: { shareToken: token, sentAt: new Date(), ...freeze },
    });

    return NextResponse.json({ token });
  } catch (e) {
    console.error("[/api/sessions/[id]/share POST]", e);
    return NextResponse.json({ error: "Couldn't create the link — try again." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const session = await prisma.session.findFirst({ where: { id, userId }, select: { id: true } });
    if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });

    // sentAt survives on purpose: "sent five days ago, revoked, nothing back" is a
    // different and more useful thing to know than "never sent", and clearing it would
    // erase the completion signal this feature exists to produce. sentSet survives too,
    // so any work already done still renders against the problems it was answered on.
    await prisma.session.update({ where: { id: session.id }, data: { shareToken: null } });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[/api/sessions/[id]/share DELETE]", e);
    return NextResponse.json({ error: "Couldn't turn off the link — try again." }, { status: 500 });
  }
}
