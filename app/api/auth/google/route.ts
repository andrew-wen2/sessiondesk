import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { exchangeCode } from "@/lib/gcal";
import { getCurrentUserId } from "@/lib/session";

// GET /api/auth/google — OAuth callback. Exchanges the code for tokens and stores
// the refresh token on the signed-in user's row (per-user Calendar link). The
// callback runs in the user's browser, so the session cookie identifies who to
// attach it to.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.redirect(new URL("/login", request.url));

  if (error) {
    return NextResponse.redirect(new URL("/?gcal=denied", request.url));
  }
  if (!code) {
    return NextResponse.json({ error: "Missing authorization code." }, { status: 400 });
  }

  try {
    const tokens = await exchangeCode(code);
    if (!tokens.refresh_token) {
      // Google only returns a refresh token with prompt=consent + offline access
      // (both set on the auth URL). A missing one means we can't mirror later.
      console.error("[/api/auth/google] no refresh_token returned");
      return NextResponse.redirect(new URL("/?gcal=error", request.url));
    }
    await prisma.user.update({
      where: { id: userId },
      data: { googleRefreshToken: tokens.refresh_token },
    });
    return NextResponse.redirect(new URL("/?gcal=connected", request.url));
  } catch (e) {
    console.error("[/api/auth/google] token exchange failed:", e);
    return NextResponse.redirect(new URL("/?gcal=error", request.url));
  }
}
