/**
 * stale-execution-recovery ユニットテスト
 *
 * recoverStaleExecutions() の起動時リカバリロジック（stale 実行の検出・
 * interrupted 化、関連 session/task の巻き戻し、通知作成、個別失敗時の
 * 継続動作、最上位 try/catch のフェイルセーフ）と getInterruptedExecutions()
 * を検証する。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ── Module-level mocks（import 前に宣言） ──────────────────────────────────────
// NOTE: mock.module はプロセスグローバル。実モジュールの全エクスポートを
// ミラーする（一部だけ返すと他テストの import で "export not found" になる）。

const sharedLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
};

mock.module('../../../config', () => ({
  prisma: {},
  ensureDatabaseConnection: mock(async () => {}),
  logger: sharedLogger,
  createLogger: () => sharedLogger,
  getDbProvider: () => 'PostgreSQL',
  getInsensitiveMode: () => ({}),
  getProjectRoot: () => 'C:\\Projects\\rapitas',
}));

const reconcileOrphanedBlockedSessionsMock = mock(async () => ({
  reconciledSessionIds: [] as number[],
}));
const pruneStaleWorktreePointersMock = mock(async () => 0);

// stale-recovery-helpers records WorkflowTransition rows through the real
// recorder, which opens the real Prisma client and hangs the suite (5s timeout).
mock.module('../../workflow/transition-recorder', () => ({
  recordTransition: mock(async () => {}),
  RECOVERY_REQUEUE_CAUSES: new Set<string>(),
}));

mock.module('./stale-blocked-session-reconciliation', () => ({
  reconcileOrphanedBlockedSessions: reconcileOrphanedBlockedSessionsMock,
  pruneStaleWorktreePointers: pruneStaleWorktreePointersMock,
}));

// ── 動的 import（全 mock.module 宣言後） ──────────────────────────────────────

const { recoverStaleExecutions, getInterruptedExecutions } =
  await import('./stale-execution-recovery');

// ── 型 import（ランタイムに影響なし） ─────────────────────────────────────────

import type { OrchestratorContext } from './types';

// ── ヘルパー ──────────────────────────────────────────────────────────────────

type MockPrisma = {
  agentExecution: {
    findMany: ReturnType<typeof mock>;
    findFirst: ReturnType<typeof mock>;
    update: ReturnType<typeof mock>;
    count: ReturnType<typeof mock>;
  };
  agentSession: {
    findMany: ReturnType<typeof mock>;
    update: ReturnType<typeof mock>;
  };
  task: {
    findUnique: ReturnType<typeof mock>;
    update: ReturnType<typeof mock>;
  };
  notification: {
    create: ReturnType<typeof mock>;
  };
};

/** テスト用の stale execution レコード。 */
function makeStaleExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    sessionId: 100,
    output: 'x'.repeat(20),
    session: {
      config: {
        task: { id: 1000, title: 'テストタスク', status: 'in-progress' },
      },
    },
    ...overrides,
  };
}

/** デフォルトで空配列・成功応答を返す最小 Prisma スタブを生成する。 */
function makeMockPrisma(overrides: Partial<MockPrisma> = {}): MockPrisma {
  // NOTE: モデル単位で deep-merge する — 呼び出し側が一部メソッドだけ
  // 差し替えても、残り（findFirst 等）はデフォルト実装が生きる。
  const base: MockPrisma = {
    agentExecution: {
      findMany: mock(async () => []),
      findFirst: mock(async () => null),
      update: mock(async () => ({})),
      count: mock(async () => 0),
    },
    agentSession: {
      findMany: mock(async () => []),
      update: mock(async () => ({})),
    },
    task: {
      findUnique: mock(async () => null),
      update: mock(async () => ({})),
    },
    notification: {
      create: mock(async () => ({})),
    },
  } as MockPrisma;
  return {
    agentExecution: { ...base.agentExecution, ...overrides.agentExecution },
    agentSession: { ...base.agentSession, ...overrides.agentSession },
    task: { ...base.task, ...overrides.task },
    notification: { ...base.notification, ...overrides.notification },
  } as MockPrisma;
}

