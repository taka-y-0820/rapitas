/**
 * auto-run-selection.test.ts
 *
 * Unit tests for the pure selection logic in auto-run-selection.ts.
 * Uses an in-memory mock of the PrismaClient — no live DB required.
 */
import { describe, it, expect, mock } from 'bun:test';
import {
  AUTO_RUN_GLOBAL_MAX_CONCURRENCY,
  HANG_BACKSTOP_HEARTBEAT_MS,
  getGlobalAutoRunActiveCount,
  getThemeActiveQueueItems,
  hasItemAwaitingApproval,
  hasLiveExecution,
  hasScopeOverlap,
  isAwaitingUserAnswer,
  overlappingFiles,
  selectNextTask,
  isTaskBlocked,
  priorityRank,
} from './auto-run-selection';
import type { PrismaClient } from '../../../generated/prisma-postgres';

// ---------------------------------------------------------------------------
// Minimal Prisma mock
// ---------------------------------------------------------------------------

function makePrisma(overrides: Partial<Record<string, unknown>> = {}): PrismaClient {
  return {
    workflowQueueItem: {
      count: mock().mockResolvedValue(0),
      findMany: mock().mockResolvedValue([]),
    },
    task: {
      findMany: mock().mockResolvedValue([]),
    },
    // Selection reads the global workflow off-switch before querying candidates.
    userSettings: {
      findFirst: mock().mockResolvedValue({ workflowDisabledGlobally: false }),
    },
    ...overrides,
  } as unknown as PrismaClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('priorityRank', () => {
  it('null / undefined / 空文字 は medium (2) として扱われる', () => {
    expect(priorityRank(null)).toBe(2);
    expect(priorityRank(undefined)).toBe(2);
    expect(priorityRank('')).toBe(2);
  });

  it('PRIORITY_RANK に存在しない文字列（NaN, critical 等）は medium (2) にフォールバックする', () => {
    expect(priorityRank('NaN')).toBe(2);
    expect(priorityRank('critical')).toBe(2);
  });

  it('大文字・混合大文字の優先度文字列は toLowerCase() で正規化される', () => {
    // toLowerCase() が効いていることを確認
    expect(priorityRank('URGENT')).toBe(0);
    expect(priorityRank('High')).toBe(1);
    expect(priorityRank('MEDIUM')).toBe(2);
    expect(priorityRank('LOW')).toBe(3);
  });

  it('全優先度の数値ランクが正しい（urgent < high < medium < low）', () => {
    expect(priorityRank('urgent')).toBe(0);
    expect(priorityRank('high')).toBe(1);
    expect(priorityRank('medium')).toBe(2);
    expect(priorityRank('low')).toBe(3);
  });
});

describe('isTaskBlocked', () => {
  it('returns true for blocked status', () => {
    expect(isTaskBlocked('blocked')).toBe(true);
  });

  it('returns false for todo/in-progress', () => {
    expect(isTaskBlocked('todo')).toBe(false);
    expect(isTaskBlocked('in-progress')).toBe(false);
    expect(isTaskBlocked('done')).toBe(false);
  });
});

describe('isAwaitingUserAnswer', () => {
  it.each([
    {
      name: 'workflowStatus is awaiting_question, even with no live AgentExecution question',
      workflowStatus: 'awaiting_question',
      liveQuestion: null,
      expected: true,
    },
    {
      name: 'the latest AgentExecution carries a live pending question',
      workflowStatus: 'in_progress',
      liveQuestion: '選択肢Aと選択肢B、どちらですか？',
      expected: true,
    },
    {
      name: 'neither an intake question.md pause nor a live question is pending',
      workflowStatus: 'in_progress',
      liveQuestion: null,
      expected: false,
    },
  ])('returns $expected when $name', async ({ workflowStatus, liveQuestion, expected }) => {
    const prisma = makePrisma({
      task: { findUnique: mock().mockResolvedValue({ workflowStatus }) },
      agentExecution: { findFirst: mock().mockResolvedValue({ question: liveQuestion }) },
    });
    expect(await isAwaitingUserAnswer(prisma, 1)).toBe(expected);
  });
});

describe('hasLiveExecution (hang backstop liveness — task 563)', () => {
  it('returns true when a running execution has a fresh heartbeat', async () => {
    const findFirst = mock().mockResolvedValue({ id: 99 });
    const prisma = makePrisma({ agentExecution: { findFirst } });
    expect(await hasLiveExecution(prisma, 563)).toBe(true);
    // The query must require status running AND heartbeat freshness.
    const arg = findFirst.mock.calls[0]?.[0] as {
      where: { status: string; heartbeatAt: { gte: Date } };
    };
    expect(arg.where.status).toBe('running');
    const minGte = Date.now() - HANG_BACKSTOP_HEARTBEAT_MS - 2000;
    expect(arg.where.heartbeatAt.gte.getTime()).toBeGreaterThan(minGte);
  });

  it('returns false when no fresh-heartbeat running execution exists (genuine hang)', async () => {
    const prisma = makePrisma({
      agentExecution: { findFirst: mock().mockResolvedValue(null) },
    });
    expect(await hasLiveExecution(prisma, 563)).toBe(false);
  });

  it('fails closed (not-live) on a DB error so the backstop still guards real hangs', async () => {
    const prisma = makePrisma({
      agentExecution: { findFirst: mock().mockRejectedValue(new Error('db down')) },
    });
    expect(await hasLiveExecution(prisma, 563)).toBe(false);
  });
});

describe('hasItemAwaitingApproval', () => {
  it.each([
    {
      name: 'when any item is waiting_approval',
      items: [{ status: 'running' }, { status: 'waiting_approval' }],
      expected: true,
    },
    {
      name: 'when no item is waiting_approval',
      items: [{ status: 'running' }, { status: 'queued' }],
      expected: false,
    },
    { name: 'for empty array', items: [], expected: false },
  ])('returns $expected $name', ({ items, expected }) => {
    expect(hasItemAwaitingApproval(items)).toBe(expected);
  });
});

describe('getGlobalAutoRunActiveCount', () => {
  it('calls count with themeId not null and active statuses', async () => {
    const mockCount = mock().mockResolvedValue(2);
    const prisma = makePrisma({
      workflowQueueItem: { count: mockCount, findMany: mock() },
    });
    const result = await getGlobalAutoRunActiveCount(prisma);
    expect(result).toBe(2);
    expect(mockCount).toHaveBeenCalledWith({
      where: {
        themeId: { not: null },
        status: { in: ['queued', 'running', 'waiting_approval'] },
      },
    });
  });
});

describe('getThemeActiveQueueItems', () => {
  it('scopes query to themeId and active statuses', async () => {
    const mockFindMany = mock().mockResolvedValue([{ id: 1, taskId: 42, status: 'running' }]);
    const prisma = makePrisma({
      workflowQueueItem: { findMany: mockFindMany, count: mock() },
    });
    const items = await getThemeActiveQueueItems(prisma, 7);
    expect(items).toHaveLength(1);
    expect(mockFindMany).toHaveBeenCalledWith({
      where: { themeId: 7, status: { in: ['queued', 'running', 'waiting_approval'] } },
      select: { id: true, taskId: true, status: true },
    });
  });
});

describe('selectNextTask', () => {
  it.each([
    {
      desc: 'returns concurrency_limit when globalActiveCount >= MAX',
      tasks: [] as Record<string, unknown>[],
      activeCount: AUTO_RUN_GLOBAL_MAX_CONCURRENCY,
      expected: { found: false, reason: 'concurrency_limit' },
    },
    {
      desc: 'returns all_done when no eligible tasks exist',
      tasks: [],
      activeCount: 0,
      expected: { found: false, reason: 'all_done' },
    },
    {
      desc: 'returns found with taskId for an eligible task',
      tasks: [
        {
          id: 10,
          status: 'todo',
          workflowStatus: 'draft',
          priority: 'high',
          createdAt: new Date(),
        },
      ],
      activeCount: 0,
      expected: { found: true, taskId: 10 },
    },
  ])('$desc', async ({ tasks, activeCount, expected }) => {
    const mockFindMany = mock().mockResolvedValue(tasks);
    const prisma = makePrisma({ task: { findMany: mockFindMany } });
    const result = await selectNextTask(prisma, 1, 'priority', [], activeCount);
    expect(result).toEqual(expected);
  });

  it('回帰: 質問待ちのタスクは todo でも選択対象から外す', async () => {
    // 実測 2026-08-24: task 635 が status='todo' / workflowStatus='awaiting_question'
    // で選択され、orchestrator が「awaiting_question では次のフェーズを実行できません」
    // で拒否 → キュー項目が cancelled → 再選択、を21分で106回繰り返した。
    // 選択側と実行側の「実行可能」の定義が食い違っていたのが原因。
    const mockFindMany = mock().mockResolvedValue([]);
    const prisma = makePrisma({ task: { findMany: mockFindMany } });
    await selectNextTask(prisma, 1, 'priority', [], 0);
    const arg = mockFindMany.mock.calls[0][0] as {
      where: { AND?: Array<Record<string, unknown>> };
    };
    const clauses = arg.where.AND ?? [];
    expect(clauses).toContainEqual({
      OR: [{ workflowStatus: null }, { workflowStatus: { not: 'awaiting_question' } }],
    });
  });

  it('回帰: 全体停止スイッチONなら候補を引かずに専用の理由を返す', async () => {
    // 'all_done' として返すとバックログ補充が走り、同じく実行できないタスクを
    // 起票して枠を食い潰す。停止は「仕事が無い」とは別の状態として報告する。
    const mockFindMany = mock().mockResolvedValue([]);
    const prisma = makePrisma({
      task: { findMany: mockFindMany },
      userSettings: { findFirst: mock().mockResolvedValue({ workflowDisabledGlobally: true }) },
    });

    const result = await selectNextTask(prisma, 1, 'priority', [], 0);

    expect(result).toEqual({ found: false, reason: 'workflow_disabled_globally' });
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it('回帰: ワークフロー無効のタスクは選択対象から外す', async () => {
    // 実測 2026-08-26: task 635 が workflowDisabled=true / priority=high で
    // 選択され、runner が「ワークフロー無効モードのため自動実行の対象外」で拒否
    // → 解放 → 再選択、を約20秒周期で11時間繰り返した。他のタスクは一切進まず、
    // 枯渇に到達しないため起票も走らず、未対応の懸念121件が放置された。
    // awaiting_question とまったく同じ「選択側と実行側の定義の食い違い」。
    const mockFindMany = mock().mockResolvedValue([]);
    const prisma = makePrisma({ task: { findMany: mockFindMany } });
    await selectNextTask(prisma, 1, 'priority', [], 0);
    const arg = mockFindMany.mock.calls[0][0] as { where: { workflowDisabled?: boolean } };
    expect(arg.where.workflowDisabled).toBe(false);
  });

  it('回帰: workflowStatus が未設定(NULL)の新規タスクを除外しない', async () => {
    // `NOT { workflowStatus: 'x' }` は NULL 列に対して UNKNOWN になり、
    // 起票直後（workflowStatus 未設定）のタスクを全て弾いていた。実測
    // 2026-08-24: テーマ1に todo 10件あるのに選択は0件を返し、
    // resumed→idle→resumed を延々と繰り返した。null 分岐は必須。
    const mockFindMany = mock().mockResolvedValue([]);
    const prisma = makePrisma({ task: { findMany: mockFindMany } });
    await selectNextTask(prisma, 1, 'priority', [], 0);
    const arg = mockFindMany.mock.calls[0][0] as {
      where: { AND?: Array<Record<string, unknown>> };
    };
    const guard = (arg.where.AND ?? []).find((c) => 'OR' in c) as
      | { OR: Array<Record<string, unknown>> }
      | undefined;
    expect(guard?.OR).toContainEqual({ workflowStatus: null });
  });

  it('keeps a todo task eligible even with a terminal workflowStatus (re-run)', async () => {
    // Regression: a todo task whose workflowStatus is verify_done/completed
    // (status reset to re-run, or a verify that did not finalize) was excluded,
    // so the theme idled with this task still pending.
    const mockFindMany = mock().mockResolvedValue([
      {
        id: 232,
        status: 'todo',
        workflowStatus: 'verify_done',
        priority: 'medium',
        createdAt: new Date(),
      },
    ]);
    const prisma = makePrisma({ task: { findMany: mockFindMany } });
    const result = await selectNextTask(prisma, 1, 'priority', [], 0);
    expect(result).toEqual({ found: true, taskId: 232 });
    // The where clause must allow a 'todo' row through regardless of workflowStatus.
    // The eligibility clauses now sit under AND (the awaiting_question guard
    // needed its own OR), so read the first branch rather than where.OR.
    const where = mockFindMany.mock.calls[0][0].where as { AND: Array<{ OR?: unknown[] }> };
    expect(where.AND[0]?.OR).toEqual(expect.arrayContaining([{ status: 'todo' }]));
  });

  it('skips blocked tasks', async () => {
    const tasks = [
      {
        id: 10,
        status: 'blocked',
        workflowStatus: 'draft',
        priority: 'high',
        createdAt: new Date(),
      },
      {
        id: 11,
        status: 'todo',
        workflowStatus: 'draft',
        priority: 'medium',
        createdAt: new Date(),
      },
    ];
    const mockFindMany = mock().mockResolvedValue(tasks);
    const prisma = makePrisma({ task: { findMany: mockFindMany } });
    const result = await selectNextTask(prisma, 1, 'priority', [], 0);
    expect(result).toEqual({ found: true, taskId: 11 });
  });

  it('skips tasks in skipTaskIds', async () => {
    const tasks = [
      {
        id: 5,
        status: 'todo',
        workflowStatus: 'in_progress',
        priority: 'high',
        createdAt: new Date(),
      },
    ];
    const mockFindMany = mock().mockResolvedValue(tasks);
    const prisma = makePrisma({ task: { findMany: mockFindMany } });
    await selectNextTask(prisma, 1, 'priority', [5], 0);
    // findMany is called with id: { notIn: [5] } so the mock still returns it;
    // but in a real DB it would be filtered. We verify the where clause instead.
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { notIn: [5] } }),
      }),
    );
  });

  it('passes correct orderBy for "created" order', async () => {
    const mockFindMany = mock().mockResolvedValue([]);
    const prisma = makePrisma({ task: { findMany: mockFindMany } });
    await selectNextTask(prisma, 1, 'created', [], 0);
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ createdAt: 'asc' }] }),
    );
  });

  it('ranks string priority in JS (DB orderBy stays createdAt-asc)', async () => {
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    const tasks = [
      { id: 1, status: 'todo', workflowStatus: null, priority: 'low', createdAt: new Date(base) },
      {
        id: 2,
        status: 'todo',
        workflowStatus: null,
        priority: 'urgent',
        createdAt: new Date(base + 1000),
      },
      {
        id: 3,
        status: 'todo',
        workflowStatus: null,
        priority: 'high',
        createdAt: new Date(base + 2000),
      },
    ];
    const mockFindMany = mock().mockResolvedValue(tasks);
    const prisma = makePrisma({ task: { findMany: mockFindMany } });
    const result = await selectNextTask(prisma, 1, 'priority', [], 0);
    // urgent wins even though it is neither first nor oldest — proves JS ranking,
    // not the broken SQL string `desc` (which would have picked 'urgent'>'medium'>'low'>'high').
    expect(result).toEqual({ found: true, taskId: 2 });
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ createdAt: 'asc' }] }),
    );
  });

  it('breaks a priority tie by creation order (oldest first)', async () => {
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    const tasks = [
      {
        id: 10,
        status: 'todo',
        workflowStatus: null,
        priority: 'high',
        createdAt: new Date(base + 5000),
      },
      {
        id: 11,
        status: 'todo',
        workflowStatus: null,
        priority: 'high',
        createdAt: new Date(base + 1000),
      },
    ];
    const prisma = makePrisma({ task: { findMany: mock().mockResolvedValue(tasks) } });
    const result = await selectNextTask(prisma, 1, 'priority', [], 0);
    expect(result).toEqual({ found: true, taskId: 11 });
  });

  it('keeps fresh todo tasks (null workflowStatus) eligible', async () => {
    // Regression: `notIn` alone drops NULLs in SQL, which skipped brand-new tasks.
    // The where clause must OR-in `workflowStatus: null`.
    const mockFindMany = mock().mockResolvedValue([]);
    const prisma = makePrisma({ task: { findMany: mockFindMany } });
    await selectNextTask(prisma, 1, 'priority', [], 0);
    const arg = mockFindMany.mock.calls[0]![0] as {
      where: { AND?: Array<{ OR?: unknown[] }> };
    };
    expect(arg.where.AND?.[0]?.OR).toEqual(expect.arrayContaining([{ workflowStatus: null }]));
  });
});

