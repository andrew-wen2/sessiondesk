import { PrismaClient } from "@prisma/client";
import { students } from "./seed.roster";

const prisma = new PrismaClient();

// Real student data lives in prisma/seed.roster.ts, which is gitignored so the
// roster never enters version control. Copy prisma/seed.roster.example.ts to
// prisma/seed.roster.ts and fill in the real students before running the seed.
// 0=Sun, 1=Mon ... 6=Sat. Recurring weekday + start hour (local) per student.
export type StudentSeed = {
  name: string;
  subject: string;
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
  for (const s of students) {
    const { weekday, hour, ...studentData } = s;
    const id = s.name.toLowerCase(); // stable seed IDs

    await prisma.student.upsert({
      where: { id },
      update: studentData,
      create: { id, ...studentData },
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
          start,
          amount: s.rate,
        },
      });
    }
  }

  console.log("Seeded students:", students.map((s) => s.name).join(", "));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
