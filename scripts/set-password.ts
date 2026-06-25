// Set (or reset) a user's password from the CLI. Primarily for the bootstrap user
// the multi-tenant migration assigns pre-existing data to — its passwordHash ships
// empty (un-loginable) until you set one here.
//
//   npm run set-password -- <email> <password>
//   npm run set-password -- bootstrap@sessiondesk.local 'a-strong-password'
//
// Standalone Node process (outside Next) → constructs its own PrismaClient, per the
// scripts/ exception in CLAUDE.md.
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error("Usage: npm run set-password -- <email> <password>");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  // Upsert: set the password on an existing account, or create the account if the
  // email is new (e.g. the bootstrap user was renamed).
  const user = await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: { passwordHash },
    create: { email: email.toLowerCase(), passwordHash },
  });
  console.log(`Password set for ${user.email}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