describe('selectNextTask all_blocked vs all_done (task 615)', () => {
  it('候補ゼロ + blocked が残っている → all_blocked（閉塞を通常の枯渇と区別する）', async () => {
    const count = mock().mockResolvedValue(3);
    const prisma = makePrisma({
      task: { findMany: mock().mockResolvedValue([]), count },
    });
    const result = await selectNextTask(prisma, 1, 'priority', [], 0);
    expect(result).toEqual({ found: false, reason: 'all_blocked' });
    // blocked 件数はテーマ内トップレベルのみを数えること
    expect(count).toHaveBeenCalledWith({
      where: { themeId: 1, status: 'blocked', parentId: null },
    });
  });

  it('候補ゼロ + blocked ゼロ → 従来どおり all_done', async () => {
    const prisma = makePrisma({
      task: { findMany: mock().mockResolvedValue([]), count: mock().mockResolvedValue(0) },
    });
    const result = await selectNextTask(prisma, 1, 'priority', [], 0);
    expect(result).toEqual({ found: false, reason: 'all_done' });
  });

  it('count が失敗しても all_done へフォールバックする（fail-open）', async () => {
    const prisma = makePrisma({
      task: {
        findMany: mock().mockResolvedValue([]),
        count: mock().mockRejectedValue(new Error('db down')),
      },
    });
    const result = await selectNextTask(prisma, 1, 'priority', [], 0);
    expect(result).toEqual({ found: false, reason: 'all_done' });
  });

  it('count 未実装のモック（旧テスト互換）でも例外にならず all_done', async () => {
    // makePrisma の既定 task には count が無い — TypeError も握り潰されること
    const prisma = makePrisma();
    const result = await selectNextTask(prisma, 1, 'priority', [], 0);
    expect(result).toEqual({ found: false, reason: 'all_done' });
  });
});