/** テスト用の最小 OrchestratorContext を生成する。 */
function makeCtx(
  prisma: MockPrisma,
  overrides: Partial<OrchestratorContext> = {},
): OrchestratorContext {
  return {
    prisma: prisma as unknown as OrchestratorContext['prisma'],
    activeExecutions: new Map(),
    activeAgents: new Map(),
    isShuttingDown: false,
    serverStartedAt: new Date('2026-01-01T00:00:00Z'),
    emitEvent: mock(() => {}),
    startQuestionTimeout: mock(() => {}),
    cancelQuestionTimeout: mock(() => {}),
    getQuestionTimeoutInfo: mock(() => null),
    tryAcquireContinuationLock: mock(() => true),
    releaseContinuationLock: mock(() => {}),
    buildAgentConfigFromDb: mock(async () => ({ type: 'claude-code' as const, name: 'test' })),
    ...overrides,
  } as OrchestratorContext;
}

beforeEach(() => {
  reconcileOrphanedBlockedSessionsMock.mockClear();
  reconcileOrphanedBlockedSessionsMock.mockImplementation(async () => ({
    reconciledSessionIds: [],
  }));
  pruneStaleWorktreePointersMock.mockClear();
  pruneStaleWorktreePointersMock.mockImplementation(async () => 0);
  sharedLogger.error.mockClear();
  sharedLogger.info.mockClear();
});

// ── テスト ────────────────────────────────────────────────────────────────────

