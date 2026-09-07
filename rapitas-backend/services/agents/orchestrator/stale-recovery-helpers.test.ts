/**
 * stale-recovery-helpers unit tests
 *
 * Covers updateAffectedTasks — the todo-revert path that must also record a
 * WorkflowTransition so the self-incident watcher's recovery grace applies —
 * plus the session-recovery guards: non-terminal executions keep a session
 * live, and the conditional write refuses to relabel a session that reached a
 * terminal status between the count and the update.
 */
import { describe, test, expect, mock } from 'bun:test';

mock.module('../../../config', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const mockRecordTransition = mock(() => Promise.resolve());
mock.module('../../workflow/transition-recorder', () => ({
  recordTransition: mockRecordTransition,
}));

const { updateAffectedTasks, updateAffectedSessions, reconcileOrphanedActiveSessions } =
  await import('./stale-recovery-helpers');
import type { OrchestratorContext } from './types';

for (const status of ['post_processing', 'canceling', 'waiting_for_input']) {
  test(`session recovery preserves ${status} executions`, async () => {
    const update = mock(async () => ({}));
    const ctx = {
      serverStartedAt: new Date(),
      prisma: {
        agentSession: { findMany: async () => [{ id: 1 }], update },
        agentExecution: {
          count: async (args: { where: { status: { in: string[] } } }) =>
            args.where.status.in.includes(status) ? 1 : 0,
        },
      },
    } as unknown as OrchestratorContext;
    expect(await updateAffectedSessions(ctx, new Set([1]))).toBe(0);
    expect(await reconcileOrphanedActiveSessions(ctx)).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });
}

test('session completion between count and update is protected by the conditional write', async () => {
  const update = mock(async (args: { where: { status?: { in: string[] } } }) => {
    // The phase finished after the recovery count returned zero.
    if (args.where.status && !args.where.status.in.includes('completed')) {
      throw new Error('P2025: conditional update matched no session');
    }
    return {};
  });
  const ctx = {
    prisma: { agentExecution: { count: async () => 0 }, agentSession: { update } },
  } as unknown as OrchestratorContext;
  expect(await updateAffectedSessions(ctx, new Set([1]))).toBe(0);
  expect(update).toHaveBeenCalledTimes(1);
});

test('orphan reconciliation ignores sessions created after this process started', async () => {
  const findMany = mock(async (_args: unknown) => []);
  const ctx = {
    serverStartedAt: new Date('2026-09-08T00:00:00Z'),
    prisma: { agentSession: { findMany }, agentExecution: { count: async () => 0 } },
  } as unknown as OrchestratorContext;

  await reconcileOrphanedActiveSessions(ctx);

  expect(findMany).toHaveBeenCalledWith({
    where: {
      status: { in: ['active', 'running'] },
      createdAt: { lt: ctx.serverStartedAt },
    },
    select: { id: true },
  });
});

function makeCtx(
  taskFindUnique: ReturnType<typeof mock>,
  taskUpdate: ReturnType<typeof mock> = mock(async () => ({})),
): OrchestratorContext {
  return {
    prisma: {
      task: { findUnique: taskFindUnique, update: taskUpdate },
    },
  } as unknown as OrchestratorContext;
}

describe('updateAffectedTasks', () => {
  test('reverts an in-progress task to todo and records the revert transition', async () => {
    mockRecordTransition.mockClear();
    const taskUpdate = mock(async () => ({}));
    const taskFindUnique = mock(async () => ({
      id: 100,
      status: 'in-progress',
      workflowStatus: 'in_progress',
    }));
    const ctx = makeCtx(taskFindUnique, taskUpdate);

    const updated = await updateAffectedTasks(ctx, new Set([100]));

    expect(updated).toBe(1);
    expect(taskUpdate).toHaveBeenCalledWith({ where: { id: 100 }, data: { status: 'todo' } });
    expect(mockRecordTransition).toHaveBeenCalledTimes(1);
    expect(mockRecordTransition.mock.calls[0][0]).toMatchObject({
      taskId: 100,
      fromStatus: 'in_progress',
      toStatus: 'in_progress',
      cause: 'stale_execution_recovery_revert',
    });
  });

  test('does not touch or record a transition for a task that is not in-progress', async () => {
    mockRecordTransition.mockClear();
    const taskUpdate = mock(async () => ({}));
    const taskFindUnique = mock(async () => ({
      id: 100,
      status: 'done',
      workflowStatus: 'completed',
    }));
    const ctx = makeCtx(taskFindUnique, taskUpdate);

    const updated = await updateAffectedTasks(ctx, new Set([100]));

    expect(updated).toBe(0);
    expect(taskUpdate).not.toHaveBeenCalled();
    expect(mockRecordTransition).not.toHaveBeenCalled();
  });

  test('a task lookup failure is swallowed and does not stop remaining tasks', async () => {
    mockRecordTransition.mockClear();
    const taskFindUnique = mock(async (args: { where: { id: number } }) => {
      if (args.where.id === 1) throw new Error('lookup failed');
      return { id: 2, status: 'in-progress', workflowStatus: 'plan_approved' };
    });
    const ctx = makeCtx(taskFindUnique as unknown as ReturnType<typeof mock>);

    const updated = await updateAffectedTasks(ctx, new Set([1, 2]));

    expect(updated).toBe(1);
    expect(mockRecordTransition).toHaveBeenCalledTimes(1);
  });
});
