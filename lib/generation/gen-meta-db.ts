import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { truncateGenMeta, type GenMeta } from "@/lib/generation/gen-meta";

// Read-modify-write of Session.genMeta, shared by /api/generate and
// /api/generate-lesson (both write the same column). The row is re-read immediately
// before the write rather than reusing a snapshot taken when the request started, so
// a key the other route wrote during a multi-minute generation is merged, not
// clobbered. Not atomic: two writes landing in the same instant can still lose one
// attempt record, which is acceptable for telemetry. Published keys are written only
// by the route that owns them.
export async function writeGenMeta(
  sessionId: string,
  next: (existing: unknown) => GenMeta,
  extra: Prisma.SessionUpdateInput = {}
): Promise<void> {
  const row = await prisma.session.findUnique({ where: { id: sessionId }, select: { genMeta: true } });
  const genMeta = truncateGenMeta(next(row?.genMeta));
  await prisma.session.update({
    where: { id: sessionId },
    data: { ...extra, genMeta: genMeta as unknown as Prisma.InputJsonValue },
  });
}
