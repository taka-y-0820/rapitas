/**
 * subtask-completion-handler — 親確定と必須マージの順序 (task 895)
 *
 * 親が autoMergePR を要求している場合、全サブタスク合格時に
 * (1) performAutoCommitAndPR を完了書き込みより先に実行し、
 * (2) PR が存在する間は done/completed にせず verify_done で保留し、
 * (3) task_completed を誤って broadcast しないことを検証する。
 * merge 以外の landing mode では従来の順序・挙動が変わらないことも確認する。
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

/** Ordered log of the side effects under test, so ordering can be asserted. */
const calls: string[] = [];

const taskUpdate = mock(() => {
  calls.push('task.update');
  return Promise.resolve({});
});
const taskFindMany = mock(() => Promise.resolve([]) as ReturnType<typeof mock>);
mock.module('../../config/database', () => ({
  prisma: { task: { findMany: taskFindMany, update: taskUpdate } },
}));

const broadcast = mock((_channel: string, event: string) => {
  calls.push('broadcast:' + event);
});
mock.module('../communication/realtime-service', () => ({
  realtimeService: { sendTaskUpdate: mock(() => {}), broadcast },
  RealtimeService: class {},
}));

mock.module('./workflow-file-utils', () => ({
  writeWorkflowFile: mock(() => Promise.resolve()),
}));
mock.module('./workflow-paths', () => ({
  getTaskWorkflowDir: mock(() => '/tmp/workflow-dir'),
}));

const recordTransition = mock(() => {
  calls.push('recordTransition');
  return Promise.resolve();
});
mock.module('./transition-recorder', () => ({ recordTransition }));

const resolveTaskSubtaskInfo = mock(() => Promise.resolve(null) as ReturnType<typeof mock>);
const resolveTaskWithThemeAndCategory = mock(
  () => Promise.resolve(null) as ReturnType<typeof mock>,
);
mock.module('../task/task-resolver', () => ({
  resolveTaskSubtaskInfo,
  resolveTaskWithThemeAndCategory,
}));

let landingMode: 'merge' | 'pr' = 'merge';
mock.module('./automation-policy', () => ({
  resolveAutomationPolicy: () =>
    Promise.resolve({
      autoCommit: true,
      autoCreatePR: true,
      autoMergePR: landingMode === 'merge',
    }),
  resolveLandingMode: () => landingMode,
}));

let awaitingRequiredMerge = true;
mock.module('./verify-settle-artifact-recovery', () => ({
  isAwaitingRequiredMerge: () => Promise.resolve(awaitingRequiredMerge),
}));

const holdForRequiredMerge = mock(() => {
  calls.push('hold');
  return Promise.resolve(true);
});
mock.module('./required-merge-hold', () => ({
  holdForRequiredMerge,
  AWAITING_REQUIRED_MERGE_CAUSE: 'verify_awaiting_required_merge',
}));

const performAutoCommitAndPR = mock(() => {
  calls.push('performAutoCommitAndPR');
  return Promise.resolve({});
});
mock.module('../../routes/workflow/workflow-auto-commit', () => ({ performAutoCommitAndPR }));

const { onSubtaskCompleted } = await import('./subtask-completion-handler');

/** Arrange one parent (#900) whose single subtask (#901) just passed. */
function arrangeAllPassed(): void {
  resolveTaskSubtaskInfo.mockResolvedValueOnce({ parentId: 900 });
  taskFindMany.mockResolvedValueOnce([
    { id: 901, title: 'サブタスクA', status: 'done', workflowStatus: 'completed' },
  ]);
  resolveTaskWithThemeAndCategory.mockResolvedValueOnce({
    id: 900,
    title: '親タスク',
    priority: 'high',
    themeId: 1,
    status: 'in-progress',
    workflowStatus: 'verify_done',
    completedAt: null,
  });
}

beforeEach(() => {
  calls.length = 0;
  taskUpdate.mockClear();
  taskFindMany.mockClear();
  broadcast.mockClear();
  recordTransition.mockClear();
  holdForRequiredMerge.mockClear();
  performAutoCommitAndPR.mockClear();
  resolveTaskSubtaskInfo.mockClear();
  resolveTaskWithThemeAndCategory.mockClear();
  landingMode = 'merge';
  awaitingRequiredMerge = true;
});

describe('onSubtaskCompleted — 親が autoMergePR を要求している場合', () => {
  test('PR作成を完了書き込みより先に実行し、完了させず保留する', async () => {
    arrangeAllPassed();

    await onSubtaskCompleted(901);

    expect(calls[0]).toBe('performAutoCommitAndPR');
    expect(calls).toContain('hold');
    expect(taskUpdate).not.toHaveBeenCalled();
    expect(recordTransition).not.toHaveBeenCalled();
  });

  test('task_completed を broadcast せず task_updated のみ送る', async () => {
    arrangeAllPassed();

    await onSubtaskCompleted(901);

    const events = broadcast.mock.calls.map((c) => c[1]);
    expect(events).toEqual(['task_updated']);
  });

  test('PRが無く保留対象でない場合は、PR実行後に従来どおり完了させる', async () => {
    awaitingRequiredMerge = false;
    arrangeAllPassed();

    await onSubtaskCompleted(901);

    expect(calls[0]).toBe('performAutoCommitAndPR');
    expect(taskUpdate).toHaveBeenCalledWith({
      where: { id: 900 },
      data: expect.objectContaining({ status: 'done', workflowStatus: 'completed' }),
    });
    expect(broadcast.mock.calls.map((c) => c[1])).toEqual(['task_completed']);
  });
});

describe('onSubtaskCompleted — merge 以外の landing mode は従来の順序を維持する', () => {
  test('pr モードでは完了書き込みが先、performAutoCommitAndPR が後', async () => {
    landingMode = 'pr';
    awaitingRequiredMerge = false;
    arrangeAllPassed();

    await onSubtaskCompleted(901);

    expect(calls.indexOf('task.update')).toBeLessThan(calls.indexOf('performAutoCommitAndPR'));
    expect(holdForRequiredMerge).not.toHaveBeenCalled();
    expect(taskUpdate).toHaveBeenCalledWith({
      where: { id: 900 },
      data: expect.objectContaining({ status: 'done', workflowStatus: 'completed' }),
    });
    expect(broadcast.mock.calls.map((c) => c[1])).toEqual(['task_completed']);
  });
});
