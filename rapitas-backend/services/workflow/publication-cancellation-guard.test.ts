/**
 * publication-cancellation-guard ユニットテスト (task 895)
 *
 * 停止意図は AgentExecution.status='cancelled' として永続化される。最新実行
 * のみを見ることで「一度停止したが正当に再実行されたタスク」を恒久ブロック
 * しないこと、DBエラー時は不可逆処理を許可せず差し止める(fail closed)ことを
 * 検証する。
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

const findFirst = mock(() => Promise.resolve(null) as ReturnType<typeof mock>);
mock.module('../../config/database', () => ({
  prisma: { agentExecution: { findFirst } },
}));

const { isLatestExecutionCancelled, publicationAborted } =
  await import('./publication-cancellation-guard');

beforeEach(() => {
  findFirst.mockClear();
});

describe('isLatestExecutionCancelled', () => {
  test('最新実行が cancelled なら true', async () => {
    findFirst.mockResolvedValueOnce({ id: 10, status: 'cancelled' });
    expect(await isLatestExecutionCancelled(895)).toBe(true);
  });

  test('最新実行を createdAt 降順で1件だけ、タスク配下に絞って取得する', async () => {
    findFirst.mockResolvedValueOnce({ id: 10, status: 'cancelled' });
    await isLatestExecutionCancelled(895);
    expect(findFirst).toHaveBeenCalledWith({
      where: { session: { config: { taskId: 895 } } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });
  });

  test('最新実行が running / completed なら false', async () => {
    findFirst.mockResolvedValueOnce({ id: 11, status: 'running' });
    expect(await isLatestExecutionCancelled(895)).toBe(false);
    findFirst.mockResolvedValueOnce({ id: 12, status: 'completed' });
    expect(await isLatestExecutionCancelled(895)).toBe(false);
  });

  test('過去に cancelled があっても最新が completed ならブロックしない（正当な再実行）', async () => {
    // findFirst は降順1件なので、最新 = completed が返る想定。
    findFirst.mockResolvedValueOnce({ id: 20, status: 'completed' });
    expect(await isLatestExecutionCancelled(895)).toBe(false);
  });

  test('実行が1件も無ければ false', async () => {
    findFirst.mockResolvedValueOnce(null);
    expect(await isLatestExecutionCancelled(895)).toBe(false);
  });

  test('DBエラー時は停止記録を読めないため fail closed で true（公開を差し止める）', async () => {
    findFirst.mockRejectedValueOnce(new Error('db unavailable'));
    expect(await isLatestExecutionCancelled(895)).toBe(true);
  });
});

describe('publicationAborted', () => {
  test('停止済みなら true を返して以降のステップを止める', async () => {
    findFirst.mockResolvedValueOnce({ id: 10, status: 'cancelled' });
    expect(await publicationAborted(895, 'before_commit')).toBe(true);
  });

  test('停止されていなければ false', async () => {
    findFirst.mockResolvedValueOnce({ id: 10, status: 'running' });
    expect(await publicationAborted(895, 'before_commit')).toBe(false);
  });
});
