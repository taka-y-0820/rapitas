/** A durable answer starts a new run budget; heartbeats do not reset its hard ceiling. */
import type { PrismaClient } from '../../../generated/prisma-postgres';

export async function resolveResumedTenureStart(
  prisma: PrismaClient,
  taskId: number,
  original: number,
): Promise<number> {
  const resume = await prisma.workflowTransition.findFirst({
    where: {
      taskId,
      fromStatus: 'awaiting_question',
      cause: { in: ['intake_question_answered', 'question_resolved'] },
      createdAt: { gt: new Date(original) },
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const resumedAt = resume?.createdAt.getTime();
  return resumedAt !== undefined && Number.isFinite(resumedAt)
    ? Math.max(original, resumedAt)
    : original;
}
