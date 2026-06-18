import { NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/gcal";

// GET /api/auth/google/connect — kick off OAuth. Redirects to Google consent.
export async function GET() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return NextResponse.json(
      { error: "Google OAuth is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET." },
      { status: 500 }
    );
  }
  return NextResponse.redirect(getAuthUrl());
}
