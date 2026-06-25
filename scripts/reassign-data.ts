import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// One-off: move all students/sessions/books onto the target user (e.g. the Google
// account), leaving the empty source user in place. Idempotent — rows already on
// the target are skipped by the `not` filter.
async function main() {
  const targetEmail = (process.argv[2] || "awen2815@gmail.com").toLowerCase();

  const target = await prisma.user.findUnique({ where: { email: targetEmail } });
  if (!target) {
    throw new Error(`No user with email ${targetEmail} — sign in first to create it.`);
  }

  const result = await prisma.$transaction(async (tx) => {
    const students = await tx.student.updateMany({
      where: { userId: { not: target.id } },
      data: { userId: target.id },
    });
    const sessions = await tx.session.updateMany({
      where: { userId: { not: target.id } },
      data: { userId: target.id },
    });
    const books = await tx.book.updateMany({
      where: { userId: { not: target.id } },
      data: { userId: target.id },
    });
    return { students: students.count, sessions: sessions.count, books: books.count };
  });

  console.log(`Reassigned to ${targetEmail} (id=${target.id}):`);
  console.log(`  students: ${result.students}`);
  console.log(`  sessions: ${result.sessions}`);
  console.log(`  books:    ${result.books}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
