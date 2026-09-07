/**
 * execution-persistence ユニットテスト（状態判定／DB永続化系）
 *
 * determineExecutionStatus の分岐と、saveExecutionResult の DB書き込み・
 * 数値サニタイズ・自己学習レコーダー連携を検証する。
 * emitResultEvent / handleExecutionError は execution-persistence-events.test.ts 側。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ── Module-level mocks（import 前に宣言） ──────────────────────────────────────

const recordWorkflowExecutionMock = mock(async () => {});
mock.module('../../self-learning/workflow-learning-recorder', () => ({
  recordWorkflowExecution: recordWorkflowExecutionMock,
}));

// ── 動的 import（全 mock.module 宣言後） ──────────────────────────────────────

const { determineExecutionStatus, saveExecutionResult } = await import('./execution-persistence');
const { mergeFallbackSegmentTime } = await import('./execution-attempt-metrics');

// ── 型 import（ランタイムに影響なし） ─────────────────────────────────────────

import type { ExecutionState } from './types';

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
    log: mock(() => {}),
    flush: mock(async () => {}),
    // biome-ignore-like cast: only the methods used by execution-persistence matter here
  } as unknown as import('../execution-file-logger').ExecutionFileLogger;
}

/** テスト用の Prisma スタブを生成する。 */
function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    agentExecution: {
      update: mock(async () => ({})),
      findUnique: mock(async () => ({ session: { config: { taskId: 99 } } })),
    },
    agentSession: {
      update: mock(async () => ({})),
    },
    gitCommit: {
      create: mock(async () => ({})),
    },
    ...overrides,
  };
}

beforeEach(() => {
  recordWorkflowExecutionMock.mockClear();
});

// ── determineExecutionStatus() ───────────────────────────────────────────────

describe('determineExecutionStatus()', () => {
  test('waitingForInput=true → waiting_for_input に遷移し、logStatusChange を呼ぶ', () => {
    const state = makeState();
    const fileLogger = makeFileLogger();

    const status = determineExecutionStatus(
      { success: false, waitingForInput: true },
      fileLogger,
      state,
    );

    expect(status).toBe('waiting_for_input');
    expect(state.status).toBe('waiting_for_input');
    expect(fileLogger.logStatusChange).toHaveBeenCalledWith(
      'running',
      'waiting_for_input',
      'Question detected',
    );
  });

  test('success=true かつ investigationMode=true → post_processing で完了扱いにしない', () => {
    const state = makeState();
    const fileLogger = makeFileLogger();

    const status = determineExecutionStatus({ success: true }, fileLogger, state, {
      investigationMode: true,
    });

    expect(status).toBe('post_processing');
    expect(state.status).toBe('post_processing');
    expect(fileLogger.logExecutionEnd).not.toHaveBeenCalled();
  });

  test('success=true かつ investigationMode なし → completed', () => {
    const state = makeState();
    const fileLogger = makeFileLogger();

    const status = determineExecutionStatus(
      { success: true, tokensUsed: 10, executionTimeMs: 500 },
      fileLogger,
      state,
    );

    expect(status).toBe('completed');
    expect(state.status).toBe('completed');
    expect(fileLogger.logExecutionEnd).toHaveBeenCalledWith('completed', {
      success: true,
      tokensUsed: 10,
      executionTimeMs: 500,
    });
  });

  test('success=false → failed でエラーメッセージを記録する', () => {
    const state = makeState();
    const fileLogger = makeFileLogger();

    const status = determineExecutionStatus(
      { success: false, errorMessage: 'boom', tokensUsed: 1, executionTimeMs: 2 },
      fileLogger,
      state,
    );

    expect(status).toBe('failed');
    expect(state.status).toBe('failed');
    expect(fileLogger.logExecutionEnd).toHaveBeenCalledWith('failed', {
      success: false,
      tokensUsed: 1,
      executionTimeMs: 2,
      errorMessage: 'boom',
    });
  });

  // #808: 意図的なキャンセル終了は failed(ERROR) ではなく cancelled(WARN) に分類する
  test('failureType=cancelled → cancelled に遷移し、logExecutionEnd を cancelled で呼ぶ', () => {
    const state = makeState();
    const fileLogger = makeFileLogger();

    const status = determineExecutionStatus(
      {
        success: false,
        errorMessage: 'Execution cancelled',
        failureType: 'cancelled',
        tokensUsed: 3,
        executionTimeMs: 4,
      },
      fileLogger,
      state,
    );

    expect(status).toBe('cancelled');
    expect(state.status).toBe('cancelled');
    expect(fileLogger.logExecutionEnd).toHaveBeenCalledWith('cancelled', {
      success: false,
      tokensUsed: 3,
      executionTimeMs: 4,
      errorMessage: 'Execution cancelled',
    });
  });

  test('waitingForInput=true かつ failureType=cancelled → waiting_for_input を優先する', () => {
    const state = makeState();
    const fileLogger = makeFileLogger();

    const status = determineExecutionStatus(
      { success: false, waitingForInput: true, failureType: 'cancelled' },
      fileLogger,
      state,
    );

    expect(status).toBe('waiting_for_input');
    expect(fileLogger.logExecutionEnd).not.toHaveBeenCalled();
  });
});