describe('hasScopeOverlap / overlappingFiles (task 573 B)', () => {
  it('exact path match overlaps', () => {
    expect(hasScopeOverlap(['services/workflow/a.ts'], ['services/workflow/a.ts'])).toBe(true);
  });

  it('depth-difference suffix match overlaps (repo-relative vs package-relative)', () => {
    expect(hasScopeOverlap(['services/a.ts'], ['rapitas-backend/services/a.ts'])).toBe(true);
    expect(hasScopeOverlap(['rapitas-backend/services/a.ts'], ['services/a.ts'])).toBe(true);
  });

  it('suffix match is path-boundary safe (foo/ab.ts must NOT match b.ts)', () => {
    expect(hasScopeOverlap(['b.ts'], ['foo/ab.ts'])).toBe(false);
    expect(hasScopeOverlap(['foo/ab.ts'], ['b.ts'])).toBe(false);
  });

  it('directory tokens (trailing /) from parsePlanFiles are excluded', () => {
    // Shared-dir prefixes would defer every candidate → starvation (premortem #2).
    expect(hasScopeOverlap(['services/workflow/'], ['services/workflow/a.ts'])).toBe(false);
  });

  it('disjoint files do not overlap', () => {
    expect(hasScopeOverlap(['services/a.ts'], ['routes/b.ts'])).toBe(false);
    expect(hasScopeOverlap([], ['routes/b.ts'])).toBe(false);
  });

  it('backslash paths are normalized before matching', () => {
    expect(hasScopeOverlap(['services\\workflow\\a.ts'], ['services/workflow/a.ts'])).toBe(true);
  });

  it('overlappingFiles returns the deduped open-PR side of each overlap', () => {
    expect(
      overlappingFiles(
        ['services/a.ts', 'services/b.ts', 'services/'],
        ['rapitas-backend/services/a.ts', 'routes/x.ts'],
      ),
    ).toEqual(['rapitas-backend/services/a.ts']);
  });
});

