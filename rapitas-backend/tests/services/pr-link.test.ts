/**
 * pr-link テスト
 *
 * linkAutoCreatedPr: 自動生成PRをローカルDBへ永続化しタスクへ紐付ける処理の
 * ユニットテスト。統合の解決・upsert・Task.githubPrId 更新・失敗時の握り潰しを検証。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Captures notify() calls from the task-identity gate. Mocked BEFORE importing
// pr-link — the real auto-merge-notify imports config/database, whose module
// load runs `new PrismaClient()` (side effect this DB-free test must avoid).
let notifyCalls: Array<{ taskId: number; type: string; title: string; message: string }> = [];
// NOTE: config/database must be mocked too — auto-merge-notify's own import chain
// reaches it, and its module load runs resolvePrismaClientCtor() which requires the
// generated Prisma client (absent in agent worktrees → module-resolution error).
mock.module('../../config/database', () => ({ prisma: {} }));
mock.module('../../services/workflow/auto-merge-notify', () => ({
  notify: async (p: { taskId: number; type: string; title: string; message: string }) => {
    notifyCalls.push(p);
  },
}));

const { linkAutoCreatedPr } = await import('../../services/github/pr-link');

type AnyMock = ReturnType<typeof mock>;
const taskRevision = new Date('2026-09-01T00:00:00Z');

function makePrisma(overrides?: {
  integrations?: Array<{ id: number; ownerName: string; repositoryName: string }>;
  upsertId?: number;
  upsertThrows?: boolean;
  /** 既存の GitHubPullRequest 行（同一性ゲートの findUnique が返す値。省略時は行なし） */
  existingPr?: { linkedTaskId: number | null; title: string; body: string | null };
}) {
  const integrations = overrides?.integrations ?? [
    { id: 7, ownerName: 'takamurayuki', repositoryName: 'rapitas' },
  ];
  const upsert: AnyMock = overrides?.upsertThrows
    ? mock(() => Promise.reject(new Error('db down')))
    : mock(() => Promise.resolve({ id: overrides?.upsertId ?? 42 }));
  const taskUpdate: AnyMock = mock(() => Promise.resolve({ count: 1 }));
  const prFindUnique: AnyMock = mock(() => Promise.resolve(overrides?.existingPr ?? null));
  return {
    prisma: {
      gitHubIntegration: {
        findMany: mock(() => Promise.resolve(integrations)),
        findUnique: mock(() =>
          Promise.resolve(integrations[0] ? { ownerName: integrations[0].ownerName } : null),
        ),
      },
      gitHubPullRequest: { upsert, findUnique: prFindUnique },
      task: {
        findUnique: mock(() => Promise.resolve({ updatedAt: taskRevision })),
        updateMany: taskUpdate,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    upsert,
    taskUpdate,
    prFindUnique,
  };
}

const baseParams = {
  taskId: 99,
  prNumber: 5,
  prUrl: 'https://github.com/takamurayuki/rapitas/pull/5',
  title: '[Task-99] fix the thing',
  headBranch: 'feature/99-fix',
  baseBranch: 'develop',
  repositoryUrl: 'https://github.com/takamurayuki/rapitas.git',
};

describe('linkAutoCreatedPr', () => {
  beforeEach(() => {
    notifyCalls = [];
  });

  test('links PR by owner/repo match and sets Task.githubPrId', async () => {
    const { prisma, upsert, taskUpdate } = makePrisma();
    const id = await linkAutoCreatedPr(prisma, baseParams);

    expect(id).toBe(42);
    expect(upsert).toHaveBeenCalledTimes(1);
    const upsertArg = upsert.mock.calls[0][0] as {
      where: { integrationId_prNumber: { integrationId: number; prNumber: number } };
      create: { linkedTaskId: number; integrationId: number };
    };
    expect(upsertArg.where.integrationId_prNumber).toEqual({ integrationId: 7, prNumber: 5 });
    expect(upsertArg.create.linkedTaskId).toBe(99);
    expect(taskUpdate).toHaveBeenCalledTimes(1);
    const taskArg = taskUpdate.mock.calls[0][0] as { data: { githubPrId: number } };
    expect(taskArg.data.githubPrId).toBe(5);
    expect(taskUpdate).toHaveBeenCalledWith({
      where: { id: 99, updatedAt: taskRevision },
      data: { githubPrId: 5, updatedAt: taskRevision },
    });
  });

  test('returns null and does not upsert when no integrations exist', async () => {
    const { prisma, upsert } = makePrisma({ integrations: [] });
    const id = await linkAutoCreatedPr(prisma, baseParams);
    expect(id).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  test('falls back to the sole integration when owner/repo does not match', async () => {
    const { prisma, upsert } = makePrisma({
      integrations: [{ id: 3, ownerName: 'someone', repositoryName: 'else' }],
    });
    const id = await linkAutoCreatedPr(prisma, baseParams);
    expect(id).toBe(42);
    const upsertArg = upsert.mock.calls[0][0] as {
      where: { integrationId_prNumber: { integrationId: number } };
    };
    expect(upsertArg.where.integrationId_prNumber.integrationId).toBe(3);
  });

  test('returns null when multiple integrations and none match', async () => {
    const { prisma, upsert } = makePrisma({
      integrations: [
        { id: 1, ownerName: 'a', repositoryName: 'x' },
        { id: 2, ownerName: 'b', repositoryName: 'y' },
      ],
    });
    const id = await linkAutoCreatedPr(prisma, { ...baseParams, repositoryUrl: null });
    expect(id).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  test('swallows persistence errors and returns null', async () => {
    const { prisma } = makePrisma({ upsertThrows: true });
    const id = await linkAutoCreatedPr(prisma, baseParams);
    expect(id).toBeNull();
  });
});

describe('linkAutoCreatedPr — タスク同一性ゲート (task 541)', () => {
  beforeEach(() => {
    notifyCalls = [];
  });

  test('既存行の linkedTaskId が他タスクなら upsert せず null を返し通知すること', async () => {
    // 実インシデント型: 同名ブランチの PR #340 (task 538) を task 99 が奪おうとするケース
    const { prisma, upsert, taskUpdate } = makePrisma({
      existingPr: { linkedTaskId: 538, title: '[Task-538] 他タスクのPR', body: null },
    });
    const id = await linkAutoCreatedPr(prisma, baseParams);

    expect(id).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
    expect(taskUpdate).not.toHaveBeenCalled();
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].type).toBe('auto_pr_identity_mismatch');
    expect(notifyCalls[0].taskId).toBe(99);
  });

  test('既存行の linkedTaskId が無くタイトルマーカーが他タスクでも拒否すること', async () => {
    const { prisma, upsert } = makePrisma({
      existingPr: {
        linkedTaskId: null,
        title: '[Task-123] webhook同期された他タスクPR',
        body: null,
      },
    });
    const id = await linkAutoCreatedPr(prisma, baseParams);

    expect(id).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
    expect(notifyCalls).toHaveLength(1);
  });

  test('既存行が自タスクの linkedTaskId なら従来通り upsert すること（再実行の正当な再利用）', async () => {
    const { prisma, upsert, taskUpdate } = makePrisma({
      existingPr: { linkedTaskId: 99, title: '[Task-99] fix the thing', body: null },
    });
    const id = await linkAutoCreatedPr(prisma, baseParams);

    expect(id).toBe(42);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(taskUpdate).toHaveBeenCalledTimes(1);
    expect(notifyCalls).toHaveLength(0);
  });

  test('既存行が存在しない場合は従来通り upsert すること（新規PR初回リンク）', async () => {
    const { prisma, upsert, prFindUnique } = makePrisma();
    const id = await linkAutoCreatedPr(prisma, baseParams);

    expect(id).toBe(42);
    expect(prFindUnique).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(notifyCalls).toHaveLength(0);
  });
});
