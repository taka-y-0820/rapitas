/**
 * stop-task-agents テスト
 *
 * 停止時にタスクの「全」実行中エージェントを、worker とメインプロセス両方の
 * オーケストレータへ停止要求して止め、ロックを解放することを検証する。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const workerStopMock = mock((_id: number) => Promise.resolve(true));
const mainStopMock = mock((_id: number) => Promise.resolve(true));
// stopThemeAgents also sweeps in-memory executions via AgentOrchestrator.stopAllForTasks
// (agent-orchestrator.ts:366) before the DB-based sweep; mocked as a no-op empty sweep
// since these tests exercise the DB-based path via mainStopMock/workerStopMock.
const stopAllForTasksMock = mock((_taskIds: Set<number>) => Promise.resolve([] as number[]));
const recordIntent = mock(async (_db: unknown, _theme: number, _ids: number[]) => 'request');
const pendingTargets = mock(async () => [] as number[]);
mock.module('./theme-stop-intent', () => ({
  recordThemeStopIntent: recordIntent,
  readPendingThemeStopTargets: pendingTargets,
}));

const mockPrisma = {
  agentSession: { updateMany: mock(async () => ({ count: 1 })) },
  workflowQueueItem: { updateMany: mock(() => Promise.resolve({ count: 0 })) },
  agentExecution: {
    findMany: mock(() => Promise.resolve([] as { id?: number; sessionId?: number }[])),
    update: mock(() => Promise.resolve({})),
  },
  agentExecutionLog: {
    deleteMany: mock(() => Promise.resolve({ count: 0 })),
  },
  task: {
    findMany: mock(() => Promise.resolve([] as { id: number }[])),
  },
};

mock.module('../../config/database', () => ({
  ensureDatabaseConnection: () => Promise.resolve(),
  prisma: mockPrisma,
}));
mock.module('../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }),
}));
mock.module('./agent-worker-manager', () => ({
  AgentWorkerManager: {
    getInstance: () => ({ stopExecution: workerStopMock }),
  },
}));
mock.module('./agent-orchestrator', () => ({
  AgentOrchestrator: {
    getInstance: () => ({ stopExecution: mainStopMock, stopAllForTasks: stopAllForTasksMock }),
  },
}));

const { stopTaskAgents, stopThemeAgents, stopTaskTreeAgents } = await import('./stop-task-agents');
const { acquireTaskExecutionLock, isTaskExecutionLocked } = await import('./task-execution-lock');

function resetMocks() {
  mockPrisma.agentSession.updateMany.mockReset().mockResolvedValue({ count: 1 });
  recordIntent.mockReset().mockResolvedValue('request');
  pendingTargets.mockReset().mockResolvedValue([]);
  workerStopMock.mockClear();
  mainStopMock.mockClear();
  stopAllForTasksMock.mockReset().mockResolvedValue([]);
  mockPrisma.agentExecution.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.agentExecution.update.mockReset();
  mockPrisma.agentExecutionLog.deleteMany.mockReset();
  mockPrisma.task.findMany.mockReset();
  mockPrisma.agentExecution.update.mockResolvedValue({});
  mockPrisma.agentExecutionLog.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.task.findMany.mockResolvedValue([]);
}

describe('stopTaskAgents', () => {
  beforeEach(resetMocks);

  test('session persistence failure cannot report a successful stop', async () => {
    mockPrisma.agentExecution.findMany.mockResolvedValue([{ id: 11, sessionId: 7 }]);
    mockPrisma.agentSession.updateMany.mockRejectedValueOnce(new Error('session unavailable'));
    acquireTaskExecutionLock(5011);
    await expect(stopTaskAgents(5011)).rejects.toThrow('could not be persisted');
    expect(isTaskExecutionLocked(5011)).toBe(false);
    expect(mainStopMock).toHaveBeenCalledWith(11);
  });

  test('persistence failure still attempts every process stop and releases the task lock', async () => {
    mockPrisma.agentExecution.findMany.mockResolvedValue([{ id: 11 }, { id: 22 }]);
    mockPrisma.agentExecution.update.mockRejectedValueOnce(new Error('DB unavailable'));
    acquireTaskExecutionLock(5010);
    await expect(stopTaskAgents(5010)).rejects.toThrow('could not be persisted');
    expect(workerStopMock).toHaveBeenCalledTimes(2);
    expect(mainStopMock).toHaveBeenCalledTimes(2);
    expect(isTaskExecutionLocked(5010)).toBe(false);
  });

  test('実行中の全エージェントを停止する（1つだけでなく）', async () => {
    mockPrisma.agentExecution.findMany.mockResolvedValue([{ id: 11 }, { id: 22 }, { id: 33 }]);

    const result = await stopTaskAgents(5001, { errorMessage: 'Cancelled by user' });

    expect(result.stoppedCount).toBe(3);
    expect(result.executionIds).toEqual([11, 22, 33]);
    // Every execution is asked to BOTH orchestrators (worker + main process).
    expect(workerStopMock).toHaveBeenCalledTimes(3);
    expect(mainStopMock).toHaveBeenCalledTimes(3);
    expect(mockPrisma.agentExecution.update).toHaveBeenCalledTimes(6);
    expect(mockPrisma.agentExecution.update.mock.calls.map(([args]) => args.data.status)).toEqual([
      'canceling',
      'cancelled',
      'canceling',
      'cancelled',
      'canceling',
      'cancelled',
    ]);
    expect(mockPrisma.agentExecutionLog.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.agentExecution.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: {
        status: 'cancelled',
        completedAt: expect.any(Date),
        errorMessage: 'Cancelled by user',
      },
    });
  });

  test('停止後にタスク実行ロックを解放する', async () => {
    mockPrisma.agentExecution.findMany.mockResolvedValue([{ id: 1 }]);
    acquireTaskExecutionLock(5002);
    expect(isTaskExecutionLocked(5002)).toBe(true);

    await stopTaskAgents(5002);

    expect(isTaskExecutionLocked(5002)).toBe(false);
  });

  test('実行が無くてもロックを解放し 0 を返す', async () => {
    mockPrisma.agentExecution.findMany.mockResolvedValue([]);
    acquireTaskExecutionLock(5003);

    const result = await stopTaskAgents(5003);

    expect(result.stoppedCount).toBe(0);
    expect(workerStopMock).not.toHaveBeenCalled();
    expect(mainStopMock).not.toHaveBeenCalled();
    expect(isTaskExecutionLocked(5003)).toBe(false);
  });
});

describe('stopThemeAgents', () => {
  beforeEach(resetMocks);

  test('retry repairs cancelled targets sessions without cancelling a newer active execution', async () => {
    pendingTargets.mockResolvedValue([91]);
    mockPrisma.task.findMany.mockResolvedValue([{ id: 200 }]);
    // Two active queries return empty; the third query resolves prior cancelled targets.
    mockPrisma.task.findMany.mockResolvedValueOnce([{ id: 200 }]).mockResolvedValue([]);
    mockPrisma.agentExecution.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 91, sessionId: 7 }]);
    expect(await stopThemeAgents(42, null)).toEqual({ stoppedCount: 1, executionIds: [91] });
    expect(mockPrisma.agentSession.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: [7] },
        status: { in: ['active', 'running', 'failed'] },
        agentExecutions: {
          none: {
            OR: [
              { status: { in: ['running', 'pending', 'waiting_for_input'] } },
              { id: { gt: 91 }, status: { notIn: ['cancelled', 'canceled'] } },
            ],
          },
        },
      },
      data: { status: 'cancelled' },
    });
    expect(mainStopMock).toHaveBeenCalledWith(91);
  });

  test('includes grandchildren without repeating cyclic task references', async () => {
    mockPrisma.task.findMany
      .mockResolvedValueOnce([{ id: 200 }])
      .mockResolvedValueOnce([{ id: 300 }])
      .mockResolvedValueOnce([{ id: 400 }])
      .mockResolvedValueOnce([{ id: 200 }]);
    mockPrisma.agentExecution.findMany.mockResolvedValue([]);
    await stopThemeAgents(42, null);
    expect(stopAllForTasksMock).toHaveBeenCalledWith(new Set([200, 300, 400]));
    expect(mockPrisma.task.findMany).toHaveBeenCalledTimes(4);
  });

  test('recovers prior stopped targets when no active execution remains', async () => {
    pendingTargets.mockResolvedValueOnce([91, 92]);
    mockPrisma.agentExecution.findMany.mockResolvedValue([]);
    expect(await stopThemeAgents(42, null)).toEqual({ stoppedCount: 2, executionIds: [91, 92] });
    expect(recordIntent).not.toHaveBeenCalled();
  });

  test('intent persistence failure still stops agents and then reports failure', async () => {
    mockPrisma.agentExecution.findMany.mockResolvedValue([{ id: 91 }]);
    recordIntent.mockRejectedValueOnce(new Error('intent database unavailable'));
    await expect(stopThemeAgents(42, 200)).rejects.toThrow('intent database unavailable');
    expect(stopAllForTasksMock).toHaveBeenCalled();
    expect(workerStopMock).toHaveBeenCalledWith(91);
    expect(mainStopMock).toHaveBeenCalledWith(91);
  });

  test('reports executions stopped by the memory sweep even after their DB status became cancelled', async () => {
    mockPrisma.task.findMany.mockResolvedValueOnce([{ id: 200 }]);
    stopAllForTasksMock.mockResolvedValueOnce([91, 92]);
    mockPrisma.agentExecution.findMany.mockResolvedValue([]);
    expect(await stopThemeAgents(42, null)).toEqual({ stoppedCount: 2, executionIds: [91, 92] });
  });

  test('deduplicates executions observed by both stop sweeps', async () => {
    stopAllForTasksMock.mockResolvedValueOnce([91]);
    mockPrisma.agentExecution.findMany.mockResolvedValue([{ id: 91 }, { id: 92 }]);
    expect(await stopThemeAgents(42, 200)).toEqual({ stoppedCount: 2, executionIds: [91, 92] });
  });

  test('現在タスク・サブタスク・テーマ内タスクの全エージェントを停止する', async () => {
    // 1st task.findMany → theme top-level tasks; 2nd → their subtasks.
    mockPrisma.task.findMany
      .mockResolvedValueOnce([{ id: 200 }, { id: 201 }]) // theme tasks
      .mockResolvedValueOnce([{ id: 300 }]); // subtasks
    mockPrisma.agentExecution.findMany.mockResolvedValue([{ id: 91 }, { id: 92 }]);

    const result = await stopThemeAgents(42, 200, { errorMessage: 'Auto-run stopped' });

    expect(result.stoppedCount).toBe(2);
    expect(workerStopMock).toHaveBeenCalledTimes(2);
    expect(mainStopMock).toHaveBeenCalledTimes(2);
    // The execution query must include the current task, theme tasks, and subtasks.
    const where = mockPrisma.agentExecution.findMany.mock.calls[0][0].where;
    const queriedIds = where.session.config.taskId.in as number[];
    expect(queriedIds).toEqual(expect.arrayContaining([200, 201, 300]));
  });

  test('currentTaskId が null でもテーマ内タスクを掃く', async () => {
    mockPrisma.task.findMany.mockResolvedValueOnce([{ id: 200 }]).mockResolvedValueOnce([]);
    mockPrisma.agentExecution.findMany.mockResolvedValue([]);

    const result = await stopThemeAgents(42, null);

    expect(result.stoppedCount).toBe(0);
    expect(mockPrisma.task.findMany).toHaveBeenCalled();
  });
});

test('timeout scopes queue and agent cancellation to the complete descendant tree', async () => {
  resetMocks();
  mockPrisma.task.findMany
    .mockResolvedValueOnce([{ id: 2 }])
    .mockResolvedValueOnce([{ id: 3 }])
    .mockResolvedValueOnce([]);
  mockPrisma.agentExecution.findMany.mockResolvedValue([]);
  await stopTaskTreeAgents(1);
  expect(stopAllForTasksMock).toHaveBeenCalledWith(new Set([1, 2, 3]));
  expect(mockPrisma.workflowQueueItem.updateMany).toHaveBeenCalledWith({
    where: { taskId: { in: [1, 2, 3] }, status: { in: ['queued', 'running', 'waiting_approval'] } },
    data: { status: 'cancelled', completedAt: expect.any(Date), errorMessage: 'Task timed out' },
  });
  expect(mockPrisma.task.findMany).toHaveBeenCalledWith({
    where: { parentId: { in: [3] } },
    select: { id: true },
  });
  expect(mockPrisma.agentExecutionLog.deleteMany).not.toHaveBeenCalled();
});

test('known stop targets are persisted even if the memory sweep left them failed', async () => {
  resetMocks();
  mockPrisma.task.findMany.mockResolvedValueOnce([{ id: 200 }]);
  mockPrisma.agentExecution.findMany.mockResolvedValueOnce([{ id: 91 }]).mockResolvedValue([]);
  stopAllForTasksMock.mockResolvedValueOnce([91]);
  await stopThemeAgents(42, null);
  expect(mockPrisma.agentExecution.update).toHaveBeenCalledWith({
    where: { id: 91 },
    data: { status: 'cancelled', completedAt: expect.any(Date), errorMessage: 'Auto-run stopped' },
  });
});

test('timeout settles memory-owned execution after its status leaves the active query', async () => {
  resetMocks();
  stopAllForTasksMock.mockResolvedValueOnce([91]);
  await stopTaskTreeAgents(1);
  expect(mainStopMock).toHaveBeenCalledWith(91);
  expect(mockPrisma.agentExecution.update).toHaveBeenCalledWith({
    where: { id: 91 },
    data: { status: 'cancelled', completedAt: expect.any(Date), errorMessage: 'Task timed out' },
  });
});
