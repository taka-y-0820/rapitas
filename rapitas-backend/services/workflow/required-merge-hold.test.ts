/**
 * required-merge-hold ユニットテスト (task 895)
 *
 * 保留書き込みが AutoMergeWatcher の候補条件（status=in-progress かつ
 * workflowStatus=verify_done）と一致すること、既に完了/キャンセル済みの
 * タスクを条件付き更新で復活させないことを検証する。
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

const updateMany = mock(() => Promise.resolve({ count: 1 }) as ReturnType<typeof mock>);
mock.module('../../config/database', () => ({
  prisma: { task: { updateMany } },
}));

const recordTransition = mock(() => Promise.resolve());
mock.module('./transition-recorder', () => ({ recordTransition }));

const { holdForRequiredMerge, AWAITING_REQUIRED_MERGE_CAUSE } =
  await import('./required-merge-hold');

beforeEach(() => {
  updateMany.mockClear();
  recordTransition.mockClear();
  updateMany.mockResolvedValue({ count: 1 });
});

describe('holdForRequiredMerge', () => {
  test('watcher の候補条件に一致する状態を書き込む', async () => {
    const held = await holdForRequiredMerge({
      taskId: 895,
      fromStatus: 'verify_done',
      source: 'test',
    });

    expect(held).toBe(true);
    const arg = updateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(arg.data).toMatchObject({ status: 'in-progress', workflowStatus: 'verify_done' });
    expect(arg.data).not.toHaveProperty('completedAt');
  });

  test('観測したワークフロー状態と非終端ステータスに対してのみ条件付き更新する', async () => {
    await holdForRequiredMerge({ taskId: 895, fromStatus: 'verify_done', source: 'test' });

    const where = (updateMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    // CAS: 観測時から workflowStatus が動いていたら書かない（新しいフェーズを踏まない）。
    expect(where).toMatchObject({ id: 895, workflowStatus: 'verify_done' });
    // done/failed/cancelled/blocked を保留状態へ復活させない。
    expect(where.status).toEqual({ in: ['todo', 'in-progress', 'in_progress'] });
  });

  test('保留した場合のみ verify_awaiting_required_merge を記録する', async () => {
    await holdForRequiredMerge({ taskId: 895, fromStatus: 'verify_done', source: 'test' });

    expect(recordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 895,
        toStatus: 'verify_done',
        cause: AWAITING_REQUIRED_MERGE_CAUSE,
        phase: 'verify',
      }),
    );
  });

  test('CASに負けた場合は false を返し、遷移を記録しない', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });

    const held = await holdForRequiredMerge({
      taskId: 895,
      fromStatus: 'verify_done',
      source: 'test',
    });

    expect(held).toBe(false);
    expect(recordTransition).not.toHaveBeenCalled();
  });

  test('DBエラー時も false を返し、遷移を記録しない', async () => {
    updateMany.mockRejectedValueOnce(new Error('db unavailable'));

    const held = await holdForRequiredMerge({
      taskId: 895,
      fromStatus: 'verify_done',
      source: 'test',
    });

    expect(held).toBe(false);
    expect(recordTransition).not.toHaveBeenCalled();
  });
});