describe('selectNextTask with scopeOverlap (task 573 B)', () => {
  const base = new Date('2026-01-01T00:00:00Z').getTime();
  const mkTask = (id: number, offsetMs: number) => ({
    id,
    status: 'todo',
    workflowStatus: null,
    priority: 'medium',
    createdAt: new Date(base + offsetMs),
  });

  it('defers an overlapping head candidate and selects the first non-overlapping one', async () => {
    const prisma = makePrisma({
      task: { findMany: mock().mockResolvedValue([mkTask(100, 0), mkTask(101, 1000)]) },
    });
    const planByTask: Record<number, string[]> = {
      100: ['services/workflow/workflow-context-builder.ts'],
      101: ['routes/other.ts'],
    };
    const result = await selectNextTask(prisma, 1, 'priority', [], 0, null, {
      openPrFiles: ['rapitas-backend/services/workflow/workflow-context-builder.ts'],
      getPlanFiles: async (id) => planByTask[id] ?? [],
    });
    expect(result).toEqual({ found: true, taskId: 101, deferred: [100] });
  });

  it('selects a non-overlapping head immediately without a deferred field', async () => {
    const prisma = makePrisma({
      task: { findMany: mock().mockResolvedValue([mkTask(100, 0), mkTask(101, 1000)]) },
    });
    const result = await selectNextTask(prisma, 1, 'priority', [], 0, null, {
      openPrFiles: ['services/x.ts'],
      getPlanFiles: async () => ['routes/unrelated.ts'],
    });
    expect(result).toEqual({ found: true, taskId: 100 });
  });

  it('falls back to the head when EVERY candidate overlaps (starvation guard)', async () => {
    const prisma = makePrisma({
      task: { findMany: mock().mockResolvedValue([mkTask(100, 0), mkTask(101, 1000)]) },
    });
    const result = await selectNextTask(prisma, 1, 'priority', [], 0, null, {
      openPrFiles: ['services/x.ts'],
      getPlanFiles: async () => ['services/x.ts'],
    });
    expect(result).toEqual({ found: true, taskId: 100 });
    expect((result as { deferred?: number[] }).deferred).toBeUndefined();
  });

  it('an in-progress candidate is never deferred (it already owns a worktree)', async () => {
    // 2026-09-13: task 905 (in-progress, mid verify-repair) sat deferred every
    // tick behind exhausted open PRs while a fresh todo task was started.
    const prisma = makePrisma({
      task: {
        findMany: mock().mockResolvedValue([
          { ...mkTask(100, 0), status: 'in-progress', workflowStatus: 'plan_approved' },
          mkTask(101, 1000),
        ]),
      },
    });
    const result = await selectNextTask(prisma, 1, 'priority', [], 0, null, {
      openPrFiles: ['services/x.ts'],
      getPlanFiles: async () => ['services/x.ts'], // everything overlaps
    });
    expect(result).toEqual({ found: true, taskId: 100 });
  });

  it('a plan-less (lightweight) candidate is never deferred', async () => {
    const prisma = makePrisma({
      task: { findMany: mock().mockResolvedValue([mkTask(100, 0)]) },
    });
    const result = await selectNextTask(prisma, 1, 'priority', [], 0, null, {
      openPrFiles: ['services/x.ts'],
      getPlanFiles: async () => [], // no plan row → empty list
    });
    expect(result).toEqual({ found: true, taskId: 100 });
  });

  it('a throwing getPlanFiles is treated as no plan (fail-open)', async () => {
    const prisma = makePrisma({
      task: { findMany: mock().mockResolvedValue([mkTask(100, 0)]) },
    });
    const result = await selectNextTask(prisma, 1, 'priority', [], 0, null, {
      openPrFiles: ['services/x.ts'],
      getPlanFiles: async () => {
        throw new Error('db down');
      },
    });
    expect(result).toEqual({ found: true, taskId: 100 });
  });

  it('empty openPrFiles keeps legacy behavior (no getPlanFiles calls)', async () => {
    const getPlanFiles = mock().mockResolvedValue(['services/x.ts']);
    const prisma = makePrisma({
      task: { findMany: mock().mockResolvedValue([mkTask(100, 0)]) },
    });
    const result = await selectNextTask(prisma, 1, 'priority', [], 0, null, {
      openPrFiles: [],
      getPlanFiles,
    });
    expect(result).toEqual({ found: true, taskId: 100 });
    expect(getPlanFiles).not.toHaveBeenCalled();
  });
});

