import { NextResponse } from "next/server";
import { getLoginAuthUrl } from "@/lib/gcal";
import { isGcalAppConfigured } from "@/lib/gcal-account";

// GET /api/auth/google/signin — start "Sign in with Google". Redirects to Google
// consent with identity scopes; the shared callback (/api/auth/google, state=signin)
// finds-or-creates the user and sets the session cookie. No session required (this
// is how you get one), so middleware leaves /api/auth/* public.
export async function GET(request: Request) {
  if (!isGcalAppConfigured()) {
    // Google isn't configured — send back to login with a friendly flag rather
    // than a raw error (the button is normally hidden when unconfigured).
    return NextResponse.redirect(new URL("/login?error=google", request.url));
  }
  return NextResponse.redirect(getLoginAuthUrl());
}
