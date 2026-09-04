import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

// Multi-user gate: every request must carry a valid signed session cookie. Exempt
// the auth pages (login/register) and the auth API routes (login/register/logout
// + the Google OAuth callback at /api/auth/google). Static assets are excluded via
// the matcher below.
//
// `/w` and `/api/w` are the student practice link: a token in the URL is the only
// credential, because the student has no account. Matching here is by PREFIX, so
// EVERY route under `/api/w/*` is unauthenticated by construction, forever — the same
// property `/api/auth` has, and the same discipline it demands: each route re-checks
// the token itself. Adding a route under this prefix and forgetting that check
// publishes it to the internet.
const PUBLIC_PATHS = ["/login", "/register", "/api/auth", "/w", "/api/w"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const userId = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (userId) return NextResponse.next();

  // Unauthed API calls get a clean 401; page requests redirect to /login.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Not signed in — sign in and try again." },
      { status: 401 }
    );
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except Next's build output and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