describe('recoverStaleExecutions() — stale なし', () => {
  test('stale 実行が0件でも reconcile/prune は必ず実行され、結果に反映される', async () => {
    reconcileOrphanedBlockedSessionsMock.mockImplementation(async () => ({
      reconciledSessionIds: [7, 8],
    }));
    pruneStaleWorktreePointersMock.mockImplementation(async () => 2);
    const prisma = makeMockPrisma();
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    expect(result).toEqual({
      recoveredExecutions: 0,
      updatedTasks: 0,
      updatedSessions: 0,
      interruptedExecutionIds: [],
      reconciledBlockedSessions: 2,
      prunedWorktreePointers: 2,
    });
    expect(reconcileOrphanedBlockedSessionsMock).toHaveBeenCalledTimes(1);
    // NOTE: stale execution が無い経路では reconcile の結果セットだけが渡される
    expect(pruneStaleWorktreePointersMock).toHaveBeenCalledWith(ctx, new Set([7, 8]));
    expect(prisma.agentExecution.update).not.toHaveBeenCalled();
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  test('activeExecutions に含まれる executionId は notIn として問い合わせに渡る', async () => {
    const prisma = makeMockPrisma();
    const ctx = makeCtx(prisma);
    ctx.activeExecutions.set(999, {
      executionId: 999,
      sessionId: 1,
      agentId: 'a',
      taskId: 1,
      status: 'running',
      startedAt: new Date(),
      output: '',
    });

    await recoverStaleExecutions(ctx);

    const queryArg = prisma.agentExecution.findMany.mock.calls[0][0] as {
      where: { id: { notIn: number[] } };
    };
    expect(queryArg.where.id.notIn).toEqual([999]);
  });

  test('起動時判定は heartbeat 基準 + null フォールバックで、起動後開始の行はどちらの条件にも該当しない', async () => {
    const prisma = makeMockPrisma();
    const ctx = makeCtx(prisma);

    await recoverStaleExecutions(ctx);

    const queryArg = prisma.agentExecution.findMany.mock.calls[0][0] as {
      where: { OR: Array<Record<string, unknown>> };
    };
    // heartbeatAt >= serverStartedAt の行（起動後に生きたプロセスが beat した行）は
    // 両 OR 条件に不該当 = 是正対象外であることを where 形で固定する
    expect(queryArg.where.OR).toEqual([
      { heartbeatAt: { lt: ctx.serverStartedAt } },
      { heartbeatAt: null, createdAt: { lt: ctx.serverStartedAt } },
    ]);
  });
});

describe('recoverStaleExecutions() — stale 実行あり', () => {
  test('各 stale 実行を interrupted 化し、session/task を巻き戻し、通知を作成する', async () => {
    const exec1 = makeStaleExecution({ id: 1, sessionId: 100 });
    const exec2 = makeStaleExecution({
      id: 2,
      sessionId: 200,
      session: { config: { task: { id: 2000, title: 't2', status: 'in-progress' } } },
    });
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => [exec1, exec2]),
        update: mock(async () => ({})),
        count: mock(async () => 0),
      },
      task: {
        findUnique: mock(async ({ where }: { where: { id: number } }) => {
          if (where.id === 1000) return { id: 1000, status: 'in-progress' };
          if (where.id === 2000) return { id: 2000, status: 'in-progress' };
          return null;
        }),
        update: mock(async () => ({})),
      },
    });
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    expect(result.recoveredExecutions).toBe(2);
    expect(result.interruptedExecutionIds).toEqual([1, 2]);
    expect(result.updatedSessions).toBe(2);
    expect(result.updatedTasks).toBe(2);

    expect(prisma.agentExecution.update).toHaveBeenCalledTimes(2);
    expect(prisma.agentExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ status: 'interrupted' }),
      }),
    );

    expect(prisma.agentSession.update).toHaveBeenCalledTimes(2);
    expect(prisma.task.update).toHaveBeenCalledTimes(2);
    expect(prisma.task.update).toHaveBeenCalledWith({
      where: { id: 1000 },
      data: { status: 'todo' },
    });

    expect(prisma.notification.create).toHaveBeenCalledTimes(1);
    const notifyArg = prisma.notification.create.mock.calls[0][0] as {
      data: { metadata: string };
    };
    expect(JSON.parse(notifyArg.data.metadata)).toEqual({
      recoveredExecutions: 2,
      updatedTasks: 2,
      updatedSessions: 2,
    });
  });

  test('task が存在しない execution は affectedTaskIds に含まれず task 更新をスキップする', async () => {
    const execWithoutTask = makeStaleExecution({
      id: 3,
      sessionId: 300,
      session: { config: { task: null } },
    });
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => [execWithoutTask]),
        update: mock(async () => ({})),
        count: mock(async () => 0),
      },
    });
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    expect(result.recoveredExecutions).toBe(1);
    expect(result.updatedTasks).toBe(0);
    expect(prisma.task.findUnique).not.toHaveBeenCalled();
    // session 巻き戻しはタスクの有無に関係なく行われる
    expect(prisma.agentSession.update).toHaveBeenCalledTimes(1);
  });

  test('task.status が in-progress 以外なら revert しない', async () => {
    const exec = makeStaleExecution({
      id: 4,
      sessionId: 400,
      session: { config: { task: { id: 4000, title: 't4', status: 'blocked' } } },
    });
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => [exec]),
        update: mock(async () => ({})),
        count: mock(async () => 0),
      },
      task: {
        findUnique: mock(async () => ({ id: 4000, status: 'blocked' })),
        update: mock(async () => ({})),
      },
    });
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    expect(result.updatedTasks).toBe(0);
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  test('session に他の生存中の実行が残っていれば session は interrupted 化しない', async () => {
    const exec = makeStaleExecution({ id: 5, sessionId: 500 });
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => [exec]),
        update: mock(async () => ({})),
        count: mock(async () => 1), // NOTE: まだ稼働中の実行がある
      },
    });
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    expect(result.updatedSessions).toBe(0);
    expect(prisma.agentSession.update).not.toHaveBeenCalled();
  });

  test('同一 sessionId の stale 実行が複数あっても重複カウントしない', async () => {
    const exec1 = makeStaleExecution({ id: 6, sessionId: 600 });
    const exec2 = makeStaleExecution({
      id: 7,
      sessionId: 600,
      session: { config: { task: { id: 7000, title: 't7', status: 'todo' } } },
    });
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => [exec1, exec2]),
        update: mock(async () => ({})),
        count: mock(async () => 0),
      },
    });
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    expect(result.updatedSessions).toBe(1);
    expect(prisma.agentSession.update).toHaveBeenCalledTimes(1);
  });

  test('reconcile 済みセッションと本流セッションの和集合が pruneStaleWorktreePointers に渡る', async () => {
    const exec = makeStaleExecution({ id: 8, sessionId: 800 });
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => [exec]),
        update: mock(async () => ({})),
        count: mock(async () => 0),
      },
    });
    reconcileOrphanedBlockedSessionsMock.mockImplementation(async () => ({
      reconciledSessionIds: [900],
    }));
    const ctx = makeCtx(prisma);

    await recoverStaleExecutions(ctx);

    expect(pruneStaleWorktreePointersMock).toHaveBeenCalledWith(ctx, new Set([800, 900]));
  });
});

