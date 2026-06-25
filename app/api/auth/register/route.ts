import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { SESSION_COOKIE, SESSION_MAX_AGE, signSession } from "@/lib/auth";
import { hashPassword } from "@/lib/password";

// POST /api/auth/register — create a new user account and sign them in. Each user
// gets their own isolated students/sessions/books.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !email.includes("@")) {
      return NextResponse.json({ error: "Enter a valid email." }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters." },
        { status: 400 }
      );
    }

    const user = await prisma.user.create({
      data: { email, passwordHash: await hashPassword(password) },
    });

    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, await signSession(user.id), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
    return res;
  } catch (e) {
    // Unique-constraint violation → email already registered.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json(
        { error: "That email is already registered — sign in instead." },
        { status: 409 }
      );
    }
    console.error("[/api/auth/register]", e);
    return NextResponse.json({ error: "Could not create account — try again." }, { status: 500 });
  }
}
