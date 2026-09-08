/**
 * execution-resume ユニットテスト
 *
 * resumeInterruptedExecution() の適格性チェック（未存在/非interrupted/task欠落/
 * workingDirectory未設定）、シャットダウンガード、正常系の状態遷移・後始末、
 * エラー時のクリーンアップを検証する。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ── Module-level mocks（import 前に宣言） ──────────────────────────────────────
// NOTE: mock.module はプロセスグローバル。同一 specifier をモックする他のテスト
// ファイルと同時実行される可能性があるため、実モジュールの全エクスポートを
// ミラーする（一部だけ返すと後続 import で "export not found" になる）。

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

const { resumeInterruptedExecution } = await import('./execution-resume');

// ── 型 import（ランタイムに影響なし） ─────────────────────────────────────────

import type { OrchestratorContext } from './types';

// ── ヘルパー ──────────────────────────────────────────────────────────────────

type MockPrisma = {
  agentExecution: {
    findUnique: ReturnType<typeof mock>;
    findFirst: ReturnType<typeof mock>;
    update: ReturnType<typeof mock>;
  };
  agentExecutionLog: {
    findMany: ReturnType<typeof mock>;
  };
  aIAgentConfig: {
    findUnique: ReturnType<typeof mock>;
  };
};

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
          id: 5,
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
    agentExecution: {
      findUnique: mock(async () => execution),
      findFirst: mock(async () => null),
      update: mock(async () => ({})),
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
});

// ── テスト ────────────────────────────────────────────────────────────────────

describe('resumeInterruptedExecution() — 適格性チェック', () => {
  test('execution が存在しない → throw', async () => {
    const { ctx } = makeCtx(null);
    await expect(resumeInterruptedExecution(ctx, 999)).rejects.toThrow('Execution not found: 999');
  });

  test('status が interrupted でない → throw', async () => {
    const { ctx } = makeCtx(makeExecutionRecord({ status: 'running' }));
    await expect(resumeInterruptedExecution(ctx, 10)).rejects.toThrow(
      'Execution is not in interrupted state: running',
    );
  });

  test('task が見つからない（config.task が null） → throw', async () => {
    const { ctx } = makeCtx(makeExecutionRecord({ session: { config: { task: null } } }));
    await expect(resumeInterruptedExecution(ctx, 10)).rejects.toThrow(
      'Task not found for execution: 10',
    );
  });

  test('workingDirectory が未設定（theme もオプションも無し） → throw', async () => {
    const { ctx } = makeCtx(
      makeExecutionRecord({
        session: {
          config: {
            task: {
              id: 5,
              title: 't',
              description: null,
              theme: { workingDirectory: null, name: 'テーマA' },
            },
          },
        },
      }),
    );
    await expect(resumeInterruptedExecution(ctx, 10)).rejects.toThrow(
      /workingDirectory not configured for theme "テーマA"/,
    );
  });

  test('workingDirectory が options 経由でも未設定なら theme 名 unknown で throw', async () => {
    const { ctx } = makeCtx(
      makeExecutionRecord({
        session: { config: { task: { id: 5, title: 't', description: null, theme: null } } },
      }),
    );
    await expect(resumeInterruptedExecution(ctx, 10)).rejects.toThrow(
      /workingDirectory not configured for theme "unknown"/,
    );
  });

  test('theme.workingDirectory が無くても options.workingDirectory があれば通る', async () => {
    const { ctx } = makeCtx(
      makeExecutionRecord({
        session: {
          config: {
            task: {
              id: 5,
              title: 't',
              description: null,
              theme: { workingDirectory: null, name: 'テーマB' },
            },
          },
        },
      }),
    );
    const result = await resumeInterruptedExecution(ctx, 10, {
      workingDirectory: 'C:\\Users\\test\\fallback-dir',
    });
    expect(result.success).toBe(true);
  });
});

describe('resumeInterruptedExecution() — シャットダウンガード', () => {
  test('isShuttingDown=true → shutdown メッセージで reject し、状態を後始末する', async () => {
    const { ctx } = makeCtx(makeExecutionRecord(), { isShuttingDown: true });

    await expect(resumeInterruptedExecution(ctx, 10)).rejects.toThrow(/shut/i);

    // NOTE: シャットダウンガードは agent/state 登録直後にチェックされるため、一旦
    // Map に積んでから削除される。登録が残っていないことを確認する。
    expect(ctx.activeExecutions.has(10)).toBe(false);
    expect(ctx.activeAgents.has(10)).toBe(false);
    expect(fileLoggerLogWarn).toHaveBeenCalledTimes(1);
    expect(fileLoggerFlush).toHaveBeenCalledTimes(1);
  });

  test('isShuttingDown=true → agent.execute には到達しない', async () => {
    const { ctx } = makeCtx(makeExecutionRecord(), { isShuttingDown: true });
    createAgentMock.mockClear();

    await expect(resumeInterruptedExecution(ctx, 10)).rejects.toThrow();

    // createAgent 自体は呼ばれる（agent 構築後にガードが効くため）が、
    // 実行系ヘルパー（saveExecutionResult 等）には到達しないことを確認する。
    expect(saveExecutionResultMock).not.toHaveBeenCalled();
  });
});

describe('resumeInterruptedExecution() — 正常系', () => {
  test('claudeSessionId ありで再開し、状態遷移・後始末が行われる', async () => {
    const { ctx, prisma } = makeCtx(makeExecutionRecord());

    const result = await resumeInterruptedExecution(ctx, 10);

    expect(result.success).toBe(true);
    expect(createAgentMock).toHaveBeenCalledTimes(1);
    const createdConfig = createAgentMock.mock.calls[0][0];
    expect(createdConfig.resumeSessionId).toBe('claude-session-abc');

    expect(prisma.agentExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 10 },
        data: expect.objectContaining({ status: 'running', errorMessage: null }),
      }),
    );
    expect(ctx.emitEvent as ReturnType<typeof mock>).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'execution_started', data: { resumed: true } }),
    );

    expect(saveExecutionResultMock).toHaveBeenCalledTimes(1);
    expect(emitResultEventMock).toHaveBeenCalledTimes(1);

    // 後始末: activeExecutions/activeAgents から削除され、agentFactory.removeAgent が呼ばれる
    expect(ctx.activeExecutions.has(10)).toBe(false);
    expect(ctx.activeAgents.has(10)).toBe(false);
    expect(removeAgentMock).toHaveBeenCalledWith('agent-1');
  });

  test('claudeSessionId なし → 警告ログを出し、resumeSessionId は undefined で新規セッション開始', async () => {
    const { ctx } = makeCtx(makeExecutionRecord({ claudeSessionId: null }));

    await resumeInterruptedExecution(ctx, 10);

    expect(sharedLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No Claude session ID found'),
    );
    const createdConfig = createAgentMock.mock.calls[0][0];
    expect(createdConfig.resumeSessionId).toBeUndefined();
  });

  test('workingDirectory が rapitas プロジェクトルートと重なる → 警告ログを出しつつ続行する', async () => {
    const { ctx } = makeCtx(
      makeExecutionRecord({
        session: {
          config: {
            task: {
              id: 5,
              title: 't',
              description: null,
              theme: {
                workingDirectory: 'C:\\Projects\\rapitas\\rapitas-backend',
                name: 'テーマC',
              },
            },
          },
        },
      }),
    );

    const result = await resumeInterruptedExecution(ctx, 10);

    expect(result.success).toBe(true);
    expect(sharedLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('workingDirectory overlaps with rapitas project'),
    );
  });

  test('workingDirectory が rapitas プロジェクトルートそのもの → 警告ログを出す', async () => {
    const { ctx } = makeCtx(
      makeExecutionRecord({
        session: {
          config: {
            task: {
              id: 5,
              title: 't',
              description: null,
              theme: { workingDirectory: 'C:\\Projects\\rapitas', name: 'テーマD' },
            },
          },
        },
      }),
    );

    await resumeInterruptedExecution(ctx, 10);

    expect(sharedLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('workingDirectory overlaps with rapitas project'),
    );
  });

  test('通常の外部 workingDirectory では重複警告を出さない', async () => {
    const { ctx } = makeCtx(makeExecutionRecord());

    await resumeInterruptedExecution(ctx, 10);

    const overlapWarnCalls = sharedLogger.warn.mock.calls.filter((call) =>
      String(call[0]).includes('workingDirectory overlaps'),
    );
    expect(overlapWarnCalls).toHaveLength(0);
  });

  test('agentConfigId 設定時、DB 設定が見つからなければ fallback 設定のまま createAgent する', async () => {
    const { ctx, prisma } = makeCtx(makeExecutionRecord({ agentConfigId: 42 }));

    const result = await resumeInterruptedExecution(ctx, 10);

    expect(result.success).toBe(true);
    expect(prisma.aIAgentConfig.findUnique).toHaveBeenCalledWith({ where: { id: 42 } });
    const createdConfig = createAgentMock.mock.calls[0][0];
    // NOTE: resolveAgentConfig は DB レコードが無い場合フォールバックをそのまま返す。
    expect(createdConfig.type).toBe('claude-code');
    expect(createdConfig.resumeSessionId).toBe('claude-session-abc');
  });

  test('LLM call count は CLI(num_turns) と ALS(sendAIMessage) の合算になる', async () => {
    const { incrementLlmCall } = await import('../../../utils/llm-call-context');
    createAgentMock.mockImplementationOnce((config: { type: string; name: string }) => ({
      id: 'agent-llm',
      type: config.type,
      name: config.name,
      execute: mock(async () => {
        incrementLlmCall();
        incrementLlmCall();
        return {
          success: true,
          output: 'done',
          artifacts: [],
          commits: [],
          executionTimeMs: 100,
          waitingForInput: false,
          llmCallCount: 5,
        };
      }),
    }));
    const { ctx } = makeCtx(makeExecutionRecord());

    const result = await resumeInterruptedExecution(ctx, 10);

    expect(result.llmCallCount).toBe(7);
  });
});

describe('resumeInterruptedExecution() — prompt_too_long ガード (task 900)', () => {
  test('直近failedのerrorMessageが【Prompt Too Long】を含む → resumeSessionId は undefined でコールドスタートする', async () => {
    const { ctx, prisma } = makeCtx(makeExecutionRecord());
    prisma.agentExecution.findFirst.mockResolvedValue({
      errorMessage: '【Prompt Too Long】Claude Code CLI reported the prompt/context was too long',
    });

    const result = await resumeInterruptedExecution(ctx, 10);

    expect(result.success).toBe(true);
    const createdConfig = createAgentMock.mock.calls[0][0];
    expect(createdConfig.resumeSessionId).toBeUndefined();
    expect(prisma.agentExecution.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { claudeSessionId: 'claude-session-abc', status: 'failed' },
      }),
    );
  });

  test('直近failedの理由が prompt_too_long 以外（認証等）→ 既存どおり claudeSessionId を渡す', async () => {
    const { ctx, prisma } = makeCtx(makeExecutionRecord());
    prisma.agentExecution.findFirst.mockResolvedValue({
      errorMessage: 'Claude CLI の認証に失敗しました（認証情報の期限切れ/無効）。',
    });

    await resumeInterruptedExecution(ctx, 10);

    const createdConfig = createAgentMock.mock.calls[0][0];
    expect(createdConfig.resumeSessionId).toBe('claude-session-abc');
  });

  test('failed実行が無い（findFirstがnull）→ 既存どおり claudeSessionId を渡す', async () => {
    const { ctx, prisma } = makeCtx(makeExecutionRecord());
    prisma.agentExecution.findFirst.mockResolvedValue(null);

    await resumeInterruptedExecution(ctx, 10);

    const createdConfig = createAgentMock.mock.calls[0][0];
    expect(createdConfig.resumeSessionId).toBe('claude-session-abc');
  });

  test('claudeSessionId が無い場合は findFirst を呼ばない', async () => {
    const { ctx, prisma } = makeCtx(makeExecutionRecord({ claudeSessionId: null }));

    await resumeInterruptedExecution(ctx, 10);

    expect(prisma.agentExecution.findFirst).not.toHaveBeenCalled();
  });

  test('findFirst が失敗しても resume はブロックされない（claudeSessionId を渡す）', async () => {
    const { ctx, prisma } = makeCtx(makeExecutionRecord());
    prisma.agentExecution.findFirst.mockRejectedValue(new Error('db down'));

    const result = await resumeInterruptedExecution(ctx, 10);

    expect(result.success).toBe(true);
    const createdConfig = createAgentMock.mock.calls[0][0];
    expect(createdConfig.resumeSessionId).toBe('claude-session-abc');
  });
});

describe('resumeInterruptedExecution() — エラー処理', () => {
  test('agent.execute が失敗 → handleExecutionError を呼び、後始末してから rethrow する', async () => {
    const executeError = new Error('agent crashed');
    createAgentMock.mockImplementationOnce((config: { type: string; name: string }) => ({
      id: 'agent-fail',
      type: config.type,
      name: config.name,
      execute: mock(async () => {
        throw executeError;
      }),
    }));
    const { ctx } = makeCtx(makeExecutionRecord());

    await expect(resumeInterruptedExecution(ctx, 10)).rejects.toBe(executeError);

    expect(handleExecutionErrorMock).toHaveBeenCalledTimes(1);
    expect(saveExecutionResultMock).not.toHaveBeenCalled();
    // 後始末は catch/return いずれの経路でも finally で必ず行われる
    expect(ctx.activeExecutions.has(10)).toBe(false);
    expect(ctx.activeAgents.has(10)).toBe(false);
    expect(removeAgentMock).toHaveBeenCalledWith('agent-fail');
  });
});
