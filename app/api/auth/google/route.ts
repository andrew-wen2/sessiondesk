import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/gcal";

// GET /api/auth/google — OAuth callback. Exchanges the code for tokens and logs
// the refresh token (Option A): paste it into GOOGLE_REFRESH_TOKEN and redeploy.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.redirect(new URL("/?gcal=denied", request.url));
  }
  if (!code) {
    return NextResponse.json({ error: "Missing authorization code." }, { status: 400 });
  }

  try {
    const tokens = await exchangeCode(code);
    // Single-user: surface the refresh token for the operator to store in env.
    console.log("GOOGLE_REFRESH_TOKEN=", tokens.refresh_token);
    return NextResponse.redirect(new URL("/?gcal=connected", request.url));
  } catch (e) {
    console.error("[/api/auth/google] token exchange failed:", e);
    return NextResponse.redirect(new URL("/?gcal=error", request.url));
  }
}
