/** Durable queue admission for one committed repair; never starts a process. */
import type { PrismaClient } from '../../generated/prisma-postgres';
import { withTaskLifecycleLock } from './task-lifecycle-lock';
import { THEME_STOP_INTENT } from '../agents/theme-stop-intent';

export interface RepairQueueReceipt {
  updatedAt: Date;
  workflowStatus: string;
  executionId: number | null;
}

export async function enqueueCommittedRepair(
  db: PrismaClient,
  taskId: number,
  receipt: RepairQueueReceipt,
): Promise<'queued' | 'existing' | 'held' | 'scheduler_owned'> {
  return withTaskLifecycleLock(taskId, () =>
    db.$transaction(
      async (tx) => {
        const task = await tx.task.findUnique({
          where: { id: taskId },
          select: {
            status: true,
            workflowStatus: true,
            updatedAt: true,
            themeId: true,
          },
        });
        if (
          !task ||
          task.status !== 'in-progress' ||
          task.workflowStatus !== receipt.workflowStatus ||
          task.updatedAt.getTime() !== receipt.updatedAt.getTime()
        )
          return 'held';
        const execution = await tx.agentExecution.findFirst({
          where: { session: { config: { taskId } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, status: true, startedAt: true },
        });
        if (
          (execution?.id ?? null) !== receipt.executionId ||
          ['canceled', 'cancelled', 'canceling', 'cancelling'].includes(execution?.status ?? '')
        )
          return 'held';
        const stop = await tx.workflowTransition.findFirst({
          where: {
            taskId,
            cause: {
              in: [
                THEME_STOP_INTENT,
                'manual_execution_stop_revert',
                'manual_execution_stop_withdraw',
                'auto_run_stop_revert',
              ],
            },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { createdAt: true },
        });
        if (stop && (!execution?.startedAt || execution.startedAt <= stop.createdAt)) return 'held';
        const theme =
          task.themeId === null
            ? null
            : await tx.themeAutoRun.findUnique({
                where: { themeId: task.themeId },
                select: { enabled: true, status: true },
              });
        if (theme && ['stopping', 'paused'].includes(theme.status)) return 'held';
        if (theme?.enabled && theme.status === 'running') return 'scheduler_owned';
        const existing = await tx.workflowQueueItem.findFirst({
          where: {
            taskId,
            orchestraSessionId: null,
            status: { in: ['queued', 'running', 'waiting_approval'] },
          },
          select: { id: true },
        });
        if (existing) return 'existing';
        await tx.workflowQueueItem.create({
          data: {
            taskId,
            orchestraSessionId: null,
            themeId: task.themeId,
            status: 'queued',
            currentPhase: receipt.workflowStatus,
            priority: 50,
            dependencies: '[]',
          },
          select: { id: true },
        });
        return 'queued';
      },
      { isolationLevel: 'Serializable' },
    ),
  );
}
