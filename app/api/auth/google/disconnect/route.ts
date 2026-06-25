import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";

// POST /api/auth/google/disconnect — unlink the current user's Google Calendar.
// Existing googleEventIds are left on sessions (harmless; they just stop syncing).
export async function POST() {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  await prisma.user.update({
    where: { id: userId },
    data: { googleRefreshToken: null, googleCalendarId: null },
  });
  return NextResponse.json({ ok: true });
}
