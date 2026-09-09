/**
 * workflow-orchestrator-context.test
 *
 * Covers reconcileTaskStatusBeforeRun — the pre-dispatch status reconciliation.
 * Focus: the flip off 'todo' must be decided by the DATABASE row, not by the
 * snapshot runPreflight read, because the startup reaper can revert a task to
 * 'todo' between those two points (task 658 ran while displaying 'todo').
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
let dbProvider = 'sqlite';
mock.module('../../config/db-provider', () => ({ getDbProvider: () => dbProvider }));
mock.module('../self-learning/prompt-evolution-worker', () => ({
  getApprovedRoleAddendum: async () => '',
}));
mock.module('../self-learning/experiment-loop/experiment-store', () => ({
  getActiveExperimentAddendum: async () => '',
}));

const taskUpdate = mock(() => Promise.resolve({}));
const taskUpdateMany = mock(() => Promise.resolve({ count: 1 }));
const workflowFileFindFirst = mock(() => Promise.resolve<{ id: number } | null>(null));

const mockPrisma = {
  task: { update: taskUpdate, updateMany: taskUpdateMany },
  workflowFile: { findFirst: workflowFileFindFirst },
};

mock.module('../../config', () => ({
  prisma: mockPrisma,
  createLogger: () => noopLogger,
  logger: noopLogger,
}));
mock.module('../../config/logger', () => ({ createLogger: () => noopLogger }));
mock.module('./workflow-context-builder', () => ({
  buildRoleContext: mock(() => Promise.resolve('ctx')),
}));
mock.module('./role-route-inputs', () => ({
  routeModelForRole: mock(() => Promise.resolve({ modelId: 'm', details: {} })),
  shouldAutoSelectModel: mock(() => true),
}));

const { reconcileTaskStatusBeforeRun, buildExecutionContext } =
  await import('./workflow-orchestrator-context');

test('execution context identifies the active database without assuming the target project uses it', async () => {
  for (const provider of ['sqlite', 'postgresql']) {
    dbProvider = provider;
    for (const language of ['ja', 'en'] as const) {
      const context = await buildExecutionContext(
        1,
        { role: 'planner', outputFile: 'plan', nextStatus: 'plan_created' },
        {} as never,
        language,
        'standard',
      );
      expect(context).toContain(provider);
      expect(context).toContain(
        language === 'ja' ? '別の対象プロジェクト' : 'different target project',
      );
    }
  }
});

describe('reconcileTaskStatusBeforeRun', () => {
  beforeEach(() => {
    taskUpdate.mockReset().mockResolvedValue({});
    taskUpdateMany.mockReset().mockResolvedValue({ count: 1 });
    workflowFileFindFirst.mockReset().mockResolvedValue(null);
  });

  test('draft with no artifacts stays draft and moves the task to in-progress', async () => {
    await reconcileTaskStatusBeforeRun(658, 'draft');

    const call = taskUpdate.mock.calls[0]?.[0] as {
      where: { id: number };
      data: { workflowStatus: string; status: string };
    };
    expect(call.where).toEqual({ id: 658 });
    expect(call.data).toEqual({ workflowStatus: 'draft', status: 'in-progress' });
  });

  test('draft with a reusable plan fast-forwards to plan_created', async () => {
    workflowFileFindFirst.mockResolvedValue({ id: 1 });

    await reconcileTaskStatusBeforeRun(658, 'draft');

    const call = taskUpdate.mock.calls[0]?.[0] as { data: { workflowStatus: string } };
    expect(call.data.workflowStatus).toBe('plan_created');
  });

  test('non-draft flips off todo via a conditional update, not a caller status', async () => {
    // No status is passed at all any more: in the task-658 window the startup
    // reaper wrote 'todo' AFTER preflight read the row, so any value handed in
    // here could be stale. The DB row is the only trustworthy source.
    await reconcileTaskStatusBeforeRun(658, 'research_done');

    expect(taskUpdate).not.toHaveBeenCalled();
    const call = taskUpdateMany.mock.calls[0]?.[0] as {
      where: { id: number; status: string };
      data: { status: string };
    };
    expect(call.where).toEqual({ id: 658, status: 'todo' });
    expect(call.data).toEqual({ status: 'in-progress' });
  });

  test('the conditional update is what protects done/blocked from being clobbered', async () => {
    taskUpdateMany.mockResolvedValue({ count: 0 }); // row was 'done' — nothing matched

    await reconcileTaskStatusBeforeRun(658, 'verify_done');

    const call = taskUpdateMany.mock.calls[0]?.[0] as { where: { status: string } };
    expect(call.where.status).toBe('todo');
    expect(taskUpdate).not.toHaveBeenCalled();
  });
});
