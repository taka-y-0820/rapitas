import { expect, mock, test } from 'bun:test';
import type { PrismaClient } from '../../generated/prisma-postgres';
const enqueue = mock(async (_db: unknown, _taskId: number, _receipt: unknown) => 'queued');
mock.module('./verify-repair-queue', () => ({ enqueueCommittedRepair: enqueue }));
const { recoverPendingRepairs, recoverCommittedRepair, RepairRecoveryError } =
  await import('./verify-repair-recovery');

test('recovery selects the latest repair or requirement replan without inventing a new receipt', async () => {
  const receipt = {
    updatedAt: '2026-09-09T00:00:00.000Z',
    workflowStatus: 'research_done',
    executionId: 3934,
  };
  const findFirst = mock(async () => ({ metadata: JSON.stringify({ resumeReceipt: receipt }) }));
  const db = { workflowTransition: { findFirst } } as unknown as PrismaClient;
  await recoverCommittedRepair(db, 913);
  expect(findFirst).toHaveBeenCalledWith({
    where: { taskId: 913, cause: { in: ['verify_repair', 'requirement_evidence_replan'] } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { metadata: true },
  });
  expect(enqueue).toHaveBeenLastCalledWith(db, 913, {
    ...receipt,
    updatedAt: new Date(receipt.updatedAt),
  });
  enqueue.mockClear();
});

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
