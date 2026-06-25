// Password hashing — bcrypt, Node runtime only (never imported into middleware,
// which runs on the Edge). Kept separate from lib/auth.ts so the Edge-safe token
// helpers don't pull bcrypt into the middleware bundle.
import bcrypt from "bcryptjs";

const ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  // An empty hash (the bootstrap user) can never match.
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}
