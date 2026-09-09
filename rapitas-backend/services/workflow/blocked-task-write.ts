/** Conditional hold write shared by failure paths; audit availability cannot undo a hold. */
import type { PrismaClient, Prisma } from '../../generated/prisma-postgres';

/** Write a fresh hold revision, rejecting a concurrent task mutation. */
export async function writeBlockedTask(
  db: Pick<PrismaClient, 'task'>,
  taskId: number,
  data: Prisma.TaskUpdateInput = {},
) {
  const current = await db.task.findUnique({ where: { id: taskId }, select: { updatedAt: true } });
  if (!current) throw new Error(`Cannot block missing task ${taskId}`);
  return db.task.update({
    where: { id: taskId, updatedAt: current.updatedAt },
    data: {
      ...data,
      status: 'blocked',
      updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)),
    },
  });
}
