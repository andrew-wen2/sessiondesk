import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// PATCH /api/payments — mark a session paid/unpaid. Thin wrapper over the
// session update; the ledger is the only caller.
// Body: { sessionId: string; paid: boolean }
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!sessionId || typeof body.paid !== "boolean") {
      return NextResponse.json(
        { error: "Missing sessionId or paid flag." },
        { status: 400 }
      );
    }

    // Select only the fields the ledger needs — skip problems/homework/etc.
    const session = await prisma.session.update({
      where: { id: sessionId },
      data: { paid: body.paid },
      select: { id: true, paid: true },
    });
    return NextResponse.json(session);
  } catch (e) {
    console.error("[/api/payments PATCH]", e);
    return NextResponse.json({ error: "Could not update payment — try again." }, { status: 500 });
  }
}
