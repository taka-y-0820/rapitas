/**
 * task-retry-handler unit tests
 *
 * Covers retryTask — the todo-revert path that must record a WorkflowTransition
 * for every workflowStatus, not only the verify_done rollback case, so
 * isWithinRecoveryGrace (incident-signature-detectors.ts) can grant the
 * recovery grace period (task 709 / task #602).
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const mockTaskFindUnique = mock(() =>
  Promise.resolve({ status: 'blocked', workflowStatus: 'verify_done' } as {
    status: string;
    workflowStatus: string | null;
  } | null),
);
const mockTaskUpdate = mock(() => Promise.resolve({ id: 1, status: 'todo' }));
const mockActivityLogCreate = mock(() => Promise.resolve({}));
const mockNotificationUpdateMany = mock(() => Promise.resolve({ count: 0 }));

mock.module('../../config/database', () => ({
  prisma: {
    task: { findUnique: mockTaskFindUnique, update: mockTaskUpdate },
    activityLog: { create: mockActivityLogCreate },
    notification: { updateMany: mockNotificationUpdateMany },
  },
}));

const mockResolveImplementEntryStatus = mock(() => Promise.resolve('research_done' as const));
mock.module('../../services/workflow/verify-self-repair', () => ({
  resolveImplementEntryStatus: mockResolveImplementEntryStatus,
}));

const mockRecordTransition = mock(() => Promise.resolve());
mock.module('../../services/workflow/transition-recorder', () => ({
  recordTransition: mockRecordTransition,
}));

const mockRecordReviewRetry = mock(() => Promise.resolve<'created' | 'duplicate'>('created'));
mock.module('../../services/workflow/requirement-review-claim', () => ({
  recordRequirementReviewRetryRequest: mockRecordReviewRetry,
}));

const { retryTask } = await import('./task-retry-handler');

function resetMocks() {
  mockTaskFindUnique.mockClear();
  mockTaskUpdate.mockClear();
  mockActivityLogCreate.mockClear();
  mockNotificationUpdateMany.mockClear();
  mockResolveImplementEntryStatus.mockClear();
  mockRecordTransition.mockClear();
  mockRecordReviewRetry.mockClear();
  mockRecordReviewRetry.mockResolvedValue('created');
}

describe('retryTask', () => {
  beforeEach(resetMocks);

  test('rolls back verify_done to the resolved entry status and records the transition', async () => {
    mockTaskFindUnique.mockResolvedValueOnce({ status: 'blocked', workflowStatus: 'verify_done' });
    mockResolveImplementEntryStatus.mockResolvedValueOnce('plan_approved');

    await retryTask(1, () => {});

    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: 'todo', workflowStatus: 'plan_approved' },
    });
    expect(mockRecordTransition).toHaveBeenCalledTimes(1);
    expect(mockRecordTransition.mock.calls[0][0]).toMatchObject({
      taskId: 1,
      fromStatus: 'verify_done',
      toStatus: 'plan_approved',
      cause: 'task_retried',
    });
  });

  test.each([
    ['research_done', 'research_done'],
    ['plan_created', 'plan_created'],
    ['plan_approved', 'plan_approved'],
    ['in_progress', 'in_progress'],
    ['draft', 'draft'],
  ])(
    'leaves workflowStatus=%s unchanged but still records the task_retried transition',
    async (workflowStatus, expectedToStatus) => {
      mockTaskFindUnique.mockResolvedValueOnce({ status: 'blocked', workflowStatus });

      await retryTask(1, () => {});

      expect(mockTaskUpdate).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { status: 'todo' },
      });
      expect(mockResolveImplementEntryStatus).not.toHaveBeenCalled();
      expect(mockRecordTransition).toHaveBeenCalledTimes(1);
      expect(mockRecordTransition.mock.calls[0][0]).toMatchObject({
        taskId: 1,
        fromStatus: workflowStatus,
        toStatus: expectedToStatus,
        cause: 'task_retried',
      });
    },
  );

  test('workflowStatus=null falls back to draft as the recorded toStatus', async () => {
    mockTaskFindUnique.mockResolvedValueOnce({ status: 'failed', workflowStatus: null });

    await retryTask(1, () => {});

    expect(mockRecordTransition.mock.calls[0][0]).toMatchObject({
      taskId: 1,
      fromStatus: null,
      toStatus: 'draft',
      cause: 'task_retried',
    });
  });

  test('throws for a task that is neither blocked nor failed', async () => {
    mockTaskFindUnique.mockResolvedValueOnce({ status: 'todo', workflowStatus: 'in_progress' });

    await expect(retryTask(1, () => {})).rejects.toThrow(
      'blocked / failed のタスクのみ再実行できます',
    );
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockRecordTransition).not.toHaveBeenCalled();
  });

  test('returns null and sets 404 when the task is absent', async () => {
    mockTaskFindUnique.mockResolvedValueOnce(null);
    const setStatus = mock((_code: number) => {});

    const result = await retryTask(1, setStatus);

    expect(result).toBeNull();
    expect(setStatus).toHaveBeenCalledWith(404);
    expect(mockRecordTransition).not.toHaveBeenCalled();
  });

  test('records an explicit retry request before mutating the task', async () => {
    await retryTask(1, () => {}, 'request-123');
    expect(mockRecordReviewRetry).toHaveBeenCalledWith(expect.anything(), 1, 'request-123');
    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
  });

  test('a duplicate explicit retry request does not repeat lifecycle mutations', async () => {
    mockRecordReviewRetry.mockResolvedValueOnce('duplicate');
    await retryTask(1, () => {}, 'request-123');
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockRecordTransition).not.toHaveBeenCalled();
  });
});
