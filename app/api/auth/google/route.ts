import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { exchangeCode, verifyGoogleLogin } from "@/lib/gcal";
import { getCurrentUserId } from "@/lib/session";
import { SESSION_COOKIE, SESSION_MAX_AGE, signSession } from "@/lib/auth";

// GET /api/auth/google — shared OAuth callback for both Google flows, told apart
// by the `state` param:
//   - state=signin  → "Sign in with Google": find-or-create the user by verified
//                     email, link googleId, set the session cookie. No prior session.
//   - state=connect → link the signed-in user's Calendar (store the refresh token).
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");
  const state = searchParams.get("state");

  if (state === "signin") return handleSignin(request, code, error);

  // --- Calendar-connect flow (requires an existing session) ---
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

// Sign-in-with-Google: verify the identity, find-or-create the user by email
// (linking to an existing email/password account when the email matches), and
// issue the session cookie on the redirect to the app.
async function handleSignin(request: Request, code: string | null, error: string | null) {
  if (error || !code) {
    return NextResponse.redirect(new URL("/login?error=google", request.url));
  }
  try {
    const identity = await verifyGoogleLogin(code);
    if (!identity) {
      return NextResponse.redirect(new URL("/login?error=google", request.url));
    }
    // Same email = same person → log into the existing account and stamp googleId;
    // otherwise create a Google-only account (empty passwordHash until they set one).
    const user = await prisma.user.upsert({
      where: { email: identity.email },
      update: { googleId: identity.googleId },
      create: { email: identity.email, passwordHash: "", googleId: identity.googleId },
    });
    const res = NextResponse.redirect(new URL("/", request.url));
    res.cookies.set(SESSION_COOKIE, await signSession(user.id), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
    return res;
  } catch (e) {
    console.error("[/api/auth/google] sign-in failed:", e);
    return NextResponse.redirect(new URL("/login?error=google", request.url));
  }
}
