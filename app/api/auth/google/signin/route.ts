import { NextResponse } from "next/server";
import { getLoginAuthUrl } from "@/lib/gcal";
import { isGcalAppConfigured } from "@/lib/gcal-account";
import { OAUTH_STATE_COOKIE } from "@/lib/auth";

// GET /api/auth/google/signin — start "Sign in with Google". Redirects to Google
// consent with identity scopes; the shared callback (/api/auth/google, state
// prefixed "signin:") finds-or-creates the user and sets the session cookie. No
// session required (this is how you get one), so middleware leaves /api/auth/* public.
export async function GET(request: Request) {
  if (!isGcalAppConfigured()) {
    // Google isn't configured — send back to login with a friendly flag rather
    // than a raw error (the button is normally hidden when unconfigured).
    return NextResponse.redirect(new URL("/login?error=google", request.url));
  }

  // CSRF defense: a random nonce travels in the OAuth `state` and in a short-lived
  // httpOnly cookie. The callback only proceeds if the two match, so a forged
  // callback (login CSRF) can't complete the sign-in.
  const nonce = crypto.randomUUID();
  const res = NextResponse.redirect(getLoginAuthUrl(`signin:${nonce}`));
  res.cookies.set(OAUTH_STATE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax", // sent on the top-level GET navigation back from Google
    path: "/",
    maxAge: 600, // 10 minutes to complete the round-trip
  });
  return res;
}
