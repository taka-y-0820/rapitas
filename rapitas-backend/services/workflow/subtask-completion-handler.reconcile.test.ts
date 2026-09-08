/**
 * subtask-completion-handler ユニットテスト（status/workflowStatus 不整合の自己修復）
 *
 * 親の workflowStatus が既に 'completed' なのに status が 'done' に追いついて
 * いない場合、onSubtaskCompleted が verify.md/PR を再実行せず status のみを
 * 'done' に修復することを検証する。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
  fatal: () => {},
};
mock.module('../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
  getBackendLogFilePath: () => '/tmp/backend.log',
}));

const taskUpdate = mock(() => Promise.resolve({}));
const taskFindMany = mock(() => Promise.resolve([]) as ReturnType<typeof mock>);
mock.module('../../config/database', () => ({
  prisma: {
    task: {
      findMany: taskFindMany,
      update: taskUpdate,
    },
  },
}));

const sendTaskUpdate = mock(() => {});
mock.module('../communication/realtime-service', () => ({
  realtimeService: { sendTaskUpdate, broadcast: mock(() => {}) },
  RealtimeService: class {},
}));

mock.module('./workflow-file-utils', () => ({
  writeWorkflowFile: mock(() => Promise.resolve()),
}));

mock.module('./workflow-paths', () => ({
  getTaskWorkflowDir: mock(() => '/tmp/workflow-dir'),
}));

mock.module('./transition-recorder', () => ({
  recordTransition: mock(() => Promise.resolve()),
}));

const resolveTaskSubtaskInfo = mock(() => Promise.resolve(null) as ReturnType<typeof mock>);
const resolveTaskWithThemeAndCategory = mock(
  () => Promise.resolve(null) as ReturnType<typeof mock>,
);
mock.module('../task/task-resolver', () => ({
  resolveTaskSubtaskInfo,
  resolveTaskWithThemeAndCategory,
}));

// Required-merge gate dependencies (task 895). This suite exercises the
// already-completed reconcile path, which returns before they are consulted;
// they are mocked only so the module graph does not reach the real DB config.
mock.module('./automation-policy', () => ({
  resolveAutomationPolicy: mock(() =>
    Promise.resolve({ autoCommit: true, autoCreatePR: true, autoMergePR: false }),
  ),
  resolveLandingMode: () => 'pr',
}));
mock.module('./verify-settle-artifact-recovery', () => ({
  isAwaitingRequiredMerge: mock(() => Promise.resolve(false)),
}));
mock.module('./required-merge-hold', () => ({
  holdForRequiredMerge: mock(() => Promise.resolve(true)),
  AWAITING_REQUIRED_MERGE_CAUSE: 'verify_awaiting_required_merge',
}));

const { onSubtaskCompleted } = await import('./subtask-completion-handler');

beforeEach(() => {
  taskUpdate.mockClear();
  taskFindMany.mockClear();
  sendTaskUpdate.mockClear();
  resolveTaskSubtaskInfo.mockClear();
  resolveTaskWithThemeAndCategory.mockClear();
});

describe('onSubtaskCompleted — workflowStatus完了済みだがstatusが未追従な場合の修復', () => {
  test('status を done に修復し、verify.md/PR の再実行はしないこと', async () => {
    resolveTaskSubtaskInfo.mockResolvedValueOnce({ parentId: 442 });
    taskFindMany.mockResolvedValueOnce([
      { id: 461, title: 'test', status: 'done', workflowStatus: null },
    ]);
    resolveTaskWithThemeAndCategory.mockResolvedValueOnce({
      id: 442,
      title: 'PR #320 の競合を解消',
      priority: 'high',
      themeId: 1,
      status: 'in-progress',
      workflowStatus: 'completed',
      completedAt: null,
    });

    await onSubtaskCompleted(461);

    expect(taskUpdate).toHaveBeenCalledWith({
      where: { id: 442 },
      data: { status: 'done', completedAt: expect.any(Date) },
    });
    expect(sendTaskUpdate).toHaveBeenCalledWith(
      442,
      'task_completed',
      expect.objectContaining({ taskId: 442, status: 'done' }),
    );
  });

  test('status が既に done なら何もしないこと', async () => {
    resolveTaskSubtaskInfo.mockResolvedValueOnce({ parentId: 442 });
    taskFindMany.mockResolvedValueOnce([
      { id: 461, title: 'test', status: 'done', workflowStatus: null },
    ]);
    resolveTaskWithThemeAndCategory.mockResolvedValueOnce({
      id: 442,
      title: 'PR #320 の競合を解消',
      priority: 'high',
      themeId: 1,
      status: 'done',
      workflowStatus: 'completed',
      completedAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    await onSubtaskCompleted(461);

    expect(taskUpdate).not.toHaveBeenCalled();
  });
});
