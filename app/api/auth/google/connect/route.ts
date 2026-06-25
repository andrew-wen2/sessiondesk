import { NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/gcal";
import { isGcalAppConfigured } from "@/lib/gcal-account";
import { getCurrentUserId } from "@/lib/session";

// GET /api/auth/google/connect — kick off OAuth for the current user. Redirects to
// Google consent; the callback attaches the returned refresh token to this user.
export async function GET(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.redirect(new URL("/login", request.url));

  if (!isGcalAppConfigured()) {
    return NextResponse.json(
      { error: "Google OAuth is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET." },
      { status: 500 }
    );
  }
  return NextResponse.redirect(getAuthUrl());
}
