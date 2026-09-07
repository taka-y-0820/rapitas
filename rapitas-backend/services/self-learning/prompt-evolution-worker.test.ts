/**
 * prompt-evolution-worker テスト
 *
 * pending候補からの提案生成(status→proposed)、承認/却下(承認時は同ロールの
 * 旧承認をsuperseded化)、承認済み追記の取得を検証する。
 * Own file — mock.module is process-global.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ComparisonRecord } from './comparison/prompt-comparison-types';

mock.module('../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

let aiResponse = '- 提出前にlintを実行する\n- 型チェックを通す';
const sendAIMessage = mock(() => Promise.resolve({ content: aiResponse }));
mock.module('../../utils/ai-client', () => ({ sendAIMessage }));

interface EvoRow {
  id: number;
  basePromptKey: string | null;
  category: string;
  reason: string | null;
  evidenceJson: string | null;
  afterPrompt: string;
  improvement: string | null;
  status: string;
  createdAt: Date;
}

let rows: EvoRow[] = [];
const transitionFindMany = mock(async () => [] as Array<{ cause: string | null }>);

type StatusWhere = string | { in: string[] } | undefined;
const statusMatches = (status: string, where: StatusWhere): boolean =>
  !where || (typeof where === 'string' ? status === where : where.in.includes(status));

mock.module('../../config/database', () => ({
  prisma: {
    promptEvolution: {
      findMany: mock((args: { where?: { status?: string }; take?: number }) => {
        const filtered = rows.filter((r) => !args?.where?.status || r.status === args.where.status);
        return Promise.resolve(args?.take ? filtered.slice(0, args.take) : filtered);
      }),
      findFirst: mock((args: { where: { basePromptKey?: string; status?: StatusWhere } }) =>
        Promise.resolve(
          rows
            .filter(
              (r) =>
                (!args.where.basePromptKey || r.basePromptKey === args.where.basePromptKey) &&
                statusMatches(r.status, args.where.status),
            )
            .sort((a, b) => b.id - a.id)[0] ?? null,
        ),
      ),
      findUnique: mock((args: { where: { id: number } }) =>
        Promise.resolve(rows.find((r) => r.id === args.where.id) ?? null),
      ),
      update: mock((args: { where: { id: number }; data: Partial<EvoRow> }) => {
        const row = rows.find((r) => r.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return Promise.resolve(row);
      }),
      updateMany: mock(
        (args: {
          where: { basePromptKey?: string; status?: StatusWhere };
          data: Partial<EvoRow>;
        }) => {
          let count = 0;
          for (const r of rows) {
            if (
              (!args.where.basePromptKey || r.basePromptKey === args.where.basePromptKey) &&
              statusMatches(r.status, args.where.status)
            ) {
              Object.assign(r, args.data);
              count++;
            }
          }
          return Promise.resolve({ count });
        },
      ),
    },
    workflowTransition: { findMany: transitionFindMany },
  },
}));

const { generateProposalsForPending, getApprovedRoleAddendum, reviewProposal, listProposals } =
  await import('./prompt-evolution-worker');
const { writeComparisonRecord } = await import('./comparison/prompt-comparison-store');

function pendingRow(id: number, role: string): EvoRow {
  return {
    id,
    basePromptKey: `workflow_role_${role}`,
    category: '',
    reason: `success_rate 55% < 70% threshold`,
    evidenceJson: '{"total":20,"success":11}',
    afterPrompt: '',
    improvement: null,
    status: 'pending',
    createdAt: new Date('2026-07-01T00:00:00Z'),
  };
}

beforeEach(() => {
  rows = [];
  aiResponse = '- 提出前にlintを実行する\n- 型チェックを通す';
  sendAIMessage.mockClear();
  transitionFindMany.mockClear();
  transitionFindMany.mockResolvedValue([]);
});

describe('generateProposalsForPending', () => {
  test('pending候補がLLM生成の追記付きでproposedになる', async () => {
    rows = [pendingRow(1, 'implementer')];
    const n = await generateProposalsForPending();
    expect(n).toBe(1);
    expect(rows[0].status).toBe('proposed');
    expect(rows[0].afterPrompt).toContain('lint');
    expect(rows[0].category).toBe('implementer');
  });

  test('LLM失敗時は候補をpendingのまま残す(次回再試行)', async () => {
    rows = [pendingRow(2, 'planner')];
    sendAIMessage.mockRejectedValueOnce(new Error('LLM down'));
    const n = await generateProposalsForPending();
    expect(n).toBe(0);
    expect(rows[0].status).toBe('pending');
  });

  test('limitで処理件数が制限される', async () => {
    rows = [pendingRow(1, 'a'), pendingRow(2, 'b'), pendingRow(3, 'c')];
    const n = await generateProposalsForPending(2);
    expect(n).toBe(2);
    expect(rows.filter((r) => r.status === 'proposed')).toHaveLength(2);
  });
});

describe('reviewProposal', () => {
  test('承認でapprovedになり、同ロールの旧承認はsupersededになる', async () => {
    rows = [
      { ...pendingRow(1, 'implementer'), status: 'approved', afterPrompt: '古い追記' },
      { ...pendingRow(2, 'implementer'), status: 'proposed', afterPrompt: '新しい追記' },
    ];
    const ok = await reviewProposal(2, true);
    expect(ok).toBe(true);
    expect(rows[0].status).toBe('superseded');
    expect(rows[1].status).toBe('approved');
    // approvedAt anchors the settlement window (prompt-evolution-settle.ts).
    expect(JSON.parse(rows[1].evidenceJson ?? '{}').approvedAt).toBeString();
  });

  test('却下でrejectedになる', async () => {
    rows = [{ ...pendingRow(3, 'verifier'), status: 'proposed' }];
    expect(await reviewProposal(3, false)).toBe(true);
    expect(rows[0].status).toBe('rejected');
  });

  test('proposed以外の行はレビューできない', async () => {
    rows = [{ ...pendingRow(4, 'verifier'), status: 'approved' }];
    expect(await reviewProposal(4, true)).toBe(false);
  });
});

function comparisonRecord(overrides: Partial<ComparisonRecord> = {}): ComparisonRecord {
  return {
    promptEvolutionId: 1,
    role: 'implementer',
    modelName: 'claude-sonnet-5',
    budgetUsd: 2.5,
    createdAt: new Date(0).toISOString(),
    status: 'done',
    sampleTaskIds: [810, 812],
    arms: [],
    summary: null,
    knowledgeSnapshotHash: null,
    stagedTaskIds: null,
    ...overrides,
  };
}

describe('getApprovedRoleAddendum', () => {
  let tmpDir: string;
  let savedDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'rapitas-prompt-evolution-worker-'));
    savedDataDir = process.env.RAPITAS_DATA_DIR;
    process.env.RAPITAS_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.RAPITAS_DATA_DIR;
    else process.env.RAPITAS_DATA_DIR = savedDataDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('承認済み追記を返し、無ければnull', async () => {
    rows = [{ ...pendingRow(1, 'implementer'), status: 'approved', afterPrompt: '追記テキスト' }];
    expect(await getApprovedRoleAddendum('implementer')).toBe('追記テキスト');
    expect(await getApprovedRoleAddendum('planner')).toBeNull();
  });

  test('stagedTaskIds未設定(比較記録なし)なら全タスクに適用される', async () => {
    rows = [{ ...pendingRow(1, 'implementer'), status: 'approved', afterPrompt: '追記テキスト' }];
    expect(await getApprovedRoleAddendum('implementer', 810)).toBe('追記テキスト');
    expect(await getApprovedRoleAddendum('implementer', 999)).toBe('追記テキスト');
  });

  test('stagedTaskIdsが設定されていれば対象外タスクにはnullを返す', async () => {
    rows = [{ ...pendingRow(1, 'implementer'), status: 'approved', afterPrompt: '追記テキスト' }];
    writeComparisonRecord(comparisonRecord({ promptEvolutionId: 1, stagedTaskIds: [810, 812] }));

    expect(await getApprovedRoleAddendum('implementer', 810)).toBe('追記テキスト');
    expect(await getApprovedRoleAddendum('implementer', 811)).toBeNull();
  });

  test('段階適用の対象タスクが不明なら追記を注入しない', async () => {
    rows = [{ ...pendingRow(1, 'implementer'), status: 'approved', afterPrompt: '追記テキスト' }];
    writeComparisonRecord(comparisonRecord({ stagedTaskIds: [810] }));
    expect(await getApprovedRoleAddendum('implementer')).toBeNull();
  });

  test('対象リストが空ならタスクID省略でも段階適用を解除しない', async () => {
    rows = [{ ...pendingRow(1, 'implementer'), status: 'approved', afterPrompt: '追記テキスト' }];
    writeComparisonRecord(comparisonRecord({ stagedTaskIds: [] }));
    expect(await getApprovedRoleAddendum('implementer')).toBeNull();
    expect(await getApprovedRoleAddendum('implementer', 810)).toBeNull();
  });

  test('completed候補も段階適用の制限を維持する', async () => {
    rows = [{ ...pendingRow(1, 'implementer'), status: 'completed', afterPrompt: '追記テキスト' }];
    writeComparisonRecord(comparisonRecord({ stagedTaskIds: [810] }));
    expect(await getApprovedRoleAddendum('implementer')).toBeNull();
    expect(await getApprovedRoleAddendum('implementer', 810)).toBe('追記テキスト');
  });
});

describe('listProposals', () => {
  test('proposedのみを返す', async () => {
    rows = [
      { ...pendingRow(1, 'a'), status: 'proposed' },
      { ...pendingRow(2, 'b'), status: 'pending' },
    ];
    const list = await listProposals();
    expect(list).toHaveLength(1);
  });
});