describe('valueBandScore (R6 learnable band)', () => {
  it('成功率シグナルが無ければ 0（レガシー順序を維持）', async () => {
    const { valueBandScore } = await import('./auto-run-selection');
    expect(valueBandScore(50, null)).toBe(0);
    expect(valueBandScore(null, null)).toBe(0);
  });

  it('帯の中心に近い複雑度ほど高スコア', async () => {
    const { valueBandScore } = await import('./auto-run-selection');
    // successRate 0.5 → target 50
    expect(valueBandScore(50, 0.5)).toBeGreaterThan(valueBandScore(90, 0.5));
    expect(valueBandScore(50, 0.5)).toBeGreaterThan(valueBandScore(10, 0.5));
  });

  it('成功率が高いほど帯が高複雑度側へ動く', async () => {
    const { valueBandScore } = await import('./auto-run-selection');
    // cruising (rate 1.0 → target 80): 80 beats 30
    expect(valueBandScore(80, 1.0)).toBeGreaterThan(valueBandScore(30, 1.0));
    // struggling (rate 0 → target 20): 20 beats 80
    expect(valueBandScore(20, 0)).toBeGreaterThan(valueBandScore(80, 0));
  });

  it('複雑度未評価は固定の中間ペナルティ (-0.3)', async () => {
    const { valueBandScore } = await import('./auto-run-selection');
    expect(valueBandScore(null, 0.5)).toBe(-0.3);
    // in-band evidence beats unknown; unknown beats far out-of-band
    expect(valueBandScore(50, 0.5)).toBeGreaterThan(valueBandScore(null, 0.5));
    expect(valueBandScore(null, 0.5)).toBeGreaterThan(valueBandScore(100, 0.0));
  });

  it('selectNextTask: 同一優先度では帯に近いタスクが選ばれる', async () => {
    const base = Date.now();
    const tasks = [
      {
        id: 30,
        status: 'todo',
        workflowStatus: null,
        priority: 'medium',
        createdAt: new Date(base), // older, but far out of band
        complexityScore: 95,
      },
      {
        id: 31,
        status: 'todo',
        workflowStatus: null,
        priority: 'medium',
        createdAt: new Date(base + 1000),
        complexityScore: 50, // in band for successRate 0.5
      },
    ];
    const prisma = makePrisma({ task: { findMany: mock().mockResolvedValue(tasks) } });
    const result = await selectNextTask(prisma, 1, 'priority', [], 0, 0.5);
    expect(result).toEqual({ found: true, taskId: 31 });
  });

  it('selectNextTask: successRate 未指定なら従来どおり作成順', async () => {
    const base = Date.now();
    const tasks = [
      {
        id: 40,
        status: 'todo',
        workflowStatus: null,
        priority: 'medium',
        createdAt: new Date(base),
        complexityScore: 95,
      },
      {
        id: 41,
        status: 'todo',
        workflowStatus: null,
        priority: 'medium',
        createdAt: new Date(base + 1000),
        complexityScore: 50,
      },
    ];
    const prisma = makePrisma({ task: { findMany: mock().mockResolvedValue(tasks) } });
    const result = await selectNextTask(prisma, 1, 'priority', [], 0);
    expect(result).toEqual({ found: true, taskId: 40 });
  });
});
