/**
 * execution-persistence ユニットテスト（イベント／エラー系）
 *
 * emitResultEvent のイベント整形と handleExecutionError のエラー正規化を検証する。
 * DB書き込み・自己学習レコーダー連携の検証は execution-persistence.test.ts 側。
 * どちらの関数も自己学習レコーダーを呼ばないため mock.module は不要。
 */
import { describe, test, expect, mock } from 'bun:test';
import { emitResultEvent, handleExecutionError } from './execution-persistence';
import type { ExecutionState, OrchestratorEvent } from './types';
import { ExecutionCancelledError } from '../execution-cancelled-error';

// ── ヘルパー ──────────────────────────────────────────────────────────────────

/** テスト用の最小 ExecutionState を生成する。 */
function makeState(overrides: Partial<ExecutionState> = {}): ExecutionState {
  return {
    executionId: 1,
    sessionId: 2,
    agentId: 'agent-1',
    taskId: 3,
    status: 'running',
    startedAt: new Date(),
    output: '',
    ...overrides,
  };
}

/** テスト用の fileLogger スタブ（すべてスパイ）を生成する。 */
function makeFileLogger() {
  return {
    logStatusChange: mock(() => {}),
    logExecutionEnd: mock(() => {}),
    logGitCommit: mock(() => {}),
    logError: mock(() => {}),
    logWarn: mock(() => {}),
    logInfo: mock(() => {}),
    flush: mock(async () => {}),
  } as unknown as import('../execution-file-logger').ExecutionFileLogger;
}

/** テスト用の Prisma スタブを生成する。 */
function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    agentExecution: {
      updateMany: mock(async () => ({ count: 1 })),
      findUnique: mock(async () => ({ startedAt: null, executionTimeMs: null })),
    },
    ...overrides,
  };
}

// ── emitResultEvent() ─────────────────────────────────────────────────────────

test('revoked execution admission is persisted and emitted as cancellation', async () => {
  const prisma = makePrisma();
  const state = makeState();
  const logger = makeFileLogger();
  const emit = mock((_event: OrchestratorEvent) => {});
  await handleExecutionError(
    prisma as never,
    1,
    2,
    3,
    state,
    new ExecutionCancelledError('ownership revoked'),
    logger,
    emit,
    'Execution',
  );
  expect(state.status).toBe('cancelled');
  expect(prisma.agentExecution.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ status: 'cancelled' }),
    }),
  );
  expect(logger.logError).not.toHaveBeenCalled();
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'execution_cancelled' }));
});

describe('emitResultEvent()', () => {
  test('waitingForInput=true → execution_output イベントを質問情報付きで発火する', () => {
    const emitEvent = mock((_e: OrchestratorEvent) => {});

    emitResultEvent(
      {
        success: false,
        waitingForInput: true,
        output: 'partial',
        question: '続けますか？',
        questionType: 'confirm',
        questionDetails: { foo: 'bar' },
      },
      1,
      2,
      3,
      emitEvent,
    );

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'execution_output',
        executionId: 1,
        sessionId: 2,
        taskId: 3,
        data: expect.objectContaining({
          output: 'partial',
          waitingForInput: true,
          question: '続けますか？',
          questionType: 'confirm',
        }),
      }),
    );
  });

  test('success=true かつ waitingForInput なし → execution_completed を発火する', () => {
    const emitEvent = mock((_e: OrchestratorEvent) => {});
    const result = { success: true, output: 'done' };

    emitResultEvent(result, 1, 2, 3, emitEvent);

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'execution_completed', data: result }),
    );
  });

  test('success=false → execution_failed を発火する', () => {
    const emitEvent = mock((_e: OrchestratorEvent) => {});
    const result = { success: false, output: '' };

    emitResultEvent(result, 1, 2, 3, emitEvent);

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'execution_failed', data: result }),
    );
  });
});

// ── handleExecutionError() ───────────────────────────────────────────────────

