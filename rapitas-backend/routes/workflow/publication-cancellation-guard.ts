/** Bind publication to one execution snapshot and recheck before external mutations. */
import type { PrismaClient } from '../../generated/prisma-postgres';

export async function createPublicationCancellationGuard(
  prisma: PrismaClient,
  taskId: number,
  sessionId?: number,
) {
  if (!sessionId) throw new Error('Publication withheld: missing execution session');
  const read = async () => {
    const rows = await prisma.agentExecution.findMany({
      where: { sessionId, session: { config: { taskId } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true },
    });
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { status: true, workflowStatus: true },
    });
    if (
      !task ||
      task.status === 'blocked' ||
      task.workflowStatus === 'awaiting_question' ||
      !rows.length ||
      rows.some((row) =>
        ['canceling', 'running', 'pending', 'waiting_for_input'].includes(row.status),
      ) ||
      !['completed', 'post_processing'].includes(rows[0].status)
    ) {
      throw new Error('Publication withheld: execution stopped or state unavailable');
    }
    return rows[0].id;
  };
  const executionId = await read();
  return async () => {
    if ((await read()) !== executionId)
      throw new Error('Publication withheld: execution superseded');
  };
}