describe('recoverStaleExecutions() — 後継実行による cancelled/interrupted 分岐', () => {
  test('後継実行があれば cancelled 化され、auto-resume 対象リストに入らない', async () => {
    const exec = makeStaleExecution({ id: 20, sessionId: 2000 });
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => [exec]),
        findFirst: mock(async () => ({ id: 21 })),
        update: mock(async () => ({})),
        count: mock(async () => 0),
      },
    });
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    expect(result.recoveredExecutions).toBe(1);
    expect(result.interruptedExecutionIds).toEqual([]);
    expect(prisma.agentExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 20 },
        data: expect.objectContaining({ status: 'cancelled' }),
      }),
    );
  });

  test('後継判定クエリは auto-resume と同一の status 集合・同一タスクスコープで問い合わせる', async () => {
    const exec = makeStaleExecution({ id: 20, sessionId: 2000 });
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => [exec]),
        findFirst: mock(async () => ({ id: 21 })),
        update: mock(async () => ({})),
        count: mock(async () => 0),
      },
    });
    const ctx = makeCtx(prisma);

    await recoverStaleExecutions(ctx);

    // NOTE: 'completed' を含む集合は auto-resume.ts の後継判定と完全一致させる —
    // ずれると A と auto-resume が後継の解釈で矛盾する
    expect(prisma.agentExecution.findFirst).toHaveBeenCalledWith({
      where: {
        id: { gt: 20 },
        status: { in: ['running', 'pending', 'waiting_for_input', 'completed'] },
        session: { config: { taskId: 1000 } },
      },
      select: { id: true },
    });
  });

  test('後継が無ければ従来どおり interrupted 化され auto-resume 対象リストに入る', async () => {
    const exec = makeStaleExecution({ id: 22, sessionId: 2200 });
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => [exec]),
        findFirst: mock(async () => null),
        update: mock(async () => ({})),
        count: mock(async () => 0),
      },
    });
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    expect(result.interruptedExecutionIds).toEqual([22]);
    expect(prisma.agentExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 22 },
        data: expect.objectContaining({ status: 'interrupted' }),
      }),
    );
  });

  test('taskId が取得できない場合は後継判定せず安全側で interrupted 化する', async () => {
    const exec = makeStaleExecution({
      id: 23,
      sessionId: 2300,
      session: { config: { task: null } },
    });
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => [exec]),
        findFirst: mock(async () => ({ id: 99 })),
        update: mock(async () => ({})),
        count: mock(async () => 0),
      },
    });
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    expect(prisma.agentExecution.findFirst).not.toHaveBeenCalled();
    expect(result.interruptedExecutionIds).toEqual([23]);
    expect(prisma.agentExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 23 },
        data: expect.objectContaining({ status: 'interrupted' }),
      }),
    );
  });
});

describe('recoverStaleExecutions() — 孤児セッションの終端整合', () => {
  test('stale 実行0件の経路でも live 実行を持たない active セッションは interrupted 化される', async () => {
    // 570事例: stale な実行行が無いのにセッションだけ active のまま残るケース
    const prisma = makeMockPrisma({
      agentSession: {
        findMany: mock(async () => [{ id: 42 }]),
        update: mock(async () => ({})),
      },
    });
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    expect(prisma.agentSession.findMany).toHaveBeenCalledWith({
      where: { status: { in: ['active', 'running'] }, createdAt: { lt: ctx.serverStartedAt } },
      select: { id: true },
    });
    expect(prisma.agentSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 42, status: { in: ['active', 'running'] } }),
        data: expect.objectContaining({ status: 'interrupted' }),
      }),
    );
    expect(result.updatedSessions).toBe(1);
  });

  test('live 実行が残る active セッションは是正しない', async () => {
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => []),
        findFirst: mock(async () => null),
        update: mock(async () => ({})),
        count: mock(async () => 1), // NOTE: セッション配下にまだ稼働中の実行がある
      },
      agentSession: {
        findMany: mock(async () => [{ id: 43 }]),
        update: mock(async () => ({})),
      },
    });
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    expect(prisma.agentSession.update).not.toHaveBeenCalled();
    expect(result.updatedSessions).toBe(0);
  });

  test('stale 実行ありの経路でも孤児セッション是正が実行され updatedSessions に合算される', async () => {
    const exec = makeStaleExecution({ id: 24, sessionId: 600 });
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => [exec]),
        findFirst: mock(async () => null),
        update: mock(async () => ({})),
        count: mock(async () => 0),
      },
      agentSession: {
        findMany: mock(async () => [{ id: 42 }]),
        update: mock(async () => ({})),
      },
    });
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    // 本流の session 巻き戻し(600) + 孤児是正(42) の合算
    expect(result.updatedSessions).toBe(2);
    expect(prisma.agentSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 600 }) }),
    );
    expect(prisma.agentSession.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 42 }) }),
    );
  });
});

