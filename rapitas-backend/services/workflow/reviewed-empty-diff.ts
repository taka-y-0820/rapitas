/** Atomically hold an unchanged reviewed task; never completes it or dispatches work. */
import type { PrismaClient } from '../../generated/prisma-postgres';
import type { CompletionReviewReceipt } from './requirement-replan-commit';
import { THEME_STOP_INTENT } from '../agents/theme-stop-intent';
import { withTaskLifecycleLock } from './task-lifecycle-lock';

export async function blockReviewedEmptyDiff(
  db: PrismaClient,
  receipt: CompletionReviewReceipt,
  reason: string,
): Promise<void> {
  const taskId = receipt.taskId;
  await withTaskLifecycleLock(taskId, () =>
    db.$transaction(
      async (tx) => {
        const execution = await tx.agentExecution.findFirst({
          where: { session: { config: { taskId } } },
          orderBy: { id: 'desc' },
          select: { id: true, status: true, startedAt: true },
        });
        if ((execution?.id ?? null) !== receipt.executionId)
          throw new Error('Empty-diff block held: execution superseded');
        if (['canceled', 'cancelled', 'canceling', 'cancelling'].includes(execution?.status ?? ''))
          throw new Error('Empty-diff block held: execution stopped');
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
          throw new Error('Empty-diff block held: stop not resumed');
        const updated = await tx.task.updateMany({
          where: {
            id: taskId,
            status: 'in-progress',
            workflowStatus: 'verify_done',
            updatedAt: receipt.evaluatedUpdatedAt,
          },
          data: {
            status: 'blocked',
            updatedAt: new Date(Math.max(Date.now(), receipt.evaluatedUpdatedAt.getTime() + 1)),
          },
        });
        if (updated.count !== 1) throw new Error('Empty-diff block held: task changed');
        await tx.workflowTransition.create({
          data: {
            taskId,
            fromStatus: 'verify_done',
            toStatus: 'verify_done',
            actor: 'verifier',
            cause: 'verify_no_changes',
            phase: 'verify',
            metadata: JSON.stringify({ reason }),
            invariantViolation: true,
            invariantMessage:
              'Verification passed without implementation changes or evidence justifying no change. Further verification is required.',
          },
        });
      },
      { isolationLevel: 'Serializable' },
    ),
  );
}
