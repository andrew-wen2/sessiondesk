// Server-side current-user helpers. Read the signed session cookie and return the
// authenticated userId. Routes and server components call these to scope every
// query to the logged-in user. Middleware already blocks unauthenticated requests,
// but these re-verify (defense in depth) and give the userId for scoping.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

// userId for the current request, or null if not signed in.
export async function getCurrentUserId(): Promise<string | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return verifySession(token);
}

// For server components: returns the userId or redirects to /login.
export async function requireUserId(): Promise<string> {
  const userId = await getCurrentUserId();
  if (!userId) redirect("/login");
  return userId;
}