describe('handleExecutionError()', () => {
  test('Error インスタンス → そのままログし、DB更新とイベント発火を行う', async () => {
    const prisma = makePrisma();
    const state = makeState({ output: 'partial output' });
    const fileLogger = makeFileLogger();
    const emitEvent = mock((_e: OrchestratorEvent) => {});
    const error = new Error('agent died');

    await handleExecutionError(
      prisma as never,
      1,
      2,
      3,
      state,
      error,
      fileLogger,
      emitEvent,
      'Continuation',
    );

    expect(state.status).toBe('failed');
    expect(fileLogger.logError).toHaveBeenCalledWith(
      'Continuation failed with uncaught error',
      error,
    );
    expect(prisma.agentExecution.updateMany).toHaveBeenCalledWith({
      where: {
        id: 1,
        status: { notIn: ['canceling', 'cancelling', 'cancelled', 'canceled', 'completed'] },
      },
      data: expect.objectContaining({
        status: 'failed',
        output: 'partial output',
        errorMessage: 'agent died',
      }),
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'execution_failed',
        executionId: 1,
        sessionId: 2,
        taskId: 3,
        data: { errorMessage: 'agent died' },
      }),
    );
  });

  test('Error でない値がthrowされた場合 → String化し、新しいErrorでログする', async () => {
    const prisma = makePrisma();
    const state = makeState();
    const fileLogger = makeFileLogger();
    const emitEvent = mock((_e: OrchestratorEvent) => {});

    await handleExecutionError(
      prisma as never,
      1,
      2,
      3,
      state,
      'raw string failure',
      fileLogger,
      emitEvent,
      'Task',
    );

    expect(fileLogger.logError).toHaveBeenCalledTimes(1);
    const loggedError = fileLogger.logError.mock.calls[0][1] as Error;
    expect(loggedError).toBeInstanceOf(Error);
    expect(loggedError.message).toBe('raw string failure');
    expect(prisma.agentExecution.updateMany).toHaveBeenCalledWith({
      where: {
        id: 1,
        status: { notIn: ['canceling', 'cancelling', 'cancelled', 'canceled', 'completed'] },
      },
      data: expect.objectContaining({ errorMessage: 'raw string failure' }),
    });
  });

  test('エラー終端: executionTimeMs 未記録なら completedAt - startedAt (±1s) を記録する', async () => {
    const startedAt = new Date(Date.now() - 120_000); // 2分前に開始した実行
    const prisma = makePrisma({
      agentExecution: {
        updateMany: mock(async () => ({ count: 1 })),
        findUnique: mock(async () => ({ startedAt, executionTimeMs: null })),
      },
    });
    const state = makeState();
    const fileLogger = makeFileLogger();
    const emitEvent = mock((_e: OrchestratorEvent) => {});

    await handleExecutionError(
      prisma as never,
      1,
      2,
      3,
      state,
      new Error('boom'),
      fileLogger,
      emitEvent,
      'Task',
    );

    const updateArg = prisma.agentExecution.updateMany.mock.calls[0][0] as {
      data: { executionTimeMs?: number; completedAt: Date };
    };
    expect(typeof updateArg.data.executionTimeMs).toBe('number');
    const expected = updateArg.data.completedAt.getTime() - startedAt.getTime();
    expect(Math.abs((updateArg.data.executionTimeMs as number) - expected)).toBeLessThanOrEqual(
      1000,
    );
  });

  test('エラー終端: 既存の executionTimeMs セグメント値がある場合は上書きしない', async () => {
    const startedAt = new Date(Date.now() - 120_000);
    const prisma = makePrisma({
      agentExecution: {
        updateMany: mock(async () => ({ count: 1 })),
        // 質問待ち→継続で既に 45s のセグメントが記録済みのケース
        findUnique: mock(async () => ({ startedAt, executionTimeMs: 45_000 })),
      },
    });
    const state = makeState();
    const fileLogger = makeFileLogger();
    const emitEvent = mock((_e: OrchestratorEvent) => {});

    await handleExecutionError(
      prisma as never,
      1,
      2,
      3,
      state,
      new Error('boom'),
      fileLogger,
      emitEvent,
      'Task',
    );

    const updateArg = prisma.agentExecution.updateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data.executionTimeMs).toBeUndefined();
  });

  test('エラー終端: startedAt 不明・findUnique 失敗でも executionTimeMs なしで永続化は成功する', async () => {
    const prisma = makePrisma({
      agentExecution: {
        updateMany: mock(async () => ({ count: 1 })),
        findUnique: mock(async () => {
          throw new Error('DB down');
        }),
      },
    });
    const state = makeState();
    const fileLogger = makeFileLogger();
    const emitEvent = mock((_e: OrchestratorEvent) => {});

    await expect(
      handleExecutionError(
        prisma as never,
        1,
        2,
        3,
        state,
        new Error('boom'),
        fileLogger,
        emitEvent,
        'Task',
      ),
    ).resolves.toBeUndefined();

    const updateArg = prisma.agentExecution.updateMany.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data.executionTimeMs).toBeUndefined();
    expect(updateArg.data.status).toBe('failed');
  });
});

test('a persistence timeout after stop stays cancelled', async () => {
  const prisma = makePrisma();
  const state = makeState({ status: 'cancelled' });
  const emit = mock(() => {});
  await handleExecutionError(
    prisma as never,
    1,
    2,
    3,
    state,
    new Error('P1008'),
    makeFileLogger(),
    emit,
    'Execution',
  );
  expect(state.status).toBe('cancelled');
  expect(prisma.agentExecution.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) }),
  );
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'execution_cancelled' }));
});

test('stop during the timing lookup wins over a late error', async () => {
  const state = makeState();
  const prisma = makePrisma();
  prisma.agentExecution.findUnique.mockImplementationOnce(async () => {
    state.status = 'cancelled';
    return { startedAt: null, executionTimeMs: null };
  });
  await handleExecutionError(
    prisma as never,
    1,
    2,
    3,
    state,
    new Error('late error'),
    makeFileLogger(),
    mock(() => {}),
    'Execution',
  );
  expect(state.status).toBe('cancelled');
  expect(prisma.agentExecution.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) }),
  );
});

test('a persisted cancellation cannot be overwritten by an error from another owner', async () => {
  const prisma = makePrisma({
    agentExecution: {
      updateMany: mock(async () => ({ count: 0 })),
      findUnique: mock(async () => ({ status: 'cancelled' })),
    },
  });
  const state = makeState();
  const emit = mock(() => {});
  await handleExecutionError(
    prisma as never,
    1,
    2,
    3,
    state,
    new Error('late error'),
    makeFileLogger(),
    emit,
    'Execution',
  );
  expect(state.status).toBe('cancelled');
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'execution_cancelled' }));
});
