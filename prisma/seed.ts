import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { students } from "./seed.roster";

const prisma = new PrismaClient();

// The seeded roster is owned by a single bootstrap user. Override the login with
// SEED_EMAIL / SEED_PASSWORD; defaults let `npm run seed` produce a usable login.
const SEED_EMAIL = process.env.SEED_EMAIL || "bootstrap@sessiondesk.local";
const SEED_PASSWORD = process.env.SEED_PASSWORD || "changeme123";

// Real student data lives in prisma/seed.roster.ts, which is gitignored so the
// roster never enters version control. Copy prisma/seed.roster.example.ts to
// prisma/seed.roster.ts and fill in the real students before running the seed.
// 0=Sun, 1=Mon ... 6=Sat. Recurring weekday + start hour (local) per student.
export type StudentSeed = {
  name: string;
  level: string;
  rate: number;
  notes: string;
  weekday: number;
  hour: number;
};

// Every date in the current month falling on `weekday`.
function monthDatesForWeekday(weekday: number, hour: number): Date[] {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const out: Date[] = [];
  const d = new Date(year, month, 1, hour, 0, 0, 0);
  while (d.getMonth() === month) {
    if (d.getDay() === weekday) out.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

async function main() {
  // Bootstrap owner for the seeded roster. Reuses the fixed id the migration
  // assigned to pre-existing rows so re-seeding doesn't orphan them.
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
  const user = await prisma.user.upsert({
    where: { email: SEED_EMAIL },
    update: { passwordHash },
    create: { id: "usr_bootstrap", email: SEED_EMAIL, passwordHash },
  });
  const userId = user.id;

  for (const s of students) {
    const { weekday, hour, ...studentData } = s;
    const id = s.name.toLowerCase(); // stable seed IDs

    await prisma.student.upsert({
      where: { id },
      update: { ...studentData, userId },
      create: { id, ...studentData, userId },
    });

    // Recurring sessions for the current month (deterministic IDs → idempotent).
    for (const start of monthDatesForWeekday(weekday, hour)) {
      const sessionId = `${id}-${ymd(start)}`;
      await prisma.session.upsert({
        where: { id: sessionId },
        update: { start, amount: s.rate },
        create: {
          id: sessionId,
          studentId: id,
          userId,
          start,
          amount: s.rate,
        },
      });
    }
  }

  console.log("Seeded students:", students.map((s) => s.name).join(", "));
  console.log("Login:", SEED_EMAIL);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
