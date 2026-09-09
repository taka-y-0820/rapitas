/**
 * execute-post-handler.test
 *
 * Focused coverage for reconcileHardFailure (task 544): an execution that was
 * reported as failed (IPC timeout / success:false) must NOT be hard-failed
 * when workflow artifacts advanced during the run, while a genuine failure
 * (no artifacts saved) must keep the legacy todo/failed marking.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const SESSION_CREATED_AT = new Date('2026-08-07T17:04:00Z');

const mockSessionFindUnique = mock(() =>
  Promise.resolve<{ startedAt: Date | null; createdAt: Date } | null>({
    startedAt: null,
    createdAt: SESSION_CREATED_AT,
  }),
);
const mockSessionUpdate = mock(() => Promise.resolve({}));
const mockTaskUpdate = mock(() => Promise.resolve({}));
const mockTaskFindUnique = mock(() =>
  Promise.resolve<{ workflowStatus: string | null } | null>({ workflowStatus: 'plan_created' }),
);
const mockWorkflowFileFindFirst = mock<() => Promise<{ id: number } | null>>(() =>
  Promise.resolve(null),
);
const mockExecUpdateMany = mock(() => Promise.resolve({ count: 0 }));

mock.module('../../../../config/database', () => ({
  prisma: {
    agentSession: { findUnique: mockSessionFindUnique, update: mockSessionUpdate },
    task: { update: mockTaskUpdate, findUnique: mockTaskFindUnique },
    workflowFile: { findFirst: mockWorkflowFileFindFirst },
    agentExecution: { updateMany: mockExecUpdateMany },
  },
  ensureDatabaseConnection: () => Promise.resolve(),
}));
mock.module('../../../../config/logger', () => ({ createLogger: () => noopLogger }));

const mockApplyTaskStatusFromWorkflow = mock(() => Promise.resolve());
mock.module('../../../../services/workflow/apply-task-status-from-workflow', () => ({
  applyTaskStatusFromWorkflow: mockApplyTaskStatusFromWorkflow,
}));

mock.module('../../../../services/agents/orchestrator/execution-heartbeat', () => ({
  HEARTBEAT_INTERVAL_MS: 15_000,
  LEASE_STALE_MS: 90_000,
  startExecutionHeartbeat: () => {},
  stopExecutionHeartbeat: () => {},
}));

// Transitive deps of execute-post-handler that must not touch real modules.
mock.module('../shared/session-helpers', () => ({
  updateSessionStatusWithRetry: () => Promise.resolve(),
}));
mock.module('./post-execution-review', () => ({
  reviewAndCommitWorktree: () => Promise.resolve(),
}));
mock.module('../shared/execution-output-validator', () => ({
  detectExecutionFailures: () => [],
}));
mock.module('../research/research-phase-handler', () => ({
  handleResearchResult: () => Promise.resolve(),
}));
mock.module('../research/research-output-utils', () => ({
  isIsolatedWorktree: () => true,
}));
mock.module('node:child_process', () => ({
  exec: (
    _cmd: string,
    _opts: unknown,
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => cb(null, { stdout: '', stderr: '' }),
}));

const { reconcileHardFailure } = await import('./execute-post-handler');

function baseParams() {
  return {
    taskId: 541,
    sessionId: 2098,
    errorMessage: 'IPC request timeout: execute-task',
    logPrefix: '[API]',
  };
}

type UpdateCall = [{ where: Record<string, unknown>; data: Record<string, unknown> }];
type UpdateManyCall = [
  { where: { status?: unknown; OR?: unknown }; data: Record<string, unknown> },
];

describe('reconcileHardFailure — workflow-progress guard (task 544)', () => {
  beforeEach(() => {
    mockSessionFindUnique.mockClear();
    mockSessionUpdate.mockClear();
    mockTaskUpdate.mockClear();
    mockTaskFindUnique.mockClear();
    mockWorkflowFileFindFirst.mockReset().mockResolvedValue(null);
    mockExecUpdateMany.mockClear();
    mockApplyTaskStatusFromWorkflow.mockClear();
  });

  test('stop during the workflow progress read prevents all failure writes', async () => {
    let current = true;
    mockWorkflowFileFindFirst.mockImplementationOnce(async () => {
      current = false;
      return null;
    });
    await reconcileHardFailure({ ...baseParams(), isExecutionCurrent: () => current });
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockSessionUpdate).not.toHaveBeenCalled();
    expect(mockExecUpdateMany).not.toHaveBeenCalled();
    expect(mockApplyTaskStatusFromWorkflow).not.toHaveBeenCalled();
  });

  test('前進あり: task は todo にされず、session は interrupted になる', async () => {
    mockWorkflowFileFindFirst.mockResolvedValue({ id: 1 });

    await reconcileHardFailure(baseParams());

    // The progress probe must scope to the task and to files updated after
    // session start (createdAt fallback — startedAt is null on this path).
    const findFirstArg = (
      mockWorkflowFileFindFirst.mock.calls[0] as unknown as [
        { where: { taskId: number; updatedAt: { gt: Date } } },
      ]
    )[0];
    expect(findFirstArg.where.taskId).toBe(541);
    expect(findFirstArg.where.updatedAt.gt).toEqual(SESSION_CREATED_AT);

    // Task.status is derived from workflowStatus via the shared helper —
    // never the unconditional 'todo' write.
    expect(mockApplyTaskStatusFromWorkflow).toHaveBeenCalledTimes(1);
    const applyArgs = mockApplyTaskStatusFromWorkflow.mock.calls[0] as unknown as [
      unknown,
      number,
      string,
    ];
    expect(applyArgs[1]).toBe(541);
    expect(applyArgs[2]).toBe('[API]');
    const todoWrites = (mockTaskUpdate.mock.calls as unknown as UpdateCall[]).filter(
      (c) => c[0].data.status === 'todo',
    );
    expect(todoWrites).toHaveLength(0);

    expect(mockSessionUpdate).toHaveBeenCalledTimes(1);
    const sessionArg = (mockSessionUpdate.mock.calls[0] as unknown as UpdateCall)[0];
    expect(sessionArg.data.status).toBe('interrupted');
    expect(String(sessionArg.data.errorMessage)).toContain('IPC request timeout: execute-task');
  });

  test('前進なし: 従来どおり task=todo / session=failed になる（回帰防止）', async () => {
    mockWorkflowFileFindFirst.mockResolvedValue(null);

    await reconcileHardFailure(baseParams());

    expect(mockApplyTaskStatusFromWorkflow).not.toHaveBeenCalled();

    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
    const taskArg = (mockTaskUpdate.mock.calls[0] as unknown as UpdateCall)[0];
    expect(taskArg.data.status).toBe('todo');

    expect(mockSessionUpdate).toHaveBeenCalledTimes(1);
    const sessionArg = (mockSessionUpdate.mock.calls[0] as unknown as UpdateCall)[0];
    expect(sessionArg.data.status).toBe('failed');
    expect(sessionArg.data.errorMessage).toBe('IPC request timeout: execute-task');

    expect(mockExecUpdateMany).not.toHaveBeenCalled();
  });

  test('前進あり: post_processing の execution が completed へフリップされる', async () => {
    mockWorkflowFileFindFirst.mockResolvedValue({ id: 1 });

    await reconcileHardFailure(baseParams());

    const calls = mockExecUpdateMany.mock.calls as unknown as UpdateManyCall[];
    const postProcessingFlip = calls.find((c) => c[0].where.status === 'post_processing');
    expect(postProcessingFlip).toBeDefined();
    expect(postProcessingFlip?.[0].data.status).toBe('completed');

    // Stale-lease sweep also ran (running/pending rows with stale heartbeat).
    const staleSweep = calls.find(
      (c) =>
        typeof c[0].where.status === 'object' &&
        c[0].data.status === 'interrupted' &&
        Array.isArray(c[0].where.OR),
    );
    expect(staleSweep).toBeDefined();
  });
});
