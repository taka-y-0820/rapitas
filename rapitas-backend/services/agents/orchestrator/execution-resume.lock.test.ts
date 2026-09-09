/**
 * execution-resume ロックユニットテスト
 *
 * resumeInterruptedExecution() が task-execution-lock を取得・解放すること、
 * ロック競合時に ResumeLockConflictError を投げ副作用ゼロで即終了すること、
 * 正常系・異常系いずれでも finally でロックが解放されることを検証する。
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

// ── Module-level mocks（import 前に宣言） ──────────────────────────────────────
// NOTE: mock.module はプロセスグローバル。同一 specifier をモックする他のテスト
// ファイルと同時実行される可能性があるため、実モジュールの全エクスポートを
// ミラーする（一部だけ返すと後続 import で "export not found" になる）。
// task-execution-lock.ts はDB/ネットワーク依存のない純粋な in-memory Map のため
// mock せず実モジュールをそのまま import する。

const AGENT_TYPE_LIST = ['claude-code', 'codex', 'gemini', 'custom'] as const;

const createAgentMock = mock(
  (config: { type: string; name: string; resumeSessionId?: string }) => ({
    id: 'agent-1',
    type: config.type,
    name: config.name,
    execute: mock(async () => ({
      success: true,
      output: 'done',
      artifacts: [],
      commits: [],
      executionTimeMs: 100,
      waitingForInput: false,
    })),
  }),
);
const removeAgentMock = mock(async () => true);

mock.module('../agent-factory', () => ({
  AGENT_TYPES: AGENT_TYPE_LIST,
  isAgentType: (s: unknown) => AGENT_TYPE_LIST.includes(s as (typeof AGENT_TYPE_LIST)[number]),
  narrowAgentType: (s: string | null | undefined, fallback = 'claude-code') =>
    AGENT_TYPE_LIST.includes(s as (typeof AGENT_TYPE_LIST)[number]) ? s : fallback,
  AgentFactory: class {
    static getInstance() {
      return { createAgent: createAgentMock, removeAgent: removeAgentMock };
    }
  },
  agentFactory: {
    createAgent: createAgentMock,
    removeAgent: removeAgentMock,
    getAgent: mock(() => undefined),
    getAllActiveAgents: mock(() => new Map()),
    getRegisteredAgents: mock(() => []),
    getAvailableAgents: mock(async () => []),
    getAgentsByCapability: mock(() => []),
    createDefaultAgent: mock(() => ({ id: 'agent-default' })),
  },
}));

const fileLoggerLogExecutionStart = mock(() => {});
const fileLoggerLogWarn = mock(() => {});
const fileLoggerFlush = mock(async () => {});

mock.module('../execution-file-logger', () => ({
  ExecutionFileLogger: class {
    logExecutionStart(...args: unknown[]) {
      fileLoggerLogExecutionStart(...args);
    }
    logWarn(...args: unknown[]) {
      fileLoggerLogWarn(...args);
    }
    logInfo() {}
    logError() {}
    logExecutionEnd() {}
    async flush() {
      await fileLoggerFlush();
    }
  },
  DEFAULT_CONFIG: {
    logDir: 'test-logs',
    maxLogFiles: 1,
    maxLogSizeBytes: 1,
    enableConsolePassthrough: false,
  },
  listExecutionLogFiles: mock(async () => []),
  getExecutionLogFile: mock(async () => null),
  cleanupOldLogs: mock(async () => 0),
}));

const sharedLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
};
const getProjectRootMock = mock(() => 'C:\\Projects\\rapitas');

mock.module('../../../config', () => ({
  prisma: {},
  ensureDatabaseConnection: mock(async () => {}),
  logger: sharedLogger,
  createLogger: () => sharedLogger,
  getDbProvider: () => 'PostgreSQL',
  getInsensitiveMode: () => ({}),
  getProjectRoot: getProjectRootMock,
}));

const createLogChunkManagerMock = mock(() => ({ cleanup: mock(async () => {}) }));
const setupQuestionDetectedHandlerMock = mock(() => {});
const setupOutputHandlerMock = mock(() => {});
const saveExecutionResultMock = mock(async () => {});
const emitResultEventMock = mock(() => {});
const handleExecutionErrorMock = mock(async () => {});

mock.module('./execution-helpers', () => ({
  toJsonString: (v: unknown) => JSON.stringify(v),
  createLogChunkManager: createLogChunkManagerMock,
  setupQuestionDetectedHandler: setupQuestionDetectedHandlerMock,
  setupOutputHandler: setupOutputHandlerMock,
  determineExecutionStatus: () => 'completed',
  saveExecutionResult: saveExecutionResultMock,
  emitResultEvent: emitResultEventMock,
  handleExecutionError: handleExecutionErrorMock,
  extractIdeaMarkers: () => [],
}));

// ── 動的 import（全 mock.module 宣言後） ──────────────────────────────────────

const { resumeInterruptedExecution, ResumeLockConflictError } = await import('./execution-resume');
const { acquireTaskExecutionLock, releaseTaskExecutionLock, isTaskExecutionLocked } =
  await import('../task-execution-lock');

// ── 型 import（ランタイムに影響なし） ─────────────────────────────────────────

import type { OrchestratorContext } from './types';

// ── ヘルパー ──────────────────────────────────────────────────────────────────

type MockPrisma = {
  $transaction: <T>(fn: (tx: MockPrisma) => Promise<T>) => Promise<T>;
  task: { updateMany: ReturnType<typeof mock> };
  agentExecution: {
    findUnique: ReturnType<typeof mock>;
    updateMany: ReturnType<typeof mock>;
  };
  agentExecutionLog: {
    findMany: ReturnType<typeof mock>;
  };
  aIAgentConfig: {
    findUnique: ReturnType<typeof mock>;
  };
};

const TASK_ID = 5;

/** テスト用の最小 execution レコード（findUnique の include 形状に合わせる）。 */
function makeExecutionRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    sessionId: 20,
    status: 'interrupted',
    claudeSessionId: 'claude-session-abc',
    output: 'previous output tail',
    errorMessage: null,
    artifacts: null,
    tokensUsed: null,
    executionTimeMs: null,
    agentConfigId: null,
    executionLogs: [{ logChunk: 'log chunk 1', sequenceNumber: 0 }],
    session: {
      config: {
        task: {
          id: TASK_ID,
          title: 'テストタスク',
          description: 'テスト用説明',
          theme: { workingDirectory: 'C:\\Users\\test\\project', name: 'テストテーマ' },
        },
      },
    },
    ...overrides,
  };
}

