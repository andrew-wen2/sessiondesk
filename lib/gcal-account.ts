// Per-user Google Calendar credential loading. Bridges the DB (User row) and the
// pure Calendar adapter in lib/gcal.ts — kept separate so gcal.ts stays Prisma-free.
import { prisma } from "@/lib/prisma";
import type { GCalAccount } from "@/lib/gcal";

// App-level OAuth config (the registered Google app). Without it no user can
// connect, so the "Connect Google Calendar" affordance is hidden.
export function isGcalAppConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// The acting user's Calendar account, or null when the app isn't configured or
// the user hasn't linked their calendar yet. Routes pass the result into the
// gcal.ts CRUD helpers; a null result means "skip the mirror" (non-blocking).
export async function getGcalAccount(userId: string): Promise<GCalAccount | null> {
  if (!isGcalAppConfigured()) return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { googleRefreshToken: true, googleCalendarId: true },
  });
  if (!user?.googleRefreshToken) return null;
  return {
    refreshToken: user.googleRefreshToken,
    calendarId: user.googleCalendarId || "primary",
  };
}

// True when the user has linked their Google Calendar — drives the per-user
// "connected" UI state (sync buttons, Meet generation).
export async function isGcalConnected(userId: string): Promise<boolean> {
  return (await getGcalAccount(userId)) !== null;
}