// ── saveExecutionResult() ────────────────────────────────────────────────────

describe('saveExecutionResult()', () => {
  test.each([0.75, undefined])(
    'same-ID attempt metrics reach the log and only a complete total reaches DB (%s)',
    async (costUsd) => {
      const prisma = makePrisma();
      const fileLogger = makeFileLogger();
      const result = mergeFallbackSegmentTime(
        { success: false, output: '', costUsd, modelName: 'first-model' },
        { success: true, output: 'ok', costUsd: 1.25, modelName: 'last-model' },
      );
      await saveExecutionResult(prisma as never, 1, 2, makeState(), result, fileLogger);
      expect(fileLogger.log).toHaveBeenCalledWith('INFO', 'recovery', 'execution_attempt_metrics', {
        executionId: 1,
        sessionId: 2,
        attempts: result.attemptMetrics,
        settled: true,
      });
      expect(prisma.agentExecution.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data:
            costUsd === undefined
              ? expect.not.objectContaining({ costUsd: expect.anything() })
              : expect.objectContaining({ costUsd: 2 }),
        }),
      );
    },
  );
  test('completed: 既存値に加算し、completedAt を設定し、自己学習レコードを記録する', async () => {
    const prisma = makePrisma();
    const state = makeState({ output: 'final output' });
    const fileLogger = makeFileLogger();

    await saveExecutionResult(
      prisma as never,
      1,
      2,
      state,
      { success: true, tokensUsed: 10, executionTimeMs: 1000 },
      fileLogger,
      { tokensUsed: 5, executionTimeMs: 500, artifacts: null, claudeSessionId: null },
    );

    expect(prisma.agentExecution.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({
        status: 'completed',
        output: 'final output',
        tokensUsed: 15,
        executionTimeMs: 1500,
        completedAt: expect.any(Date),
        artifacts: null,
        claudeSessionId: null,
      }),
    });

    // No cost/model/llmCallCount signal was provided → usageUpdate stays empty.
    const updateArg = prisma.agentExecution.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data.costUsd).toBeUndefined();
    expect(updateArg.data.modelName).toBeUndefined();

    expect(prisma.agentSession.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: expect.objectContaining({ totalTokensUsed: { increment: 10 } }),
    });

    expect(recordWorkflowExecutionMock).toHaveBeenCalledWith(prisma, {
      taskId: 99,
      outcome: 'completed',
      actualDurationMinutes: 0,
      errorMessage: null,
      modelName: null,
    });
  });

  test('waitingForInput=true: completedAt は null、usageUpdate は常に空、自己学習は記録されない', async () => {
    const prisma = makePrisma();
    const state = makeState();
    const fileLogger = makeFileLogger();

    await saveExecutionResult(
      prisma as never,
      1,
      2,
      state,
      { success: false, waitingForInput: true, costUsd: 5, modelName: 'claude-x' },
      fileLogger,
    );

    const updateArg = prisma.agentExecution.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data.completedAt).toBeNull();
    // NOTE: usageUpdate is gated by `!result.waitingForInput` up front, so
    // cost/model signals are never written while checkpointing mid-question.
    expect(updateArg.data.costUsd).toBeUndefined();
    expect(updateArg.data.modelName).toBeUndefined();
    expect(prisma.agentExecution.findUnique).not.toHaveBeenCalled();
    expect(recordWorkflowExecutionMock).not.toHaveBeenCalled();
  });

  test('double-JSON文字列化された数値フィールドを安全な数値へ補正する', async () => {
    const prisma = makePrisma();
    const state = makeState();
    const fileLogger = makeFileLogger();

    await saveExecutionResult(
      prisma as never,
      1,
      2,
      state,
      {
        success: true,
        costUsd: '"1.46"' as unknown as number,
        llmCallCount: '"3"' as unknown as number,
        modelName: 'claude-x',
      },
      fileLogger,
    );

    const updateArg = prisma.agentExecution.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data.costUsd).toBe(1.46);
    expect(updateArg.data.llmCallCount).toBe(3);
    expect(updateArg.data.inputTokens).toBe(0);
    expect(updateArg.data.outputTokens).toBe(0);

    expect(prisma.agentSession.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: expect.objectContaining({
        totalCostUsd: { increment: 1.46 },
        totalLlmCallCount: { increment: 3 },
      }),
    });
  });

  test('failed: outcome=failed と実際のエラーメッセージを自己学習に渡す', async () => {
    const prisma = makePrisma();
    const state = makeState();
    const fileLogger = makeFileLogger();

    await saveExecutionResult(
      prisma as never,
      1,
      2,
      state,
      { success: false, errorMessage: 'agent crashed', executionTimeMs: 120000 },
      fileLogger,
    );

    expect(recordWorkflowExecutionMock).toHaveBeenCalledWith(prisma, {
      taskId: 99,
      outcome: 'failed',
      actualDurationMinutes: 2,
      errorMessage: 'agent crashed',
      modelName: null,
    });
  });

  test('taskId が解決できない場合は自己学習レコーダーを呼ばない', async () => {
    const prisma = makePrisma({
      agentExecution: {
        update: mock(async () => ({})),
        findUnique: mock(async () => ({ session: { config: null } })),
      },
    });
    const state = makeState();
    const fileLogger = makeFileLogger();

    await saveExecutionResult(prisma as never, 1, 2, state, { success: true }, fileLogger);

    expect(recordWorkflowExecutionMock).not.toHaveBeenCalled();
  });

  test('自己学習レコーダーの探索が失敗しても saveExecutionResult 自体は失敗しない', async () => {
    const prisma = makePrisma({
      agentExecution: {
        update: mock(async () => ({})),
        findUnique: mock(async () => {
          throw new Error('DB down');
        }),
      },
    });
    const state = makeState();
    const fileLogger = makeFileLogger();

    await expect(
      saveExecutionResult(prisma as never, 1, 2, state, { success: true }, fileLogger),
    ).resolves.toBeUndefined();
  });

  test('コミット情報をログとDBの両方に記録し、branch未指定は空文字にフォールバックする', async () => {
    const prisma = makePrisma();
    const state = makeState();
    const fileLogger = makeFileLogger();

    await saveExecutionResult(
      prisma as never,
      1,
      2,
      state,
      {
        success: true,
        commits: [
          { hash: 'abc123', message: 'fix bug', filesChanged: 2, additions: 5, deletions: 1 },
        ],
      },
      fileLogger,
    );

    expect(fileLogger.logGitCommit).toHaveBeenCalledWith({
      hash: 'abc123',
      message: 'fix bug',
      branch: undefined,
      filesChanged: 2,
      additions: 5,
      deletions: 1,
    });
    expect(prisma.gitCommit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ executionId: 1, commitHash: 'abc123', branch: '' }),
    });
  });

  test('claudeSessionId は result 優先、なければ existingData にフォールバックする', async () => {
    const prisma = makePrisma();
    const state = makeState();
    const fileLogger = makeFileLogger();

    await saveExecutionResult(
      prisma as never,
      1,
      2,
      state,
      { success: true, claudeSessionId: undefined },
      fileLogger,
      { claudeSessionId: 'old-session' },
    );

    const updateArg = prisma.agentExecution.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data.claudeSessionId).toBe('old-session');
  });

  test('tokensUsed=0/costUsd未指定 → agentSession の増分更新はスキップされる', async () => {
    const prisma = makePrisma();
    const state = makeState();
    const fileLogger = makeFileLogger();

    await saveExecutionResult(
      prisma as never,
      1,
      2,
      state,
      { success: true, tokensUsed: 0 },
      fileLogger,
    );

    expect(prisma.agentSession.update).not.toHaveBeenCalled();
  });

  // ── cpuTimeMs / peakRssKb（資源テレメトリ, task #714） ────────────────────

  test('資源テレメトリ: 既存値なし → 実測値をそのまま書き込む', async () => {
    const prisma = makePrisma();
    const state = makeState();
    const fileLogger = makeFileLogger();

    await saveExecutionResult(
      prisma as never,
      1,
      2,
      state,
      { success: true, cpuTimeMs: 1200, peakRssKb: 51200 },
      fileLogger,
    );

    const updateArg = prisma.agentExecution.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data.cpuTimeMs).toBe(1200);
    expect(updateArg.data.peakRssKb).toBe(51200);
  });

  test('資源テレメトリ: 既存値あり → CPU時間は加算、RSSは最大値を採用する', async () => {
    const prisma = makePrisma();
    const state = makeState();
    const fileLogger = makeFileLogger();

    await saveExecutionResult(
      prisma as never,
      1,
      2,
      state,
      { success: true, cpuTimeMs: 800, peakRssKb: 30000 },
      fileLogger,
      { cpuTimeMs: 1000, peakRssKb: 60000 },
    );

    const updateArg = prisma.agentExecution.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data.cpuTimeMs).toBe(1800);
    expect(updateArg.data.peakRssKb).toBe(60000);
  });

  test('資源テレメトリ: null/未計測は書き込みキー自体を省く（既存値を上書きしない）', async () => {
    const prisma = makePrisma();
    const state = makeState();
    const fileLogger = makeFileLogger();

    await saveExecutionResult(
      prisma as never,
      1,
      2,
      state,
      { success: true, cpuTimeMs: null, peakRssKb: null },
      fileLogger,
      { cpuTimeMs: 1000, peakRssKb: 60000 },
    );

    const updateArg = prisma.agentExecution.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data.cpuTimeMs).toBeUndefined();
    expect(updateArg.data.peakRssKb).toBeUndefined();
  });

  test('資源テレメトリ: waitingForInput=true でも欠落しない', async () => {
    const prisma = makePrisma();
    const state = makeState();
    const fileLogger = makeFileLogger();

    await saveExecutionResult(
      prisma as never,
      1,
      2,
      state,
      { success: false, waitingForInput: true, cpuTimeMs: 500, peakRssKb: 20000 },
      fileLogger,
    );

    const updateArg = prisma.agentExecution.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data.cpuTimeMs).toBe(500);
    expect(updateArg.data.peakRssKb).toBe(20000);
  });

  test('資源テレメトリ: 文字列化された数値も安全な数値へ補正する', async () => {
    const prisma = makePrisma();
    const state = makeState();
    const fileLogger = makeFileLogger();

    await saveExecutionResult(
      prisma as never,
      1,
      2,
      state,
      {
        success: true,
        cpuTimeMs: '"900"' as unknown as number,
        peakRssKb: '"40000"' as unknown as number,
      },
      fileLogger,
    );

    const updateArg = prisma.agentExecution.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateArg.data.cpuTimeMs).toBe(900);
    expect(updateArg.data.peakRssKb).toBe(40000);
  });
});