/** テスト用の最小 OrchestratorContext を生成する。 */
function makeCtx(
  execution: ReturnType<typeof makeExecutionRecord> | null,
  overrides: Partial<OrchestratorContext> = {},
): { ctx: OrchestratorContext; prisma: MockPrisma } {
  const prisma: MockPrisma = {
    $transaction: async (fn) => fn(prisma),
    task: { updateMany: mock(async () => ({ count: 1 })) },
    agentExecution: {
      findUnique: mock(async () => execution),
      updateMany: mock(async () => ({ count: 1 })),
    },
    agentExecutionLog: {
      findMany: mock(async () => []),
    },
    aIAgentConfig: {
      findUnique: mock(async () => null),
    },
  };

  const ctx = {
    prisma: prisma as unknown as OrchestratorContext['prisma'],
    activeExecutions: new Map(),
    activeAgents: new Map(),
    isShuttingDown: false,
    serverStartedAt: new Date(),
    emitEvent: mock(() => {}),
    startQuestionTimeout: mock(() => {}),
    cancelQuestionTimeout: mock(() => {}),
    getQuestionTimeoutInfo: mock(() => null),
    tryAcquireContinuationLock: mock(() => true),
    releaseContinuationLock: mock(() => {}),
    buildAgentConfigFromDb: mock(async () => ({ type: 'claude-code' as const, name: 'test' })),
    ...overrides,
  } as OrchestratorContext;

  return { ctx, prisma };
}

