/**
 * prompt-evolution-auto-approve テスト
 *
 * 2段ゲート（proposed→staged→approved）を検証する。テキストガードは限定試行を
 * 開始させるだけで全体採用しないこと、全体採用/撤回は比較記録の実測判定にのみ
 * 従うこと、記録取得失敗は unknown 扱いで状態を変えないこと、恒久不合格の先頭
 * 候補が後続を止め続けないこと、そして破損・未完了の比較記録を空の新規記録で
 * 上書きせず staging を保留することを確認する。
 * Own file — mock.module is process-global.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
const { readComparisonRecord, recordComparisonRun, writeComparisonRecord } =
  await import('./comparison/prompt-comparison-store');
const { COMPARISON_MIN_SAMPLE } = await import('./comparison/prompt-comparison-metrics');
import type { ComparisonRun } from './comparison/prompt-comparison-types';

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

function evidenceOf(id: number): Record<string, unknown> {
  return JSON.parse(rows.find((r) => r.id === id)?.evidenceJson ?? '{}') as Record<string, unknown>;
}

let execSeq = 1000;

/** Push `n` runs into one arm so the comparison summary can reach a verdict. */
function fillArm(id: number, arm: 'current' | 'candidate', successes: number, total: number): void {
  for (let i = 0; i < total; i++) {
    const run: ComparisonRun = {
      taskId: 500 + i,
      executionId: execSeq++,
      success: i < successes,
      costUsd: 0.1,
      durationMs: 60_000,
      failureCause: i < successes ? null : 'implementation_error',
      role: 'implementer',
      injected: arm === 'candidate',
      injectedVersion: arm === 'candidate' ? 'v1' : null,
    };
    recordComparisonRun(id, arm, run);
  }
}

let tmpDir: string;
let savedDataDir: string | undefined;
let savedApprove: string | undefined;
let savedPromote: string | undefined;

beforeEach(() => {
  rows = [];
  tmpDir = mkdtempSync(join(tmpdir(), 'rapitas-auto-approve-'));
  savedDataDir = process.env.RAPITAS_DATA_DIR;
  process.env.RAPITAS_DATA_DIR = tmpDir;
  savedApprove = process.env.RAPITAS_PROMPT_AUTO_APPROVE;
  savedPromote = process.env.RAPITAS_PROMPT_AUTO_PROMOTE;
  delete process.env.RAPITAS_PROMPT_AUTO_APPROVE;
  delete process.env.RAPITAS_PROMPT_AUTO_PROMOTE;
});

