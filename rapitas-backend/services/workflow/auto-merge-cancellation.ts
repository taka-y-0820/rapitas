/** Recheck stop state after CI I/O, before merge or CI-only completion. */
import type { PrismaClient } from '../../generated/prisma-postgres';
export async function canFinalizeAutoMerge(prisma: PrismaClient, taskId: number): Promise<boolean> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { status: true, workflowStatus: true },
  });
  if (
    !task ||
    !(
      ['done', 'completed'].includes(task.status) ||
      (task.status === 'in-progress' && task.workflowStatus === 'verify_done')
    )
  )
    return false;
  const stopping = await prisma.agentExecution.findFirst({
    where: { session: { config: { taskId } }, status: 'canceling' },
    select: { id: true },
  });
  return stopping === null;
}
