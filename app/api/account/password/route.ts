import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import { hashPassword, verifyPassword } from "@/lib/password";

// POST /api/account/password — set or change the signed-in user's password.
//
// ROUTE PLACEMENT IS DELIBERATE: this lives under /api/account, NOT /api/auth.
// middleware.ts matches PUBLIC_PATHS by prefix, so every route under /api/auth/* is
// unauthenticated by construction (which is why the Google disconnect route does its
// own session check). A password-change endpoint there would be one forgotten line
// away from letting anyone change anyone's password. Here middleware gates it AND the
// route re-checks, per the defense-in-depth convention.
//
// KNOWN LIMITATION: session cookies are stateless HMAC tokens (lib/auth.ts), so a
// password change cannot invalidate sessions already issued to other devices.
// Fixing that means embedding a passwordChangedAt claim in the token and checking it
// in middleware — a change to the auth model, deferred. The UI says so plainly.
export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

    // Same minimum as registration — validated before touching the DB.
    if (newPassword.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters." },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    // An empty hash means a Google-only account that has never had a password, so
    // there is nothing to verify against. This branch MUST come before the
    // verifyPassword call: that function returns false on an empty hash, so falling
    // through would make it permanently impossible for a Google user to set one —
    // the exact gap this endpoint exists to close.
    if (user.passwordHash !== "") {
      if (!currentPassword) {
        return NextResponse.json({ error: "Enter your current password." }, { status: 400 });
      }
      if (!(await verifyPassword(currentPassword, user.passwordHash))) {
        // 400, not 401: 401 is reserved for "not signed in" and would read to the
        // client as an expired session rather than a wrong value in this field.
        return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 });
      }
    }

    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(newPassword) },
    });

    // Never return the user row or the hash.
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[/api/account/password]", e);
    return NextResponse.json({ error: "Could not save password — try again." }, { status: 500 });
  }
}
