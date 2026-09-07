/**
 * concern-backlog-service.test
 *
 * Tests for the concern backlog service:
 * - Pure coercion helpers (normalizeConcernType, normalizeConcernSeverity)
 * - DB-backed functions (markConcernResolved, getConcern, listConcerns,
 *   getConcernStats) with prisma mocked
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock declarations are hoisted by bun before static imports.
const mockKnowledgeEntryFindFirst = mock(() => Promise.resolve(null));
const mockKnowledgeEntryFindMany = mock(() => Promise.resolve([]));
const mockKnowledgeEntryCount = mock(() => Promise.resolve(0));
const mockKnowledgeEntryGroupBy = mock(() => Promise.resolve([]));
const mockKnowledgeEntryUpdate = mock(() => Promise.resolve({}));
const mockKnowledgeEntryCreate = mock(() => Promise.resolve({ id: 1 }));
const mockKnowledgeEntryDelete = mock(() => Promise.resolve({}));

const mockGitHubIssueFindMany = mock(() => Promise.resolve([]));
const mockThemeFindFirst = mock(() => Promise.resolve(null));
// theme-resolution.ts's resolveDefaultThemeId reads ALL themes via findMany
// (working-dir-aware ranking), not the single-row findFirst the old local
// concern-backlog-service implementation used.
const mockThemeFindMany = mock(() => Promise.resolve([] as Record<string, unknown>[]));
const mockTaskFindUnique = mock(() => Promise.resolve(null as Record<string, unknown> | null));

mock.module('../../config/database', () => ({
  ensureDatabaseConnection: () => Promise.resolve(),
  prisma: {
    knowledgeEntry: {
      findFirst: mockKnowledgeEntryFindFirst,
      findMany: mockKnowledgeEntryFindMany,
      count: mockKnowledgeEntryCount,
      groupBy: mockKnowledgeEntryGroupBy,
      update: mockKnowledgeEntryUpdate,
      create: mockKnowledgeEntryCreate,
      delete: mockKnowledgeEntryDelete,
    },
    gitHubIssue: {
      findMany: mockGitHubIssueFindMany,
    },
    theme: {
      findFirst: mockThemeFindFirst,
      findMany: mockThemeFindMany,
    },
    task: {
      findUnique: mockTaskFindUnique,
    },
  },
}));

mock.module('../../config/logger', () => ({
  createLogger: () => ({
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }),
}));

mock.module('../task/task-mutations', () => ({
  createTask: mock(() => Promise.resolve({ id: 100 })),
}));

const {
  CONCERN_TYPES,
  CONCERN_SEVERITIES,
  normalizeConcernType,
  normalizeConcernSeverity,
  markConcernResolved,
  getConcern,
  setConcernStatus,
  deleteConcern,
  convertConcernToTask,
  listConcerns,
  getConcernStats,
  submitConcern,
} = await import('./concern-backlog-service');

const { isConcernType, isConcernSeverity } =
  await import('./concern-backlog-service.guards.generated');

// ─── Reset helper ──────────────────────────────────────────────────────────────

function resetMocks() {
  mockKnowledgeEntryFindFirst.mockReset().mockResolvedValue(null);
  mockKnowledgeEntryFindMany.mockReset().mockResolvedValue([]);
  mockKnowledgeEntryCount.mockReset().mockResolvedValue(0);
  mockKnowledgeEntryGroupBy.mockReset().mockResolvedValue([]);
  mockKnowledgeEntryUpdate.mockReset().mockResolvedValue({});
  mockKnowledgeEntryCreate.mockReset().mockResolvedValue({ id: 1 });
  mockKnowledgeEntryDelete.mockReset().mockResolvedValue({});
  mockGitHubIssueFindMany.mockReset().mockResolvedValue([]);
  mockThemeFindFirst.mockReset().mockResolvedValue(null);
  mockThemeFindMany.mockReset().mockResolvedValue([]);
  mockTaskFindUnique.mockReset().mockResolvedValue(null);
}

// ─── Pure helper tests ────────────────────────────────────────────────────────

describe('normalizeConcernType', () => {
  it.each(['bug', 'refactor', 'security', 'perf', 'other'] as const)(
    'accepts valid type "%s"',
    (t: 'bug' | 'refactor' | 'security' | 'perf' | 'other') =>
      expect(normalizeConcernType(t)).toBe(t),
  );

  it.each([
    { name: 'unknown string to "bug"', input: 'unknown' },
    { name: 'undefined to "bug"', input: undefined },
    { name: 'null to "bug"', input: null },
  ])('defaults $name', ({ input }) => {
    expect(normalizeConcernType(input)).toBe('bug');
  });
});

describe('normalizeConcernSeverity', () => {
  it.each(['urgent', 'high', 'medium', 'low'] as const)(
    'accepts valid severity "%s"',
    (s: 'urgent' | 'high' | 'medium' | 'low') => expect(normalizeConcernSeverity(s)).toBe(s),
  );

  it('defaults unknown string to "medium"', () => {
    expect(normalizeConcernSeverity('critical')).toBe('medium');
  });

  it('defaults undefined to "medium"', () => {
    expect(normalizeConcernSeverity(undefined)).toBe('medium');
  });
});

// ─── markConcernResolved ──────────────────────────────────────────────────────

describe('markConcernResolved', () => {
  beforeEach(resetMocks);

  it('open → resolved: update を呼んで true を返す', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue({ id: 1, sourceId: 'open' });

    const result = await markConcernResolved(1, true);

    expect(result).toBe(true);
    expect(mockKnowledgeEntryUpdate).toHaveBeenCalledTimes(1);
    const call = mockKnowledgeEntryUpdate.mock.calls[0][0];
    expect(call.data.sourceId).toBe('resolved');
  });

  it('resolved → open: update を呼んで true を返す', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue({ id: 1, sourceId: 'resolved' });

    const result = await markConcernResolved(1, false);

    expect(result).toBe(true);
    const call = mockKnowledgeEntryUpdate.mock.calls[0][0];
    expect(call.data.sourceId).toBe('open');
  });

  it('dismissed の concern は変更しない (false を返す)', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue({ id: 1, sourceId: 'dismissed' });

    const result = await markConcernResolved(1, true);

    expect(result).toBe(false);
    expect(mockKnowledgeEntryUpdate).not.toHaveBeenCalled();
  });

  it('task_created の concern は変更しない (false を返す)', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue({ id: 1, sourceId: 'task_42' });

    const result = await markConcernResolved(1, true);

    expect(result).toBe(false);
    expect(mockKnowledgeEntryUpdate).not.toHaveBeenCalled();
  });

  it('open → open (resolved=false): ガードに引っかかり false を返す', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue({ id: 1, sourceId: 'open' });

    const result = await markConcernResolved(1, false);

    expect(result).toBe(false);
    expect(mockKnowledgeEntryUpdate).not.toHaveBeenCalled();
  });

  it('concern が見つからない場合は false を返す', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue(null);

    const result = await markConcernResolved(999, true);

    expect(result).toBe(false);
    expect(mockKnowledgeEntryUpdate).not.toHaveBeenCalled();
  });
});

// ─── setConcernStatus / deleteConcern / convertConcernToTask — concernId 境界値 ──
// Regression coverage for #744: an out-of-range concernId (e.g. a huge float
// parsed from a route param) must never reach `prisma.knowledgeEntry` — Prisma
// throws PrismaClientValidationError ("Unable to fit value ... into a 64-bit
// signed integer") when it does, which previously reached the DB unguarded.

const OUT_OF_RANGE_CONCERN_ID = 6.0316055619162455e31;

describe('setConcernStatus', () => {
  beforeEach(resetMocks);

  it('範囲外の concernId は findFirst を呼ばず false を返す', async () => {
    const result = await setConcernStatus(OUT_OF_RANGE_CONCERN_ID, 'dismissed');

    expect(result).toBe(false);
    expect(mockKnowledgeEntryFindFirst).not.toHaveBeenCalled();
    expect(mockKnowledgeEntryUpdate).not.toHaveBeenCalled();
  });

  it('存在する concern のステータスを更新して true を返す', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue({ id: 1 });

    const result = await setConcernStatus(1, 'dismissed');

    expect(result).toBe(true);
    const call = mockKnowledgeEntryUpdate.mock.calls[0][0];
    expect(call.data.sourceId).toBe('dismissed');
  });

  it('concern が見つからない場合は false を返す', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue(null);

    const result = await setConcernStatus(999, 'open');

    expect(result).toBe(false);
    expect(mockKnowledgeEntryUpdate).not.toHaveBeenCalled();
  });
});

describe('deleteConcern', () => {
  beforeEach(resetMocks);

  it('範囲外の concernId は findFirst を呼ばず false を返す', async () => {
    const result = await deleteConcern(OUT_OF_RANGE_CONCERN_ID);

    expect(result).toBe(false);
    expect(mockKnowledgeEntryFindFirst).not.toHaveBeenCalled();
  });

  it('存在する concern を削除して true を返す', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue({ id: 1 });

    const result = await deleteConcern(1);

    expect(result).toBe(true);
  });

  it('concern が見つからない場合は false を返す', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue(null);

    const result = await deleteConcern(999);

    expect(result).toBe(false);
  });
});

describe('convertConcernToTask', () => {
  const CONCERN_ROW = {
    id: 1,
    title: 'Auth flaw',
    content: 'JWT not validated',
    category: 'security',
    tags: '["severity:high"]',
    sourceId: 'open',
    themeId: 5,
    taskId: null,
    createdAt: new Date(),
  };

  beforeEach(resetMocks);

  it('範囲外の concernId は findFirst を呼ばず null を返す', async () => {
    const result = await convertConcernToTask(OUT_OF_RANGE_CONCERN_ID);

    expect(result).toBeNull();
    expect(mockKnowledgeEntryFindFirst).not.toHaveBeenCalled();
  });

  it('concern が見つからない場合は null を返す', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue(null);

    const result = await convertConcernToTask(999);

    expect(result).toBeNull();
  });

  it('既にタスク化済みの concern は例外を投げる', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue({ ...CONCERN_ROW, sourceId: 'task_42' });

    await expect(convertConcernToTask(1)).rejects.toThrow('この懸念は既にタスク化されています');
  });

  it('未タスク化の concern をタスクへ変換し taskId を返す', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue(CONCERN_ROW);

    const result = await convertConcernToTask(1);

    expect(result).toBe(100);
    const call = mockKnowledgeEntryUpdate.mock.calls[0][0];
    expect(call.data.sourceId).toBe('task_100');
  });
});

// ─── submitConcern — theme attribution ─────────────────────────────────────────

describe('submitConcern — theme attribution', () => {
  beforeEach(resetMocks);

  // Regression: submitConcern used to store `input.themeId ?? null` verbatim —
  // any caller that omitted themeId (verification-gate.ts's pre-existing-
  // failure filing, the public POST /concerns route, GitHub issue import) left
  // the concern permanently theme-less, even when originTaskId was present and
  // resolvable. Mirrors submitIdea's same invariant (idea-box-service.ts).

  it('uses the explicit themeId when provided, without looking up the task', async () => {
    await submitConcern({ title: 'タイトルが十分な長さの懸念', detail: '詳細', themeId: 7 });

    expect(mockKnowledgeEntryCreate).toHaveBeenCalledTimes(1);
    const call = mockKnowledgeEntryCreate.mock.calls[0][0] as { data: { themeId: number | null } };
    expect(call.data.themeId).toBe(7);
    expect(mockTaskFindUnique).not.toHaveBeenCalled();
  });

  it('resolves themeId from originTaskId when themeId is omitted', async () => {
    mockTaskFindUnique.mockResolvedValue({ themeId: 12, workingDirectory: null });

    await submitConcern({ title: 'タイトルが十分な長さの懸念', detail: '詳細', originTaskId: 511 });

    expect(mockTaskFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 511 } }),
    );
    const call = mockKnowledgeEntryCreate.mock.calls[0][0] as { data: { themeId: number | null } };
    expect(call.data.themeId).toBe(12);
  });

  it('falls back to the default theme when originTaskId has no theme of its own', async () => {
    mockTaskFindUnique.mockResolvedValue({ themeId: null, workingDirectory: null });
    mockThemeFindMany.mockResolvedValue([{ id: 3, isDefault: true, workingDirectory: null }]);

    await submitConcern({ title: 'タイトルが十分な長さの懸念', detail: '詳細', originTaskId: 511 });

    const call = mockKnowledgeEntryCreate.mock.calls[0][0] as { data: { themeId: number | null } };
    expect(call.data.themeId).toBe(3);
  });

  it('falls back to the default theme when neither themeId nor originTaskId is given', async () => {
    mockThemeFindMany.mockResolvedValue([{ id: 9, isDefault: true, workingDirectory: null }]);

    await submitConcern({ title: 'タイトルが十分な長さの懸念', detail: '詳細' });

    expect(mockTaskFindUnique).not.toHaveBeenCalled();
    const call = mockKnowledgeEntryCreate.mock.calls[0][0] as { data: { themeId: number | null } };
    expect(call.data.themeId).toBe(9);
  });

  it('stores themeId: null only when genuinely no theme exists at all', async () => {
    mockThemeFindMany.mockResolvedValue([]);

    await submitConcern({ title: 'タイトルが十分な長さの懸念', detail: '詳細' });

    const call = mockKnowledgeEntryCreate.mock.calls[0][0] as { data: { themeId: number | null } };
    expect(call.data.themeId).toBeNull();
  });
});

// ─── submitConcern — source tag ────────────────────────────────────────────────

describe('submitConcern — source tag', () => {
  beforeEach(resetMocks);

  it('stores the given source as a source:<value> tag', async () => {
    await submitConcern({
      title: 'タイトルが十分な長さの懸念',
      detail: '詳細',
      source: 'vuln_scan',
    });

    expect(mockKnowledgeEntryCreate).toHaveBeenCalledTimes(1);
    const call = mockKnowledgeEntryCreate.mock.calls[0][0] as { data: { tags: string } };
    const tags = JSON.parse(call.data.tags) as string[];
    expect(tags).toContain('source:vuln_scan');
  });

  it('defaults to source:agent when source is omitted', async () => {
    await submitConcern({ title: 'タイトルが十分な長さの懸念', detail: '詳細' });

    const call = mockKnowledgeEntryCreate.mock.calls[0][0] as { data: { tags: string } };
    const tags = JSON.parse(call.data.tags) as string[];
    expect(tags).toContain('source:agent');
  });
});

// ─── submitConcern — lifecycle-aware dedup ─────────────────────────────────────

describe('submitConcern — lifecycle-aware dedup', () => {
  beforeEach(resetMocks);

  // Regression: dedup used to match any concern with the same contentHash
  // regardless of lifecycle, so once a ci_watch red for a workflow left 'open'
  // (promoted to a task, resolved, or forgotten) the same workflow breaking
  // again was silently swallowed forever. Dedup must only block on a LIVE
  // concern: 'open', or 'task_created' whose task is still in flight.

  it('scopes the dedup lookup to active, non-resolved concerns', async () => {
    await submitConcern({
      title: 'CI赤の懸念タイトル',
      detail: '詳細',
      dedupKey: 'ci-red:1:Test',
    });

    const call = mockKnowledgeEntryFindMany.mock.calls[0][0] as {
      where: { forgettingStage?: string; sourceId?: unknown };
    };
    expect(call.where.forgettingStage).toBe('active');
    expect(call.where.sourceId).toEqual({ not: 'resolved' });
  });

  it('blocks (no new row) when a live OPEN concern with the same key exists', async () => {
    mockKnowledgeEntryFindMany.mockResolvedValue([{ id: 5, sourceId: 'open' }]);

    const result = await submitConcern({
      title: 'CI赤の懸念タイトル',
      detail: '詳細',
      dedupKey: 'ci-red:1:Test',
    });

    expect(result.id).toBe(5);
    expect(result.outcome).toBe('reused');
    expect(result.reason).toBe('dedup-live-duplicate');
    expect(mockKnowledgeEntryCreate).not.toHaveBeenCalled();
  });

  it('blocks when a dismissed concern with the same key exists (respects dismiss)', async () => {
    mockKnowledgeEntryFindMany.mockResolvedValue([{ id: 5, sourceId: 'dismissed' }]);

    const result = await submitConcern({
      title: 'CI赤の懸念タイトル',
      detail: '詳細',
      dedupKey: 'ci-red:1:Test',
    });

    expect(result.id).toBe(5);
    expect(result.outcome).toBe('reused');
    expect(mockKnowledgeEntryCreate).not.toHaveBeenCalled();
  });

  it('blocks when the same-key task_created concern is still in flight', async () => {
    mockKnowledgeEntryFindMany.mockResolvedValue([{ id: 5, sourceId: 'task_9' }]);
    mockTaskFindUnique.mockResolvedValue({ status: 'in-progress' });

    const result = await submitConcern({
      title: 'CI赤の懸念タイトル',
      detail: '詳細',
      dedupKey: 'ci-red:1:Test',
    });

    expect(result.id).toBe(5);
    expect(result.outcome).toBe('reused');
    expect(mockKnowledgeEntryCreate).not.toHaveBeenCalled();
  });

  it('files a fresh concern when the same-key task_created concern已完了', async () => {
    mockKnowledgeEntryFindMany.mockResolvedValue([{ id: 5, sourceId: 'task_9' }]);
    mockTaskFindUnique.mockResolvedValue({ status: 'completed' });

    await submitConcern({
      title: 'CI赤の懸念タイトル',
      detail: '詳細',
      dedupKey: 'ci-red:1:Test',
    });

    // Terminal follow-up task → a recurrence is a new regression → new row filed.
    expect(mockKnowledgeEntryCreate).toHaveBeenCalledTimes(1);
  });
});

// ─── submitConcern — recurrencePolicy aggregation (#801) ───────────────────────

describe('submitConcern — recurrencePolicy aggregation', () => {
  beforeEach(resetMocks);

  it('files exactly one concern when the same signature is detected twice in a row', async () => {
    mockKnowledgeEntryFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 11,
        sourceId: 'open',
        tags: JSON.stringify(['severity:high']),
        content: '1回目の詳細',
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
    ]);
    mockKnowledgeEntryCreate.mockResolvedValueOnce({ id: 11 });

    const first = await submitConcern({
      title: '状態不整合の懸念',
      detail: '1回目の詳細',
      dedupKey: 'self-incident:tristate-desync',
      recurrencePolicy: { enabled: true, instanceValue: 'taskId:100' },
    });
    const second = await submitConcern({
      title: '状態不整合の懸念',
      detail: '2回目の詳細',
      dedupKey: 'self-incident:tristate-desync',
      recurrencePolicy: { enabled: true, instanceValue: 'taskId:200' },
    });

    expect(first.id).toBe(11);
    expect(first.outcome).toBe('created');
    expect(first.reason).toBe('new');
    expect(second.id).toBe(11);
    expect(second.outcome).toBe('reused');
    expect(second.reason).toBe('recurrence-merged-open');
    expect(mockKnowledgeEntryCreate).toHaveBeenCalledTimes(1);
    expect(mockKnowledgeEntryUpdate).toHaveBeenCalledTimes(1);
    const updateCall = mockKnowledgeEntryUpdate.mock.calls[0][0] as {
      data: { content: string; tags: string };
    };
    expect(updateCall.data.content).toContain('### 発生記録');
    expect(JSON.parse(updateCall.data.tags)).toContain('occurrence:2');
  });

  it('escalates severity and references the prior entry for a done-task recurrence within the window', async () => {
    const completedAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    mockKnowledgeEntryFindMany.mockResolvedValue([
      {
        id: 22,
        sourceId: 'task_50',
        tags: '[]',
        content: '過去の詳細',
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
    ]);
    mockTaskFindUnique.mockResolvedValue({ status: 'done', completedAt });

    const result = await submitConcern({
      title: 'git command failed 懸念',
      detail: '新しい詳細',
      severity: 'medium',
      dedupKey: 'log:backend|git|error|checkout',
      recurrencePolicy: { enabled: true, instanceValue: 'git checkout -b feature/aaa' },
    });

    expect(mockKnowledgeEntryCreate).toHaveBeenCalledTimes(1);
    const call = mockKnowledgeEntryCreate.mock.calls[0][0] as {
      data: { content: string; tags: string };
    };
    expect(call.data.content).toContain('### 再発');
    expect(call.data.content).toContain('#22');
    const tags = JSON.parse(call.data.tags) as string[];
    expect(tags).toContain('recurrenceOf:22');
    expect(tags).toContain('severity:high'); // medium escalated to high
    expect(result.outcome).toBe('created');
    expect(result.reason).toBe('recurrence-of-done');
  });

  it('files a plain new concern (no escalation) for a done-task recurrence outside the window', async () => {
    const completedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    mockKnowledgeEntryFindMany.mockResolvedValue([
      {
        id: 23,
        sourceId: 'task_51',
        tags: '[]',
        content: '過去の詳細',
        createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      },
    ]);
    mockTaskFindUnique.mockResolvedValue({ status: 'done', completedAt });

    const result = await submitConcern({
      title: '状態不整合の懸念',
      detail: '新しい詳細',
      severity: 'medium',
      dedupKey: 'self-incident:tristate-desync-old',
      recurrencePolicy: { enabled: true, instanceValue: 'taskId:300' },
    });

    expect(mockKnowledgeEntryCreate).toHaveBeenCalledTimes(1);
    const call = mockKnowledgeEntryCreate.mock.calls[0][0] as {
      data: { content: string; tags: string };
    };
    expect(call.data.content).not.toContain('### 再発');
    const tags = JSON.parse(call.data.tags) as string[];
    expect(tags).not.toContain('recurrenceOf:23');
    expect(tags).toContain('severity:medium'); // unchanged, no escalation
    expect(result.outcome).toBe('created');
    expect(result.reason).toBe('new');
  });
});

// ─── submitConcern — 応答のoutcome区別 (#888) ───────────────────────────────────

describe('submitConcern — 応答のoutcome区別', () => {
  beforeEach(resetMocks);

  it('near-duplicate 抑制時は outcome:suppressed, reason:near-duplicate を返す', async () => {
    mockKnowledgeEntryFindMany
      .mockResolvedValueOnce([]) // findBlockingDuplicate: no blocking dup
      .mockResolvedValueOnce([
        { id: 42, title: 'テーマ飽和判定の誤爆確認用タイトル' },
      ]); // findNearDuplicate: near-dup match

    const result = await submitConcern({
      title: 'テーマ飽和判定の誤爆確認用タイトル',
      detail: '詳細',
    });

    expect(result).toEqual({ id: 42, outcome: 'suppressed', reason: 'near-duplicate' });
    expect(mockKnowledgeEntryCreate).not.toHaveBeenCalled();
  });

  it('theme-saturation 抑制時は outcome:suppressed, reason:theme-saturation を返す', async () => {
    mockKnowledgeEntryFindMany
      .mockResolvedValueOnce([]) // findBlockingDuplicate: no blocking dup
      .mockResolvedValueOnce([]) // findNearDuplicate: no near-dup
      .mockResolvedValueOnce([
        { id: 51, title: '監督ループ自動修復システムの誤動作報告B' },
        { id: 52, title: '監督ループ自動修復システムの誤動作報告C' },
        { id: 53, title: '監督ループ自動修復システムの誤動作報告D' },
      ]); // findSaturatedTheme: theme cap reached

    const result = await submitConcern({
      title: '監督ループ自動修復システムの誤動作報告A',
      detail: '詳細',
    });

    expect(result).toEqual({ id: 51, outcome: 'suppressed', reason: 'theme-saturation' });
    expect(mockKnowledgeEntryCreate).not.toHaveBeenCalled();
  });

  it('near-dup も飽和もない通常登録は outcome:created, reason:new を返す', async () => {
    mockKnowledgeEntryFindMany
      .mockResolvedValueOnce([]) // findBlockingDuplicate
      .mockResolvedValueOnce([]) // findNearDuplicate
      .mockResolvedValueOnce([]); // findSaturatedTheme
    mockKnowledgeEntryCreate.mockResolvedValueOnce({ id: 7 });

    const result = await submitConcern({
      title: '新しい未分類の懸念タイトルです',
      detail: '詳細',
    });

    expect(result).toEqual({ id: 7, outcome: 'created', reason: 'new' });
  });
});

// ─── getConcern ───────────────────────────────────────────────────────────────

describe('getConcern', () => {
  const CONCERN_ROW = {
    id: 1,
    title: 'Auth flaw',
    content: 'JWT not validated',
    category: 'security',
    tags: '["severity:high","loc:src/auth.ts"]',
    sourceId: 'open',
    themeId: null,
    taskId: null,
    createdAt: new Date(),
  };

  beforeEach(resetMocks);

  it('concern が見つかる: 正しくマッピングされた ConcernEntry を返す', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue(CONCERN_ROW);
    mockGitHubIssueFindMany.mockResolvedValue([]);

    const concern = await getConcern(1);

    expect(concern).not.toBeNull();
    expect(concern!.id).toBe(1);
    expect(concern!.type).toBe('security');
    expect(concern!.severity).toBe('high');
    expect(concern!.location).toBe('src/auth.ts');
    expect(concern!.status).toBe('open');
    expect(concern!.linkedIssue).toBeNull();
  });

  it('linkedIssue を enrich して返す', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue(CONCERN_ROW);
    mockGitHubIssueFindMany.mockResolvedValue([
      {
        id: 10,
        issueNumber: 42,
        url: 'https://github.com/t/r/issues/42',
        state: 'open',
        linkedConcernId: 1,
      },
    ]);

    const concern = await getConcern(1);

    expect(concern!.linkedIssue).not.toBeNull();
    expect(concern!.linkedIssue!.issueNumber).toBe(42);
    expect(concern!.linkedIssue!.state).toBe('open');
  });

  it('存在しない場合は null を返す', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue(null);

    const result = await getConcern(999);

    expect(result).toBeNull();
  });

  it('sourceId="resolved" の行を status="resolved" にマッピングする', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue({ ...CONCERN_ROW, sourceId: 'resolved' });
    mockGitHubIssueFindMany.mockResolvedValue([]);

    const concern = await getConcern(1);

    expect(concern!.status).toBe('resolved');
  });

  it('tags の source:<value> を ConcernEntry.source に読み出す', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue({
      ...CONCERN_ROW,
      tags: '["severity:high","source:vuln_scan"]',
    });

    const concern = await getConcern(1);

    expect(concern!.source).toBe('vuln_scan');
  });

  it('source タグの無い既存データは source="unknown" にフォールバックする', async () => {
    mockKnowledgeEntryFindFirst.mockResolvedValue({
      ...CONCERN_ROW,
      tags: '["severity:medium"]',
    });

    const concern = await getConcern(1);

    expect(concern!.source).toBe('unknown');
  });
});

// ─── listConcerns ─────────────────────────────────────────────────────────────

describe('listConcerns', () => {
  const CONCERN_ROW = {
    id: 2,
    title: 'DB index missing',
    content: 'Slow query on users table',
    category: 'perf',
    tags: '["severity:medium"]',
    sourceId: 'resolved',
    themeId: null,
    taskId: null,
    createdAt: new Date(),
  };

  beforeEach(resetMocks);

  it('status=resolved フィルタが sourceId="resolved" として where に渡される', async () => {
    mockKnowledgeEntryFindMany.mockResolvedValue([]);
    mockKnowledgeEntryCount.mockResolvedValue(0);

    await listConcerns({ status: 'resolved' });

    const call = mockKnowledgeEntryFindMany.mock.calls[0][0];
    expect(call.where.sourceId).toBe('resolved');
  });

  it('linkedIssue enrich: 結果に linkedIssue が付与される', async () => {
    mockKnowledgeEntryFindMany.mockResolvedValue([CONCERN_ROW]);
    mockKnowledgeEntryCount.mockResolvedValue(1);
    mockGitHubIssueFindMany.mockResolvedValue([
      {
        id: 20,
        issueNumber: 7,
        url: 'https://github.com/t/r/issues/7',
        state: 'closed',
        linkedConcernId: 2,
      },
    ]);

    const { concerns, total } = await listConcerns({ status: 'all' });

    expect(total).toBe(1);
    expect(concerns[0].linkedIssue).not.toBeNull();
    expect(concerns[0].linkedIssue!.issueNumber).toBe(7);
    expect(concerns[0].linkedIssue!.state).toBe('closed');
  });

  it('sourceId="resolved" の concern を status="resolved" に変換する', async () => {
    mockKnowledgeEntryFindMany.mockResolvedValue([CONCERN_ROW]);
    mockKnowledgeEntryCount.mockResolvedValue(1);

    const { concerns } = await listConcerns({ status: 'resolved' });

    expect(concerns[0].status).toBe('resolved');
  });

  it('linkedIssue がない concern は linkedIssue=null になる', async () => {
    mockKnowledgeEntryFindMany.mockResolvedValue([CONCERN_ROW]);
    mockKnowledgeEntryCount.mockResolvedValue(1);
    mockGitHubIssueFindMany.mockResolvedValue([]);

    const { concerns } = await listConcerns({ status: 'all' });

    expect(concerns[0].linkedIssue).toBeNull();
  });

  it('source フィルタはクォート込み contains で where に渡される (vuln_scan_audit 誤マッチ防止)', async () => {
    await listConcerns({ source: 'vuln_scan' });

    const call = mockKnowledgeEntryFindMany.mock.calls[0][0];
    expect(call.where.tags).toEqual({ contains: '"source:vuln_scan"' });
  });

  it('severity と source の同時指定は AND で両方の条件が効く', async () => {
    await listConcerns({ severity: 'high', source: 'ci_watch' });

    const call = mockKnowledgeEntryFindMany.mock.calls[0][0];
    expect(call.where.tags).toBeUndefined();
    expect(call.where.AND).toEqual([
      { tags: { contains: 'severity:high' } },
      { tags: { contains: '"source:ci_watch"' } },
    ]);
  });

  it('severity 単独指定は従来どおり where.tags 直下に入る', async () => {
    await listConcerns({ severity: 'high' });

    const call = mockKnowledgeEntryFindMany.mock.calls[0][0];
    expect(call.where.tags).toEqual({ contains: 'severity:high' });
    expect(call.where.AND).toBeUndefined();
  });

  it('結果の各 concern に tags 由来の source が付与される', async () => {
    mockKnowledgeEntryFindMany.mockResolvedValue([
      { ...CONCERN_ROW, tags: '["severity:medium","source:loop_review"]' },
    ]);
    mockKnowledgeEntryCount.mockResolvedValue(1);

    const { concerns } = await listConcerns({ status: 'all' });

    expect(concerns[0].source).toBe('loop_review');
  });
});

// ─── getConcernStats ──────────────────────────────────────────────────────────

describe('getConcernStats', () => {
  beforeEach(resetMocks);

  it('resolved カウントが統計に含まれる', async () => {
    mockKnowledgeEntryCount
      .mockResolvedValueOnce(5) // open
      .mockResolvedValueOnce(2) // task_created
      .mockResolvedValueOnce(1) // dismissed
      .mockResolvedValueOnce(3); // resolved
    mockKnowledgeEntryGroupBy.mockResolvedValue([
      { category: 'bug', _count: { id: 3 } },
      { category: 'security', _count: { id: 2 } },
    ]);

    const stats = await getConcernStats();

    expect(stats.open).toBe(5);
    expect(stats.taskCreated).toBe(2);
    expect(stats.dismissed).toBe(1);
    expect(stats.resolved).toBe(3);
    expect(stats.byType).toHaveLength(2);
    expect(stats.byType[0]).toEqual({ type: 'bug', count: 3 });
    expect(stats.byType[1]).toEqual({ type: 'security', count: 2 });
  });

  it('全ゼロの場合も正しく返す', async () => {
    mockKnowledgeEntryCount.mockResolvedValue(0);
    mockKnowledgeEntryGroupBy.mockResolvedValue([]);

    const stats = await getConcernStats();

    expect(stats.open).toBe(0);
    expect(stats.resolved).toBe(0);
    expect(stats.byType).toHaveLength(0);
  });
});

// ─── SSOT 配列テスト ──────────────────────────────────────────────────────────

describe('CONCERN_TYPES (SSOT array)', () => {
  it('contains all expected concern type strings', () => {
    expect(CONCERN_TYPES).toEqual(['bug', 'refactor', 'security', 'perf', 'other']);
  });
});

describe('CONCERN_SEVERITIES (SSOT array)', () => {
  it('contains all expected severity strings', () => {
    expect(CONCERN_SEVERITIES).toEqual(['urgent', 'high', 'medium', 'low']);
  });
});

describe('isConcernType (generated guard)', () => {
  it.each(['bug', 'refactor', 'security', 'perf', 'other'] as const)(
    'returns true for valid type "%s"',
    (t) => {
      expect(isConcernType(t)).toBe(true);
    },
  );

  it('returns false for invalid string', () => {
    expect(isConcernType('critical')).toBe(false);
  });

  it('returns false for null / undefined', () => {
    expect(isConcernType(null)).toBe(false);
    expect(isConcernType(undefined)).toBe(false);
  });
});

describe('isConcernSeverity (generated guard)', () => {
  it.each(['urgent', 'high', 'medium', 'low'] as const)(
    'returns true for valid severity "%s"',
    (s) => {
      expect(isConcernSeverity(s)).toBe(true);
    },
  );

  it('returns false for invalid string', () => {
    expect(isConcernSeverity('critical')).toBe(false);
  });
});
