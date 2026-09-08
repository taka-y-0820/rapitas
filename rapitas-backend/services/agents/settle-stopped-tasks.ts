/** Atomically settle only tasks whose latest execution was actually cancelled by this stop. */
import type { PrismaClient } from '../../generated/prisma-postgres';
import { withTaskLifecycleLock } from '../workflow/task-lifecycle-lock';

export async function settleStoppedTasks(
  db: PrismaClient,
  executionIds: number[],
): Promise<number[]> {
  if (!executionIds.length) return [];
  const executions = await db.agentExecution.findMany({
    where: { id: { in: executionIds } },
    select: { session: { select: { config: { select: { taskId: true } } } } },
  });
  const ids = [...new Set(executions.map((e) => e.session.config.taskId))];
  const settled: number[] = [];
  for (const taskId of ids) {
    const changed = await withTaskLifecycleLock(taskId, () =>
      db.$transaction(
        async (tx) => {
          const task = await tx.task.findUnique({
            where: { id: taskId },
            select: { status: true, workflowStatus: true, updatedAt: true },
          });
          if (!task || task.status !== 'in-progress' || task.workflowStatus === 'completed')
            return false;
          const latest = await tx.agentExecution.findFirst({
            where: { session: { config: { taskId } } },
            orderBy: { id: 'desc' },
            select: { id: true, status: true },
          });
          if (
            !latest ||
            !executionIds.includes(latest.id) ||
            !['cancelled', 'canceled'].includes(latest.status)
          )
            return false;
          const result = await tx.task.updateMany({
            where: {
              id: taskId,
              status: task.status,
              workflowStatus: task.workflowStatus,
              updatedAt: task.updatedAt,
            },
            data: { status: 'todo', updatedAt: new Date() },
          });
          if (result.count !== 1) return false;
          await tx.workflowTransition.create({
            data: {
              taskId,
              fromStatus: task.workflowStatus,
              toStatus: task.workflowStatus ?? 'draft',
              actor: 'system',
              cause: 'auto_run_stop_revert',
              executionId: latest.id,
              metadata: JSON.stringify({ reason: 'auto_run_stop', executionIds }),
            },
          });
          return true;
        },
        { isolationLevel: 'Serializable' },
      ),
    );
    if (changed) settled.push(taskId);
  }
  return settled;
}
