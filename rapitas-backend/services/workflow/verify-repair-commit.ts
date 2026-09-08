/** Atomic repair admission. Callers must deliver durable feedback before dispatch. */
import type { PrismaClient } from '../../generated/prisma-postgres';
import { withTaskLifecycleLock } from './task-lifecycle-lock';
import { THEME_STOP_INTENT } from '../agents/theme-stop-intent';

export interface RepairAdmission {
  taskId: number;
  updatedAt: Date;
  workflowStatus: string | null;
  executionId: number | null;
  max: number;
  reason: string;
  verifyContent: string;
  caller: string;
}

export type RepairCommit =
  | { committed: false; reason: string }
  | { committed: true; attempt: number; newStatus: string; updatedAt: Date };

/** State and budget-bearing evidence either both persist or neither persists. */
export async function commitVerifyRepair(
  db: PrismaClient,
  input: RepairAdmission,
): Promise<RepairCommit> {
  if (!Number.isSafeInteger(input.max) || input.max < 1)
    return { committed: false, reason: 'repair_disabled' };
  return withTaskLifecycleLock(input.taskId, () =>
    db.$transaction(
      async (tx) => {
        const taskId = input.taskId;
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
          task.workflowStatus === 'completed' ||
          task.workflowStatus !== input.workflowStatus ||
          task.updatedAt.getTime() !== input.updatedAt.getTime()
        )
          return { committed: false, reason: 'stale_task' };
        const execution = await tx.agentExecution.findFirst({
          where: { session: { config: { taskId } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, status: true, startedAt: true },
        });
        if ((execution?.id ?? null) !== input.executionId)
          return { committed: false, reason: 'execution_superseded' };
        if (['canceled', 'cancelled', 'canceling', 'cancelling'].includes(execution?.status ?? ''))
          return { committed: false, reason: 'execution_stopped' };
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
        if (stop && (!execution?.startedAt || execution.startedAt <= stop.createdAt))
          return { committed: false, reason: 'stop_requested' };
        const theme =
          task.themeId === null
            ? null
            : await tx.themeAutoRun.findUnique({
                where: { themeId: task.themeId },
                select: { status: true },
              });
        if (theme && ['stopping', 'paused'].includes(theme.status))
          return { committed: false, reason: 'theme_stopped' };
        // Read the reset boundary and count in the same snapshot as the mutation.
        const activity = await tx.activityLog.findFirst({
          where: { taskId, action: { in: ['task_retried', 'acceptance_criteria_changed'] } },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        });
        const transition = await tx.workflowTransition.findFirst({
          where: { taskId, cause: { in: ['question_resolved', 'plan_invalid_replan'] } },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        });
        const boundaries = [activity?.createdAt, transition?.createdAt].filter(
          (d): d is Date => !!d,
        );
        const windowStart = boundaries.length
          ? new Date(Math.max(...boundaries.map((d) => d.getTime())))
          : null;
        const prior = await tx.workflowTransition.count({
          where: {
            taskId,
            cause: 'verify_repair',
            ...(windowStart ? { createdAt: { gt: windowStart } } : {}),
          },
        });
        if (prior >= input.max) return { committed: false, reason: 'budget_exhausted' };
        const plan = await tx.workflowFile.findUnique({
          where: { taskId_fileType: { taskId, fileType: 'plan' } },
          select: { id: true },
        });
        const newStatus = plan ? 'plan_approved' : 'research_done';
        const updatedAt = new Date(Math.max(Date.now(), input.updatedAt.getTime() + 1));
        const changed = await tx.task.updateMany({
          where: {
            id: taskId,
            status: 'in-progress',
            workflowStatus: input.workflowStatus,
            updatedAt: input.updatedAt,
          },
          data: { workflowStatus: newStatus, updatedAt },
        });
        if (changed.count !== 1) return { committed: false, reason: 'stale_task' };
        const attempt = prior + 1;
        await tx.workflowTransition.create({
          data: {
            taskId,
            executionId: input.executionId,
            fromStatus: input.workflowStatus,
            toStatus: newStatus,
            actor: 'system',
            phase: 'verify',
            cause: 'verify_repair',
            metadata: JSON.stringify({
              attempt,
              max: input.max,
              reason: input.reason,
              caller: input.caller,
              windowStart: windowStart?.toISOString() ?? null,
              // Recovery retains the exact rejection if feedback delivery fails after commit.
              verifyContent: input.verifyContent,
            }),
          },
        });
        return { committed: true, attempt, newStatus, updatedAt };
      },
      { isolationLevel: 'Serializable' },
    ),
  );
}
