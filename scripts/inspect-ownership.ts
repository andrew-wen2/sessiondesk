import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      googleId: true,
      passwordHash: true,
      _count: { select: { students: true, sessions: true, books: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  console.log("USERS:");
  for (const u of users) {
    console.log(
      `  ${u.email}  id=${u.id}  google=${u.googleId ? "yes" : "no"}  pw=${u.passwordHash ? "set" : "empty"}  students=${u._count.students} sessions=${u._count.sessions} books=${u._count.books}`
    );
  }

  // Orphans would mean rows with a userId pointing nowhere — shouldn't happen with FKs.
  const totals = {
    students: await prisma.student.count(),
    sessions: await prisma.session.count(),
    books: await prisma.book.count(),
  };
  console.log("\nTOTAL ROWS:", totals);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
