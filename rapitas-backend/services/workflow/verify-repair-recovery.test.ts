import { expect, mock, test } from 'bun:test';
import type { PrismaClient } from '../../generated/prisma-postgres';
const enqueue = mock(async (_db: unknown, _taskId: number, _receipt: unknown) => 'queued');
mock.module('./verify-repair-queue', () => ({ enqueueCommittedRepair: enqueue }));
const { recoverPendingRepairs, RepairRecoveryError } = await import('./verify-repair-recovery');

test('a corrupt audit does not starve later repairs, and the pass still reports failure', async () => {
  const wake = mock(() => {});
  const db = {
    task: { findMany: async () => [{ id: 1 }, { id: 2 }] },
    agentExecution: { findFirst: async () => null },
    workflowTransition: {
      findFirst: async ({ where }: { where: { taskId: number } }) => ({
        metadata:
          where.taskId === 1
            ? '{broken'
            : JSON.stringify({
                resumeReceipt: {
                  updatedAt: new Date().toISOString(),
                  workflowStatus: 'plan_approved',
                  executionId: 2,
                },
              }),
      }),
    },
  };
  let failure: unknown;
  const failedTasks: number[] = [];
  try {
    await recoverPendingRepairs(db as unknown as PrismaClient, wake, Date.now(), (id) => {
      failedTasks.push(id);
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(RepairRecoveryError);
  expect((failure as InstanceType<typeof RepairRecoveryError>).errors[0].message).toContain(
    'task 1',
  );
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(enqueue.mock.calls[0][1]).toBe(2);
  expect(wake).toHaveBeenCalledTimes(1);
  expect(failedTasks).toEqual([1]);
});