beforeEach(() => {
  createAgentMock.mockClear();
  removeAgentMock.mockClear();
  fileLoggerLogExecutionStart.mockClear();
  fileLoggerLogWarn.mockClear();
  fileLoggerFlush.mockClear();
  sharedLogger.warn.mockClear();
  sharedLogger.info.mockClear();
  getProjectRootMock.mockClear();
  createLogChunkManagerMock.mockClear();
  setupQuestionDetectedHandlerMock.mockClear();
  setupOutputHandlerMock.mockClear();
  saveExecutionResultMock.mockClear();
  emitResultEventMock.mockClear();
  handleExecutionErrorMock.mockClear();
  releaseTaskExecutionLock(TASK_ID);
});

afterEach(() => {
  // テスト間の状態リークを防ぐ（task-execution-lock はプロセス内メモリのMap）
  releaseTaskExecutionLock(TASK_ID);
});

// ── テスト ────────────────────────────────────────────────────────────────────

describe('resumeInterruptedExecution() — task-execution-lock', () => {
  test('ロックが既に保持されているタスクIDへの resume は ResumeLockConflictError で reject される', async () => {
    const { ctx } = makeCtx(makeExecutionRecord());
    acquireTaskExecutionLock(TASK_ID, 60_000);

    await expect(resumeInterruptedExecution(ctx, 10)).rejects.toBeInstanceOf(
      ResumeLockConflictError,
    );
  });

  test('ロック競合時は agent.execute（createAgent）に一切到達しない', async () => {
    const { ctx } = makeCtx(makeExecutionRecord());
    acquireTaskExecutionLock(TASK_ID, 60_000);

    await expect(resumeInterruptedExecution(ctx, 10)).rejects.toThrow();

    expect(createAgentMock).not.toHaveBeenCalled();
  });

  test('ロック競合時は agentExecution.update（status: running への更新）が一切呼ばれない', async () => {
    const { ctx, prisma } = makeCtx(makeExecutionRecord());
    acquireTaskExecutionLock(TASK_ID, 60_000);

    await expect(resumeInterruptedExecution(ctx, 10)).rejects.toThrow();

    expect(prisma.agentExecution.updateMany).not.toHaveBeenCalled();
  });

  test('正常系の resume 完了後、ロックは解放される', async () => {
    const { ctx } = makeCtx(makeExecutionRecord());

    const result = await resumeInterruptedExecution(ctx, 10);

    expect(result.success).toBe(true);
    expect(isTaskExecutionLocked(TASK_ID)).toBe(false);
  });

  test('agent.execute が例外を投げても、reject 後にロックは解放される（finally 経由）', async () => {
    createAgentMock.mockImplementationOnce((config: { type: string; name: string }) => ({
      id: 'agent-fail',
      type: config.type,
      name: config.name,
      execute: mock(async () => {
        throw new Error('agent crashed');
      }),
    }));
    const { ctx } = makeCtx(makeExecutionRecord());

    await expect(resumeInterruptedExecution(ctx, 10)).rejects.toThrow('agent crashed');

    expect(isTaskExecutionLocked(TASK_ID)).toBe(false);
  });

  test('workingDirectory 未設定の早期throwでもロックは解放される', async () => {
    const { ctx } = makeCtx(
      makeExecutionRecord({
        session: {
          config: {
            task: {
              id: TASK_ID,
              title: 't',
              description: null,
              theme: { workingDirectory: null, name: 'テーマA' },
            },
          },
        },
      }),
    );

    await expect(resumeInterruptedExecution(ctx, 10)).rejects.toThrow(
      /workingDirectory not configured/,
    );

    expect(isTaskExecutionLocked(TASK_ID)).toBe(false);
  });
});
