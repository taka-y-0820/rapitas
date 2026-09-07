/**
 * workflow-phase-session テスト
 *
 * フェーズセッションの終端化が「停止済み状態を上書きしない」条件付き書き込みで
 * あることを検証する。Own file — mock.module is process-global.
 */
import { beforeEach, expect, mock, test } from 'bun:test';

const updateMany = mock(async (_args: unknown) => ({ count: 1 }));
mock.module('../../config', () => ({ prisma: { agentSession: { updateMany } } }));
mock.module('../../config/logger', () => ({
  createLogger: () => ({ warn: () => {} }),
}));
const { finalizePhaseSession } = await import('./workflow-phase-session');

beforeEach(() => updateMany.mockClear());

test('completion is a conditional write requiring only completed executions and an active session', async () => {
  expect(await finalizePhaseSession(42, true)).toBe(true);
  expect(updateMany).toHaveBeenCalledWith({
    where: {
      id: 42,
      status: { in: ['active', 'running'] },
      agentExecutions: { some: {}, every: { status: { in: ['completed'] } } },
    },
    data: {
      status: 'completed',
      completedAt: expect.any(Date),
      lastActivityAt: expect.any(Date),
    },
  });
});

test('rejected output records a failed session even when the CLI succeeded', async () => {
  await finalizePhaseSession(42, false);
  expect(updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        agentExecutions: { some: {}, every: { status: { in: ['completed', 'failed'] } } },
      }),
      data: expect.objectContaining({ status: 'failed' }),
    }),
  );
});

test('a lost conditional write never retries by overwriting a stopped session', async () => {
  updateMany.mockImplementationOnce(async () => ({ count: 0 }));
  expect(await finalizePhaseSession(42, true)).toBe(false);
  expect(updateMany).toHaveBeenCalledTimes(1);
});

test('database failure does not turn the phase result into a fabricated success', async () => {
  updateMany.mockImplementationOnce(async () => {
    throw new Error('offline');
  });
  await finalizePhaseSession(42, true);
  expect(updateMany).toHaveBeenCalledTimes(1);
});

// 停止済み(cancelled/interrupted)セッションを上書きしないことを、実DBの
// updateMany セマンティクス(where 不一致は 0 件更新)を再現して確認する。
test('cancelled / interrupted sessions are left untouched by the conditional where', async () => {
  const stored = { id: 42, status: 'cancelled' as string };
  updateMany.mockImplementationOnce(async (args: unknown) => {
    const { where } = args as { where: { status: { in: string[] } } };
    if (!where.status.in.includes(stored.status)) return { count: 0 };
    stored.status = 'completed';
    return { count: 1 };
  });

  await finalizePhaseSession(42, true);

  expect(stored.status).toBe('cancelled');
});
