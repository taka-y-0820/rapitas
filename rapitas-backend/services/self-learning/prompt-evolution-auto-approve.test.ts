/**
 * prompt-evolution-auto-approve テスト
 *
 * proposed→approved の条件付き無人承認を検証する。品質ゲートと削除指示ガードの
 * 両方を通過した候補のみ承認され、いずれか不合格なら proposed のまま人手判断に
 * 残ること、環境変数でオプトアウトできることを確認する。
 * Own file — mock.module is process-global.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
mock.module('../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
  getBackendLogFilePath: () => '',
}));

interface EvoRow {
  id: number;
  basePromptKey: string | null;
  afterPrompt: string;
  evidenceJson: string | null;
  status: string;
  createdAt: Date;
}

let rows: EvoRow[] = [];

type StatusWhere = string | { in: string[] } | undefined;
const statusMatches = (status: string, where: StatusWhere): boolean =>
  !where || (typeof where === 'string' ? status === where : where.in.includes(status));

// NOTE: mock.module はプロセスグローバル。config/index.ts が再エクスポートする
// ensureDatabaseConnection まで含めて実モジュールの全exportをミラーする。
mock.module('../../config/database', () => ({
  ensureDatabaseConnection: mock(async () => {}),
  prisma: {
    promptEvolution: {
      findMany: mock((args: { where?: { status?: StatusWhere }; take?: number }) => {
        const filtered = rows.filter((r) => statusMatches(r.status, args?.where?.status));
        return Promise.resolve(args?.take ? filtered.slice(0, args.take) : filtered);
      }),
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
  },
}));

const { autoApproveEligibleProposals } = await import('./prompt-evolution-auto-approve');

function proposedRow(id: number, afterPrompt: string): EvoRow {
  return {
    id,
    basePromptKey: 'workflow_role_implementer',
    afterPrompt,
    evidenceJson: '{"totalRuns":20,"successRate":0.55}',
    status: 'proposed',
    createdAt: new Date('2026-07-01T00:00:00Z'),
  };
}

let savedFlag: string | undefined;

beforeEach(() => {
  rows = [];
  savedFlag = process.env.RAPITAS_PROMPT_AUTO_APPROVE;
  delete process.env.RAPITAS_PROMPT_AUTO_APPROVE;
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env.RAPITAS_PROMPT_AUTO_APPROVE;
  else process.env.RAPITAS_PROMPT_AUTO_APPROVE = savedFlag;
});

describe('autoApproveEligibleProposals', () => {
  test('両ガードを通過した候補は人手クリック無しでapprovedになる', async () => {
    rows = [proposedRow(1, '- 提出前にlintを実行する\n- 型チェックを通す')];

    const result = await autoApproveEligibleProposals();

    expect(result).toEqual({ approved: 1, withheld: 0 });
    expect(rows[0].status).toBe('approved');
    // approvedAt が無いと settle の事後測定窓が開かない。
    expect(JSON.parse(rows[0].evidenceJson ?? '{}').approvedAt).toBeString();
  });

  test('品質ゲート不合格の候補はproposedのまま人手判断に残る', async () => {
    rows = [proposedRow(2, '```\n- 何かする\n```')];

    const result = await autoApproveEligibleProposals();

    expect(result).toEqual({ approved: 0, withheld: 1 });
    expect(rows[0].status).toBe('proposed');
  });

  test('削除指示を含む候補はproposedのまま人手判断に残る', async () => {
    rows = [proposedRow(3, '- 既存の検証手順を削除して簡略化する')];

    const result = await autoApproveEligibleProposals();

    expect(result).toEqual({ approved: 0, withheld: 1 });
    expect(rows[0].status).toBe('proposed');
  });

  test('RAPITAS_PROMPT_AUTO_APPROVE=false なら一切承認しない', async () => {
    process.env.RAPITAS_PROMPT_AUTO_APPROVE = 'false';
    rows = [proposedRow(4, '- 提出前にlintを実行する')];

    const result = await autoApproveEligibleProposals();

    expect(result).toEqual({ approved: 0, withheld: 0 });
    expect(rows[0].status).toBe('proposed');
  });

  test('承認時は同ロールの旧承認をsupersededにする(追記は常に1件)', async () => {
    rows = [
      { ...proposedRow(5, '古い追記'), status: 'approved' },
      proposedRow(6, '- 提出前にlintを実行する'),
    ];

    await autoApproveEligibleProposals();

    expect(rows[0].status).toBe('superseded');
    expect(rows[1].status).toBe('approved');
  });

  test('limitを超える候補は次回に回す', async () => {
    rows = [
      proposedRow(7, '- lintを実行する'),
      proposedRow(8, '- 型チェックを通す'),
      proposedRow(9, '- テストを実行する'),
    ];

    const result = await autoApproveEligibleProposals(2);

    expect(result.approved).toBe(2);
    expect(rows.filter((r) => r.status === 'proposed')).toHaveLength(1);
  });

  test('再実行しても同じ候補を二重に承認しない(停止・再起動後の再入)', async () => {
    rows = [proposedRow(11, '- 提出前にlintを実行する')];

    const first = await autoApproveEligibleProposals();
    const second = await autoApproveEligibleProposals();

    expect(first.approved).toBe(1);
    // 2回目は proposed が残っていないため対象0件 — 追記は1ロール1件のまま。
    expect(second).toEqual({ approved: 0, withheld: 0 });
    expect(rows.filter((r) => r.status === 'approved')).toHaveLength(1);
  });

  test('proposedが無ければ何もしない', async () => {
    rows = [{ ...proposedRow(10, '- lintを実行する'), status: 'pending' }];
    expect(await autoApproveEligibleProposals()).toEqual({ approved: 0, withheld: 0 });
  });
});
