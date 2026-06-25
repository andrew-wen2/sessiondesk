// Stateless session tokens for the multi-user gate. A signed cookie carries the
// userId — no sessions table. Signing/verifying uses Web Crypto (HMAC-SHA256) so
// it works in both the Node runtime (auth routes) and the Edge runtime
// (middleware). Password hashing lives separately in lib/password.ts (bcrypt,
// Node-only) since it can't run on the Edge.

export const SESSION_COOKIE = "session";

// 30 days, in seconds.
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

// AUTH_SECRET signs the session cookie. A dev fallback keeps local runs working;
// production must set a real secret (a leaked/blank secret lets anyone forge a
// session for any userId).
function secret(): string {
  return process.env.AUTH_SECRET || "dev-insecure-secret-set-AUTH_SECRET";
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacHex(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return toHex(sig);
}

// Length-independent equality (avoids leaking the signature via timing).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Token format: `${userId}.${expSeconds}.${hmacHex}`. cuids contain no dots, so
// splitting on "." is unambiguous.
export async function signSession(userId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
  const payload = `${userId}.${exp}`;
  const sig = await hmacHex(payload);
  return `${payload}.${sig}`;
}

// Returns the userId for a valid, unexpired token, else null.
export async function verifySession(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!userId || !Number.isFinite(exp)) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;
  const expected = await hmacHex(`${userId}.${expStr}`);
  if (!safeEqual(sig, expected)) return null;
  return userId;
}
