/**
 * durable-blocked-write テスト
 *
 * writeBlockedStatusDurable が「status=blocked の書き込み失敗を握りつぶさない」ことを検証する。
 * 失敗を `.catch(() => {})` で握りつぶすと、ループを止めるはずの終端書き込みが
 * 実際には行われないまま次のポーリングで再度ループに入ってしまう
 * （plan-replan / CI-repair バウンス等で過去に複数日スピンした実障害の再発防止）。
 * 1回目失敗→リトライ成功、両方失敗→Notification発火、の各経路を確認する。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const updateMock = mock(() => Promise.resolve({}));
const previousRevision = new Date(Date.now() + 60_000);
const findUniqueMock = mock(() => Promise.resolve({ updatedAt: previousRevision }));
const mockPrisma = {
  task: {
    update: updateMock,
    findUnique: findUniqueMock,
  },
};

mock.module('../../config/database', () => ({
  prisma: mockPrisma,
}));

const createNotificationMock = mock(() => Promise.resolve({}));
mock.module('../communication/notification-service', () => ({
  createNotification: createNotificationMock,
}));

const { writeBlockedStatusDurable } = await import('./durable-blocked-write');

function noopLog() {
  return { warn: mock(() => {}), error: mock(() => {}) };
}

describe('writeBlockedStatusDurable', () => {
  beforeEach(() => {
    findUniqueMock.mockReset().mockResolvedValue({ updatedAt: previousRevision });
    updateMock.mockClear();
    updateMock.mockReset();
    createNotificationMock.mockClear();
    createNotificationMock.mockReset();
    createNotificationMock.mockResolvedValue({});
  });

  test('1回目の書き込みが成功すれば true を返し、リトライもしないこと', async () => {
    updateMock.mockResolvedValueOnce({});

    const log = noopLog();
    const result = await writeBlockedStatusDurable({
      taskId: 1,
      log,
      source: 'TestCaller',
      notification: { title: 't', message: 'm' },
    });

    expect(result).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  test('1回目失敗・2回目成功なら true を返し、Notificationは発火しないこと', async () => {
    updateMock.mockRejectedValueOnce(new Error('db error')).mockResolvedValueOnce({});

    const log = noopLog();
    const result = await writeBlockedStatusDurable({
      taskId: 2,
      log,
      source: 'TestCaller',
      notification: { title: 't', message: 'm' },
    });

    expect(result).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(createNotificationMock).not.toHaveBeenCalled();
  });

  test('2回とも失敗なら false を返し、errorログとNotificationが発火すること', async () => {
    updateMock
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'));

    const log = noopLog();
    const result = await writeBlockedStatusDurable({
      taskId: 3,
      log,
      source: 'WorkflowOrchestrator',
      notification: { title: 'ブロック処理の書き込みに失敗', message: 'タスク #3 が2回失敗' },
    });

    expect(result).toBe(false);
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledTimes(1);

    // Notification is fired via a fire-and-forget dynamic import — flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createNotificationMock).toHaveBeenCalledTimes(1);
    const [params] = createNotificationMock.mock.calls[0] as [Record<string, unknown>];
    expect(params).toMatchObject({
      type: 'system',
      title: 'ブロック処理の書き込みに失敗',
      link: '/tasks?taskId=3',
      metadata: { taskId: 3, reason: 'block_write_failed', source: 'WorkflowOrchestrator' },
    });
  });

  test('taskId が where 句に正しく渡ること', async () => {
    updateMock.mockResolvedValueOnce({});

    await writeBlockedStatusDurable({
      taskId: 999,
      log: noopLog(),
      source: 'TestCaller',
      notification: { title: 't', message: 'm' },
    });

    const [callArgs] = updateMock.mock.calls[0] as [
      { where: { id: number }; data: { status: string } },
    ];
    expect(callArgs.where).toEqual({ id: 999, updatedAt: previousRevision });
    expect((callArgs.data as { updatedAt: Date }).updatedAt.getTime()).toBe(
      previousRevision.getTime() + 1,
    );
    expect(callArgs.data.status).toBe('blocked');
  });
});