afterEach(() => {
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore('RAPITAS_DATA_DIR', savedDataDir);
  restore('RAPITAS_PROMPT_AUTO_APPROVE', savedApprove);
  restore('RAPITAS_PROMPT_AUTO_PROMOTE', savedPromote);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('autoApproveEligibleProposals — 第1段: proposed → staged', () => {
  test('テキストガード通過は全体承認ではなく限定試行(staged)に入る', async () => {
    rows = [proposedRow(1, '- 提出前にlintを実行する\n- 型チェックを通す')];

    const result = await autoApproveEligibleProposals();

    expect(result.staged).toBe(1);
    expect(result.approved).toBe(0);
    expect(rows[0].status).toBe('staged');
    // 全ロールへ即時注入される approved には決してならない。
    expect(rows.some((r) => r.status === 'approved')).toBe(false);
    expect(evidenceOf(1).stagedSampleCount).toBe(0);
    expect(evidenceOf(1).stagedAt).toBeString();
  });

  test('staging と同時に比較記録が作られ、限定試行の受け皿になる', async () => {
    rows = [proposedRow(2, '- 提出前にlintを実行する')];

    await autoApproveEligibleProposals();

    const record = readComparisonRecord(2);
    expect(record).not.toBeNull();
    expect(record?.arms).toEqual([]);
    expect(record?.role).toBe('implementer');
  });

  test('品質ゲート不合格は上限までproposedで再試行され、上限到達でrejectedになる', async () => {
    rows = [proposedRow(3, '```\n- 何かする\n```')];

    await autoApproveEligibleProposals();
    expect(rows[0].status).toBe('proposed');
    expect(evidenceOf(3).autoApproveQualityRetries).toBe(1);

    await autoApproveEligibleProposals();
    expect(rows[0].status).toBe('proposed');

    const third = await autoApproveEligibleProposals();
    expect(rows[0].status).toBe('rejected');
    expect(third.rejected).toBe(1);
    expect(evidenceOf(3).rejectionReason).toBe('code_fence_only');
  });

  test('削除指示を含む候補も同じ再試行上限で除去される', async () => {
    rows = [proposedRow(4, '- 既存の検証手順を削除して簡略化する')];

    await autoApproveEligibleProposals();
    await autoApproveEligibleProposals();
    await autoApproveEligibleProposals();

    expect(rows[0].status).toBe('rejected');
    expect(evidenceOf(4).rejectionReason).toBe('deletion_signal');
  });

  test('恒久不合格の先頭3件は後続候補を永久には止めない', async () => {
    rows = [
      proposedRow(11, '```\nfence\n```'),
      proposedRow(12, '```\nfence\n```'),
      proposedRow(13, '```\nfence\n```'),
      proposedRow(14, '- 提出前にlintを実行する'),
    ];

    // take:3 の先頭固定で 14 には到達しない、を3回。
    await autoApproveEligibleProposals();
    await autoApproveEligibleProposals();
    expect(rows.find((r) => r.id === 14)?.status).toBe('proposed');

    // 3回目で先頭3件がrejectedになりプールから抜ける。
    await autoApproveEligibleProposals();
    expect(rows.filter((r) => r.status === 'rejected')).toHaveLength(3);

    // 次回実行で後続候補が処理される。
    const after = await autoApproveEligibleProposals();
    expect(after.staged).toBe(1);
    expect(rows.find((r) => r.id === 14)?.status).toBe('staged');
  });

  test('RAPITAS_PROMPT_AUTO_APPROVE=false なら一切動かない', async () => {
    process.env.RAPITAS_PROMPT_AUTO_APPROVE = 'false';
    rows = [proposedRow(5, '- 提出前にlintを実行する')];

    const result = await autoApproveEligibleProposals();

    expect(result).toEqual({ staged: 0, approved: 0, rejected: 0, withheld: 0 });
    expect(rows[0].status).toBe('proposed');
  });

  test('proposedが無ければ何もしない', async () => {
    rows = [{ ...proposedRow(6, '- lintを実行する'), status: 'pending' }];
    expect(await autoApproveEligibleProposals()).toEqual({
      staged: 0,
      approved: 0,
      rejected: 0,
      withheld: 0,
    });
  });
});

/** Absolute path of a candidate's comparison record inside the test data dir. */
function recordPath(id: number): string {
  return join(tmpDir, '.prompt-comparisons', `${id}.json`);
}

function writeRawRecord(id: number, contents: string): void {
  mkdirSync(join(tmpDir, '.prompt-comparisons'), { recursive: true });
  writeFileSync(recordPath(id), contents);
}

describe('autoApproveEligibleProposals — 既存比較記録の保護', () => {
  test('破損した比較記録を空の新規記録で上書きせず、staging を保留する', async () => {
    rows = [proposedRow(40, '- 提出前にlintを実行する')];
    writeRawRecord(40, '{ broken json');
    const before = readFileSync(recordPath(40), 'utf8');

    const result = await autoApproveEligibleProposals();

    // staged にせず proposed のまま = 評価段の「記録なし」と混同しない。
    expect(rows[0].status).toBe('proposed');
    expect(result.staged).toBe(0);
    expect(result.withheld).toBe(1);
    expect(evidenceOf(40).comparisonRecordIssue).toBe('corrupted');
    expect(evidenceOf(40).comparisonInitRetries).toBe(1);
    // 破損証拠そのものは保持される。
    expect(readFileSync(recordPath(40), 'utf8')).toBe(before);
  });

  test('未完了(in_progress)の記録も上書きせず保留する', async () => {
    rows = [proposedRow(41, '- 提出前にlintを実行する')];
    writeComparisonRecord({
      promptEvolutionId: 41,
      role: 'implementer',
      modelName: '',
      budgetUsd: 0,
      createdAt: new Date(0).toISOString(),
      status: 'in_progress',
      sampleTaskIds: [777],
      arms: [],
      summary: null,
      knowledgeSnapshotHash: null,
      stagedTaskIds: null,
    });

    const result = await autoApproveEligibleProposals();

    expect(rows[0].status).toBe('proposed');
    expect(result.withheld).toBe(1);
    expect(evidenceOf(41).comparisonRecordIssue).toBe('in_progress');
    // 元の記録内容が残っていること（sampleTaskIds が空配列に潰れていない）。
    const raw = JSON.parse(readFileSync(recordPath(41), 'utf8')) as { sampleTaskIds: number[] };
    expect(raw.sampleTaskIds).toEqual([777]);
  });

  test('保留は繰り返し試行され、回復すれば staged へ進む', async () => {
    rows = [proposedRow(42, '- 提出前にlintを実行する')];
    writeRawRecord(42, '{ broken json');

    await autoApproveEligibleProposals();
    await autoApproveEligibleProposals();
    expect(rows[0].status).toBe('proposed');
    expect(evidenceOf(42).comparisonInitRetries).toBe(2);

    // 運用者が壊れたファイルを取り除いた後は自然に再開する。
    rmSync(recordPath(42));
    const result = await autoApproveEligibleProposals();

    expect(rows[0].status).toBe('staged');
    expect(result.staged).toBe(1);
    // 回復時に診断スタンプは片付ける。
    expect(evidenceOf(42).comparisonRecordIssue).toBeUndefined();
    expect(evidenceOf(42).comparisonInitRetries).toBeUndefined();
  });

  test('記録が壊れていてもテキスト品質を理由に rejected にはしない', async () => {
    rows = [proposedRow(43, '- 提出前にlintを実行する')];
    writeRawRecord(43, '{ broken json');

    for (let i = 0; i < 5; i++) await autoApproveEligibleProposals();

    // 原因は追記文ではなく記録側なので、再試行上限で却下してはならない。
    expect(rows[0].status).toBe('proposed');
    expect(evidenceOf(43).autoApproveQualityRetries).toBeUndefined();
  });
});

describe('autoApproveEligibleProposals — 第2段: staged の実測判定', () => {
  test('証拠不足のあいだは staged のまま継続し、全体採用しない', async () => {
    rows = [proposedRow(20, '- 提出前にlintを実行する')];
    await autoApproveEligibleProposals();
    fillArm(20, 'current', 1, 2);
    fillArm(20, 'candidate', 2, 2);

    const result = await autoApproveEligibleProposals();

    expect(rows[0].status).toBe('staged');
    expect(result.approved).toBe(0);
    expect(result.withheld).toBe(1);
    expect(evidenceOf(20).comparisonVerdict).toBe('insufficient_data');
  });

  test('比較記録が読めない場合は unknown を記録し状態を変えない', async () => {
    rows = [proposedRow(21, '- 提出前にlintを実行する')];
    await autoApproveEligibleProposals();
    // 記録を in_progress にする = 使用不可（取得失敗）。
    const record = readComparisonRecord(21)!;
    writeComparisonRecord({ ...record, status: 'in_progress' });

    const result = await autoApproveEligibleProposals();

    expect(rows[0].status).toBe('staged');
    expect(result.approved).toBe(0);
    expect(result.rejected).toBe(0);
    expect(evidenceOf(21).comparisonStatus).toBe('unknown');
    // 粗い unknown フラグに加え、診断できるよう具体的な種別も残す。
    expect(evidenceOf(21).comparisonStatusKind).toBe('in_progress');
  });

  test('取得失敗の種別(破損/未作成)を区別して記録する', async () => {
    rows = [proposedRow(26, '- 提出前にlintを実行する'), proposedRow(27, '- 型チェックを通す')];
    await autoApproveEligibleProposals();
    expect(rows.every((r) => r.status === 'staged')).toBe(true);

    // 26 は破損、27 は記録そのものを失う。
    writeRawRecord(26, '{ broken json');
    rmSync(recordPath(27));

    await autoApproveEligibleProposals();

    expect(evidenceOf(26).comparisonStatusKind).toBe('corrupted');
    expect(evidenceOf(27).comparisonStatusKind).toBe('not_found');
    // いずれも採用も撤回もしない。
    expect(rows.every((r) => r.status === 'staged')).toBe(true);
  });

  test('記録が回復すれば unknown スタンプは片付けられる', async () => {
    rows = [proposedRow(30, '- 提出前にlintを実行する')];
    await autoApproveEligibleProposals();
    const record = readComparisonRecord(30)!;
    writeComparisonRecord({ ...record, status: 'in_progress' });
    await autoApproveEligibleProposals();
    expect(evidenceOf(30).comparisonStatus).toBe('unknown');

    writeComparisonRecord({ ...record, status: 'done' });
    await autoApproveEligibleProposals();

    expect(evidenceOf(30).comparisonStatus).toBeUndefined();
    expect(evidenceOf(30).comparisonStatusKind).toBeUndefined();
    expect(evidenceOf(30).comparisonVerdict).toBe('insufficient_data');
  });

  test('悪化を検出した候補は撤回(rejected)される', async () => {
    rows = [proposedRow(22, '- 提出前にlintを実行する')];
    await autoApproveEligibleProposals();
    fillArm(22, 'current', COMPARISON_MIN_SAMPLE, COMPARISON_MIN_SAMPLE);
    fillArm(22, 'candidate', 1, COMPARISON_MIN_SAMPLE);

    const result = await autoApproveEligibleProposals();

    expect(rows[0].status).toBe('rejected');
    expect(result.rejected).toBe(1);
    expect(evidenceOf(22).revertedReason).toBe('comparison_regression');
    expect(evidenceOf(22).comparisonVerdict).toBe('regressed');
  });

  test('改善を実測し AUTO_PROMOTE=true なら全体採用し、限定スコープを解除する', async () => {
    process.env.RAPITAS_PROMPT_AUTO_PROMOTE = 'true';
    rows = [proposedRow(23, '- 提出前にlintを実行する')];
    await autoApproveEligibleProposals();
    fillArm(23, 'current', 1, COMPARISON_MIN_SAMPLE);
    fillArm(23, 'candidate', COMPARISON_MIN_SAMPLE, COMPARISON_MIN_SAMPLE);

    const result = await autoApproveEligibleProposals();

    expect(rows[0].status).toBe('approved');
    expect(result.approved).toBe(1);
    expect(evidenceOf(23).comparisonVerdict).toBe('improved');
    expect(evidenceOf(23).comparisonSampleSize).toBe(COMPARISON_MIN_SAMPLE);
    // approvedAt が無いと settle の事後測定窓が開かない。
    expect(evidenceOf(23).approvedAt).toBeString();
    // 全体採用後は限定スコープが外れる(=全タスクへ適用される)。
    expect(readComparisonRecord(23)?.stagedTaskIds).toBeNull();
  });

  test('改善を実測し AUTO_PROMOTE 明示 false なら staged のまま保留される', async () => {
    process.env.RAPITAS_PROMPT_AUTO_PROMOTE = 'false';
    rows = [proposedRow(24, '- 提出前にlintを実行する')];
    await autoApproveEligibleProposals();
    fillArm(24, 'current', 1, COMPARISON_MIN_SAMPLE);
    fillArm(24, 'candidate', COMPARISON_MIN_SAMPLE, COMPARISON_MIN_SAMPLE);

    const result = await autoApproveEligibleProposals();

    expect(rows[0].status).toBe('staged');
    expect(result.approved).toBe(0);
    expect(evidenceOf(24).readyForPromotion).toBe(true);
    // 保留中は限定スコープを解除しない。
    expect(readComparisonRecord(24)?.stagedTaskIds).not.toBeNull();
  });

  test('AUTO_PROMOTE 未設定(既定)でも実測改善なら人手なしで全体採用される', async () => {
    // 既定オフのままでは「比較を通過しても永久に昇格しない」ため、
    // 環境変数を一切設定しない運用で採用まで到達することを固定する。
    rows = [proposedRow(28, '- 提出前にlintを実行する')];
    await autoApproveEligibleProposals();
    fillArm(28, 'current', 1, COMPARISON_MIN_SAMPLE);
    fillArm(28, 'candidate', COMPARISON_MIN_SAMPLE, COMPARISON_MIN_SAMPLE);

    const result = await autoApproveEligibleProposals();

    expect(rows[0].status).toBe('approved');
    expect(result.approved).toBe(1);
    expect(readComparisonRecord(28)?.stagedTaskIds).toBeNull();
  });

  test('僅差の改善は既定ONでも採用されない(有意性ゲートが効く)', async () => {
    // current 2/5・candidate 3/5 → delta=0.2 だが SE≈0.30 で 1.28*SE≈0.39。
    // 件数だけを見ていた旧判定はこれを improved にしていた。
    rows = [proposedRow(29, '- 提出前にlintを実行する')];
    await autoApproveEligibleProposals();
    fillArm(29, 'current', 2, COMPARISON_MIN_SAMPLE);
    fillArm(29, 'candidate', 3, COMPARISON_MIN_SAMPLE);

    const result = await autoApproveEligibleProposals();

    expect(rows[0].status).toBe('staged');
    expect(result.approved).toBe(0);
    expect(evidenceOf(29).comparisonVerdict).toBe('inconclusive');
  });

  test('全体採用時は同ロールの旧承認をsupersededにする(追記は常に1件)', async () => {
    process.env.RAPITAS_PROMPT_AUTO_PROMOTE = 'true';
    rows = [
      { ...proposedRow(25, '古い追記'), status: 'approved' },
      proposedRow(26, '- 提出前にlintを実行する'),
    ];
    await autoApproveEligibleProposals();
    fillArm(26, 'current', 1, COMPARISON_MIN_SAMPLE);
    fillArm(26, 'candidate', COMPARISON_MIN_SAMPLE, COMPARISON_MIN_SAMPLE);

    await autoApproveEligibleProposals();

    expect(rows[0].status).toBe('superseded');
    expect(rows[1].status).toBe('approved');
  });

  test('再実行しても同じ候補を二重に採用しない(停止・再起動後の再入)', async () => {
    process.env.RAPITAS_PROMPT_AUTO_PROMOTE = 'true';
    rows = [proposedRow(27, '- 提出前にlintを実行する')];
    await autoApproveEligibleProposals();
    fillArm(27, 'current', 1, COMPARISON_MIN_SAMPLE);
    fillArm(27, 'candidate', COMPARISON_MIN_SAMPLE, COMPARISON_MIN_SAMPLE);

    const first = await autoApproveEligibleProposals();
    const second = await autoApproveEligibleProposals();

    expect(first.approved).toBe(1);
    expect(second.approved).toBe(0);
    expect(rows.filter((r) => r.status === 'approved')).toHaveLength(1);
  });
});