describe('recoverStaleExecutions() — 個別失敗時のフォールトトレランス', () => {
  test('1件の execution update 失敗が他の execution の復旧を妨げない', async () => {
    const exec1 = makeStaleExecution({ id: 10, sessionId: 1000 });
    const exec2 = makeStaleExecution({
      id: 11,
      sessionId: 1100,
      session: { config: { task: { id: 11000, title: 't11', status: 'in-progress' } } },
    });
    const update = mock(async ({ where }: { where: { id: number } }) => {
      if (where.id === 10) throw new Error('DB write failed');
      return {};
    });
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => [exec1, exec2]),
        update,
        count: mock(async () => 0),
      },
      task: {
        findUnique: mock(async () => ({ id: 11000, status: 'in-progress' })),
        update: mock(async () => ({})),
      },
    });
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    expect(result.recoveredExecutions).toBe(1);
    expect(result.interruptedExecutionIds).toEqual([11]);
    // 失敗した exec1 の sessionId は affectedSessionIds に入らない
    expect(result.updatedSessions).toBe(1);
  });

  test('agentExecution.count 失敗時もクラッシュせず処理を継続する', async () => {
    const exec = makeStaleExecution({ id: 12, sessionId: 1200 });
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => [exec]),
        update: mock(async () => ({})),
        count: mock(async () => {
          throw new Error('count query failed');
        }),
      },
    });
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    expect(result.recoveredExecutions).toBe(1);
    expect(result.updatedSessions).toBe(0);
    expect(prisma.agentSession.update).not.toHaveBeenCalled();
  });

  test('task.findUnique 失敗時もクラッシュせず処理を継続する', async () => {
    const exec = makeStaleExecution({ id: 13, sessionId: 1300 });
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => [exec]),
        update: mock(async () => ({})),
        count: mock(async () => 0),
      },
      task: {
        findUnique: mock(async () => {
          throw new Error('task lookup failed');
        }),
        update: mock(async () => ({})),
      },
    });
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    expect(result.updatedTasks).toBe(0);
    expect(prisma.task.update).not.toHaveBeenCalled();
  });

  test('通知作成の失敗は recoverStaleExecutions 全体を失敗させない', async () => {
    const exec = makeStaleExecution({ id: 14, sessionId: 1400 });
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => [exec]),
        update: mock(async () => ({})),
        count: mock(async () => 0),
      },
      notification: {
        create: mock(async () => {
          throw new Error('notification write failed');
        }),
      },
    });
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    expect(result.recoveredExecutions).toBe(1);
  });

  test('最上位クエリが失敗しても throw せずゼロ値の結果を返す', async () => {
    const prisma = makeMockPrisma({
      agentExecution: {
        findMany: mock(async () => {
          throw new Error('connection lost');
        }),
        update: mock(async () => ({})),
        count: mock(async () => 0),
      },
    });
    const ctx = makeCtx(prisma);

    const result = await recoverStaleExecutions(ctx);

    expect(result).toEqual({
      recoveredExecutions: 0,
      updatedTasks: 0,
      updatedSessions: 0,
      interruptedExecutionIds: [],
      reconciledBlockedSessions: 0,
      prunedWorktreePointers: 0,
    });
    // 最上位 catch に落ちるため reconcile/prune にすら到達しない
    expect(reconcileOrphanedBlockedSessionsMock).not.toHaveBeenCalled();
  });
});

describe('getInterruptedExecutions()', () => {
  test('interrupted ステータスの実行を新しい順・最大50件で問い合わせる', async () => {
    const rows = [
      {
        id: 1,
        sessionId: 1,
        status: 'interrupted',
        claudeSessionId: null,
        output: '',
        createdAt: new Date(),
      },
    ];
    const findMany = mock(async () => rows);
    const prisma = { agentExecution: { findMany } } as unknown as OrchestratorContext['prisma'];

    const result = await getInterruptedExecutions(prisma);

    expect(findMany).toHaveBeenCalledWith({
      where: { status: 'interrupted' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    expect(result).toBe(rows as unknown as typeof result);
  });
});
