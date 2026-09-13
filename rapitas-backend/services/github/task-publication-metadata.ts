/** Publication bookkeeping must not invalidate an otherwise current task review. */
import type { PrismaClient } from '../../generated/prisma-postgres';

type Metadata = { prCreationLockedAt?: Date | null; githubPrId?: number };

/** Preserve the content revision; a concurrent task edit fails the CAS. */
export async function updateTaskPublicationMetadata(
  db: PrismaClient,
  taskId: number,
  data: Metadata,
  condition: { OR?: Array<{ prCreationLockedAt: null | { lt: Date } }> } = {},
): Promise<boolean> {
  const task = await db.task.findUnique({ where: { id: taskId }, select: { updatedAt: true } });
  if (!task) return false;
  const result = await db.task.updateMany({
    where: { ...condition, id: taskId, updatedAt: task.updatedAt },
    data: { ...data, updatedAt: task.updatedAt },
  });
  return result.count === 1;
}
