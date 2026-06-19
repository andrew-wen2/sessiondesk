// TEMP probe (Step 0) — inspect the book's structured chapters shape.
// Delete after measuring.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const book = await prisma.book.findFirst({
    where: { title: { contains: "Art of Problem" } },
    select: { title: true, chapters: true, contents: true },
  });
  if (!book) {
    console.log("book not found");
    return;
  }
  console.log("title:", book.title);
  console.log("contents length:", book.contents.length);
  const ch = book.chapters;
  console.log("chapters is array:", Array.isArray(ch));
  if (Array.isArray(ch)) {
    console.log("chapter count:", ch.length);
    console.log("first 2 chapters (shape):", JSON.stringify(ch.slice(0, 2), null, 2));
    // List chapter heads + section counts
    for (const c of ch as Array<{ number?: string; title?: string; sections?: unknown[] }>) {
      console.log(`  Ch ${c.number ?? ""}: ${c.title ?? ""} (${Array.isArray(c.sections) ? c.sections.length : 0} sections)`);
    }
  } else {
    console.log("chapters raw:", JSON.stringify(ch));
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    return prisma.$disconnect().then(() => process.exit(1));
  });
