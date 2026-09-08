/**
 * workflow-reconciler-requeue — requeueOrphanTasks の必須マージ待ち保護 (task 895)
 *
 * PENDING_TIMEOUT_MS（AutoMergeWatcherの90分猶予）は STALE_TASK_MS（このオーファン
 * 回収の45分閾値）より長い。autoMergePR要求で verify_done/in-progress に保留中の
 * タスクをこの回収が todo へ戻すと、PRがまだCI/マージ待ちのまま新規実行が二重
 * dispatchされる（task 895 point 2）。この保護が効くこと、無関係な orphan は
 * 従来どおり回収されることの両方を検証する。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const mockPrisma = {
  task: {
    findMany: mock(() => Promise.resolve([] as unknown[])),
    update: mock(() => Promise.resolve({})),
  },
  agentExecution: { findFirst: mock(() => Promise.resolve(null as unknown)) },
  workflowQueueItem: { findFirst: mock(async (): Promise<{ id: number } | null> => null) },
  workflowTransition: { count: mock(() => Promise.resolve(0)) },
};
const recordTransition = mock(() => Promise.resolve());

const noopLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
mock.module('../../config/database', () => ({
  prisma: mockPrisma,
  ensureDatabaseConnection: () => Promise.resolve(),
}));
mock.module('../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
  getBackendLogFilePath: () => '/tmp/backend.log',
}));
mock.module('./transition-recorder', () => ({ recordTransition }));

let awaitingRequiredMerge = false;
mock.module('./verify-settle-artifact-recovery', () => ({
  isAwaitingRequiredMerge: () => Promise.resolve(awaitingRequiredMerge),
}));

const { requeueOrphanTasks } = await import('./workflow-reconciler-requeue');

const NOW = 1_800_000_000_000;

test('failed repair receipt cannot be bypassed by generic orphan recovery', async () => {
  mockPrisma.task.findMany.mockResolvedValueOnce([
    { id: 901, title: 'invalid repair receipt', workflowStatus: 'plan_approved' },
  ]);
  expect(await requeueOrphanTasks(NOW, new Set([901]))).toBe(0);
  expect(mockPrisma.task.update).not.toHaveBeenCalled();
});

beforeEach(() => {
  mockPrisma.task.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.task.update.mockReset().mockResolvedValue({});
  mockPrisma.agentExecution.findFirst.mockReset().mockResolvedValue(null);
  mockPrisma.workflowTransition.count.mockReset().mockResolvedValue(0);
  recordTransition.mockReset().mockResolvedValue(undefined);
  mockPrisma.workflowQueueItem.findFirst.mockReset().mockResolvedValue(null);
  awaitingRequiredMerge = false;
});

describe('requeueOrphanTasks — verify_done保留中タスクの保護', () => {
  test('autoMergePR要求で保留中(verify_done)のタスクは todo へ戻さない', async () => {
    awaitingRequiredMerge = true;
    mockPrisma.task.findMany.mockResolvedValueOnce([
      { id: 895, title: 'マージ待ち', workflowStatus: 'verify_done' },
    ]);

    const requeued = await requeueOrphanTasks(NOW);

    expect(requeued).toBe(0);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
    expect(recordTransition).not.toHaveBeenCalled();
    // isAwaitingRequiredMerge だけで判定でき、live実行の有無は問わない。
    expect(mockPrisma.agentExecution.findFirst).not.toHaveBeenCalled();
  });

  test('autoMergePR非要求の verify_done×in-progress は従来どおり回収する', async () => {
    mockPrisma.workflowQueueItem.findFirst.mockReset().mockResolvedValue(null);
    awaitingRequiredMerge = false;
    mockPrisma.task.findMany.mockResolvedValueOnce([
      { id: 900, title: '本来のオーファン', workflowStatus: 'verify_done' },
    ]);

    const requeued = await requeueOrphanTasks(NOW);

    expect(requeued).toBe(1);
    expect(mockPrisma.task.update).toHaveBeenCalledWith({
      where: { id: 900 },
      data: expect.objectContaining({ status: 'todo' }),
    });
  });

  test('自動化ポリシーの読み取りエラーは fail-closed で保護側に倒す', async () => {
    mock.module('./verify-settle-artifact-recovery', () => ({
      isAwaitingRequiredMerge: () => Promise.reject(new Error('db unavailable')),
    }));
    const { requeueOrphanTasks: requeueWithFailingPolicy } =
      await import('./workflow-reconciler-requeue');
    mockPrisma.task.findMany.mockResolvedValueOnce([
      { id: 901, title: '読み取り失敗', workflowStatus: 'verify_done' },
    ]);

    const requeued = await requeueWithFailingPolicy(NOW);

    expect(requeued).toBe(0);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });

  test('workflowStatus が verify_done 以外なら isAwaitingRequiredMerge を呼ばず従来どおり判定する', async () => {
    mockPrisma.task.findMany.mockResolvedValueOnce([
      { id: 902, title: '計画中に停止', workflowStatus: 'plan_created' },
    ]);

    const requeued = await requeueOrphanTasks(NOW);

    expect(requeued).toBe(1);
  });
});

test('a delivered repair queue item prevents orphan reset', async () => {
  mockPrisma.task.findMany.mockResolvedValue([
    { id: 1, title: 'repair', workflowStatus: 'plan_approved' },
  ]);
  mockPrisma.workflowQueueItem.findFirst.mockResolvedValue({ id: 10 });
  expect(await requeueOrphanTasks(NOW)).toBe(0);
  expect(mockPrisma.task.update).not.toHaveBeenCalled();
});

test('unreadable live execution never authorizes orphan reset', async () => {
  mockPrisma.task.findMany.mockResolvedValue([
    { id: 1, title: 'repair', workflowStatus: 'plan_approved' },
  ]);
  mockPrisma.agentExecution.findFirst.mockRejectedValueOnce(
    new Error('execution lookup unavailable'),
  );
  await expect(requeueOrphanTasks(NOW)).rejects.toThrow('execution lookup unavailable');
  expect(mockPrisma.task.update).not.toHaveBeenCalled();
  expect(recordTransition).not.toHaveBeenCalled();
});
test('unreadable retry count never resets the orphan budget', async () => {
  mockPrisma.task.findMany.mockResolvedValue([
    { id: 1, title: 'repair', workflowStatus: 'plan_approved' },
  ]);
  mockPrisma.workflowTransition.count.mockRejectedValueOnce(new Error('budget lookup unavailable'));
  await expect(requeueOrphanTasks(NOW)).rejects.toThrow('budget lookup unavailable');
  expect(mockPrisma.task.update).not.toHaveBeenCalled();
});
test('failed orphan update is not counted or audited as a successful recovery', async () => {
  mockPrisma.task.findMany.mockResolvedValue([
    { id: 1, title: 'repair', workflowStatus: 'plan_approved' },
  ]);
  mockPrisma.task.update.mockRejectedValueOnce(new Error('state update unavailable'));
  await expect(requeueOrphanTasks(NOW)).rejects.toThrow('state update unavailable');
  expect(recordTransition).not.toHaveBeenCalled();
});
