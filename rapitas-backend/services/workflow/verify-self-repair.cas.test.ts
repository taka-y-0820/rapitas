/**
 * verify-self-repair.cas.test
 *
 * attemptVerifyRepair の compare-and-swap 検証: 評価時点の workflowStatus から
 * タスクが先へ進んでいた場合（遅延 verdict — task 551 で completed 済みタスクが
 * plan_approved へ巻き戻された事故）に、rollback もフィードバック書込も行わず
 * `stale:true` を返すこと。純関数テスト（verify-self-repair.test.ts）とは
 * mock.module 汚染を避けるため別ファイル。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const evaluatedAt = new Date('2026-09-08T00:00:00Z');
let taskWorkflowStatus = 'verify_done';
const taskRow = () => ({
  status: 'in-progress',
  workflowStatus: taskWorkflowStatus,
  updatedAt: evaluatedAt,
  themeId: null,
  acceptanceCriteria: null,
});

const noopLogger = { info: () => {}, warn: mock(() => {}), error: () => {}, debug: () => {} };

const mockPrisma = {
  userSettings: { findFirst: mock(() => Promise.resolve(null)) },
  activityLog: { findFirst: mock(() => Promise.resolve(null)) },
  workflowTransition: {
    count: mock(() => Promise.resolve(0)),
    findFirst: mock(() => Promise.resolve(null)),
    // task 619 の非収束判定は過去の repair 理由を読む。既定 [] は criteria 空の
    // 短絡（verify-self-repair.ts:143）に先回りされ、既存 CAS ケースを不変に保つ。
    findMany: mock(() => Promise.resolve([] as { metadata: string | null }[])),
  },
  task: {
    updateMany: mock(() => Promise.resolve({ count: 1 })),
    findFirst: mock(() => Promise.resolve(null)),
    findUnique: mock(() => Promise.resolve(null)),
  },
  workflowFile: { findFirst: mock(() => Promise.resolve(null)) },
};
const readWorkflowFile = mock(() => Promise.resolve(''));
const writeWorkflowFile = mock(() => Promise.resolve());
const recordTransition = mock(() => Promise.resolve());
Object.assign(mockPrisma, {
  $transaction: async (operation: (tx: typeof mockPrisma) => unknown) => operation(mockPrisma),
  agentExecution: { findFirst: async () => null },
  themeAutoRun: { findUnique: async () => null },
});
Object.assign(mockPrisma.workflowFile, { findUnique: () => mockPrisma.workflowFile.findFirst() });
Object.assign(mockPrisma.workflowTransition, {
  create: async (args: { data: { metadata: string } }) =>
    (recordTransition as (...args: unknown[]) => Promise<void>)({
      ...args.data,
      metadata: JSON.parse(args.data.metadata),
    }),
});

mock.module('../../config/logger', () => ({ createLogger: () => noopLogger }));
mock.module('../../config/database', () => ({
  prisma: mockPrisma,
  ensureDatabaseConnection: () => Promise.resolve(),
}));
mock.module('./workflow-file-utils', () => ({ readWorkflowFile, writeWorkflowFile }));
mock.module('./transition-recorder', () => ({ recordTransition }));
// ensureRunnerResumes は auto-run active で早期 return する — 実 Runner/Queue の
// 起動（副作用）をテストプロセスに持ち込まないための最小モック。
mock.module('./auto-run/theme-auto-run-service', () => ({
  isThemeAutoRunActive: () => Promise.resolve(true),
}));
// 非収束カットオフ経路は escalateBlockedTask を dynamic import する。実 DB 副作用を
// 持ち込まないよう spy 化（フルミラー必須 — mock.module はモジュール全体を置換する）。
const escalateBlockedTask = mock(() => Promise.resolve(true));
mock.module('./blocked-task-escalation', () => ({
  escalateBlockedTask,
  BLOCKED_ESCALATED_CAUSE: 'blocked_escalated',
  countEscalatedBlocked: () => Promise.resolve(0),
}));

const { attemptVerifyRepair } = await import('./verify-self-repair');

describe('attemptVerifyRepair — stale-verdict CAS guard', () => {
  beforeEach(() => {
    taskWorkflowStatus = 'verify_done';
    mockPrisma.task.findUnique
      .mockReset()
      .mockImplementation(async () => taskRow() as unknown as null);
    mockPrisma.userSettings.findFirst.mockReset().mockResolvedValue(null);
    mockPrisma.activityLog.findFirst.mockReset().mockResolvedValue(null);
    mockPrisma.workflowTransition.count.mockReset().mockResolvedValue(0);
    mockPrisma.task.updateMany.mockReset().mockResolvedValue({ count: 1 });

    // resolveImplementEntryStatus checks the WorkflowFile row for plan.md
    mockPrisma.workflowFile.findFirst.mockReset().mockResolvedValue({ id: 1 } as unknown as null);
    readWorkflowFile.mockReset().mockResolvedValue('# plan');
    writeWorkflowFile.mockReset().mockResolvedValue(undefined);
    recordTransition.mockReset().mockResolvedValue(undefined);
  });

  test('stopped task with unchanged workflow status cannot be repaired', async () => {
    const stopped = { status: 'todo', workflowStatus: 'verify_done' };
    mockPrisma.task.updateMany.mockImplementation((...args: unknown[]) => {
      const query = args[0] as { where: { status?: string; workflowStatus: string } };
      return Promise.resolve({
        count:
          (query.where.status === undefined || query.where.status === stopped.status) &&
          query.where.workflowStatus === stopped.workflowStatus
            ? 1
            : 0,
      });
    });
    expect(await attemptVerifyRepair(551, 'verify_done', 'reason', 'verify body')).toEqual({
      bounced: false,
      stale: true,
    });
    expect(writeWorkflowFile).not.toHaveBeenCalled();
    expect(recordTransition).not.toHaveBeenCalled();
  });

  test('unreadable plan cannot select a plan-less implementation entry', async () => {
    mockPrisma.workflowFile.findFirst.mockRejectedValueOnce(new Error('plan read unavailable'));
    await expect(attemptVerifyRepair(551, 'verify_done', 'reason', 'verify body')).rejects.toThrow(
      'plan read unavailable',
    );
    expect(mockPrisma.task.updateMany).not.toHaveBeenCalled();
    expect(writeWorkflowFile).not.toHaveBeenCalled();
    expect(recordTransition).not.toHaveBeenCalled();
  });

  test('resume failure is surfaced instead of reporting a successful bounce', async () => {
    mockPrisma.task.findUnique.mockImplementation((...args: unknown[]) => {
      const query = args[0] as { select?: { status?: boolean; updatedAt?: boolean } };
      if (query.select?.status && !query.select.updatedAt)
        return Promise.reject(new Error('resume read unavailable'));
      return Promise.resolve(taskRow() as unknown as null);
    });
    await expect(attemptVerifyRepair(551, 'verify_done', 'reason', 'verify body')).rejects.toThrow(
      'resume read unavailable',
    );
    expect(recordTransition).toHaveBeenCalledTimes(1);
  });

  test('database failure is not reported as a harmless stale verdict', async () => {
    mockPrisma.task.updateMany.mockRejectedValue(new Error('database unavailable'));
    await expect(attemptVerifyRepair(551, 'verify_done', 'reason', 'verify body')).rejects.toThrow(
      'database unavailable',
    );
    expect(writeWorkflowFile).not.toHaveBeenCalled();
    expect(recordTransition).not.toHaveBeenCalled();
  });

  test('CASが一致すれば通常どおり bounce する（plan有→plan_approved）', async () => {
    const result = await attemptVerifyRepair(551, 'verify_done', 'reason', 'verify body');
    expect(result.bounced).toBe(true);
    expect(result.stale).toBeUndefined();
    expect(result.newStatus).toBe('plan_approved');
    const call = mockPrisma.task.updateMany.mock.calls[0]?.[0] as {
      where: { id: number; workflowStatus: unknown };
    };
    // ガード条件が評価時点のステータスを固定していること（task 551 の再発防止）。
    expect(call.where).toEqual({
      id: 551,
      status: 'in-progress',
      workflowStatus: 'verify_done',
      updatedAt: evaluatedAt,
    });
    expect(writeWorkflowFile).toHaveBeenCalled();
    expect(recordTransition).toHaveBeenCalled();
  });

  test('評価中にステータスが進んでいたら(CAS 0件) 巻き戻しもフィードバック書込もしない', async () => {
    // task 551 の再現: 修正plan で re-verify が合格し completed + PR#351 済みのところへ
    // 旧 verify への遅延 verdict が到着。completed を plan_approved に戻してはならない。
    mockPrisma.task.updateMany.mockResolvedValue({ count: 0 });
    const result = await attemptVerifyRepair(551, 'verify_done', 'reason', 'verify body');
    expect(result).toEqual({ bounced: false, stale: true });
    // フィードバックは CAS 成立後にのみ書く — 合格済み verify.md を汚染しない。
    expect(writeWorkflowFile).not.toHaveBeenCalled();
    expect(recordTransition).not.toHaveBeenCalled();
  });

  test('スナップショットが completed なら即 stale（終端状態は絶対に巻き戻さない）', async () => {
    const result = await attemptVerifyRepair(551, 'completed', 'reason', 'verify body');
    expect(result).toEqual({ bounced: false, stale: true });
    expect(mockPrisma.task.updateMany).not.toHaveBeenCalled();
  });

  test('スナップショット無し(null)は terminal を除外する notIn ガードで巻き戻す', async () => {
    taskWorkflowStatus = 'in_progress';
    const result = await attemptVerifyRepair(551, null, 'reason', 'verify body');
    expect(result.bounced).toBe(true);
    const call = mockPrisma.task.updateMany.mock.calls[0]?.[0] as {
      where: { id: number; workflowStatus: unknown };
    };
    expect(call.where.workflowStatus).toBe('in_progress');
  });

  test('修復上限到達は従来どおり stale なしの bounced:false（callerがblockしてよい）', async () => {
    mockPrisma.workflowTransition.count.mockResolvedValue(99);
    const result = await attemptVerifyRepair(551, 'verify_done', 'reason', 'verify body');
    expect(result.bounced).toBe(false);
    expect(result.stale).toBeUndefined();
    // 予算枯渇は非収束カットオフではない — cutoffRecorded は立たず、caller は自分の
    // verify_validation_failed を記録してよい（下の非収束ケースとの対照）。
    expect(result.cutoffRecorded).toBeUndefined();
  });

  // task 710 の根治点の回帰ピン: 非収束カットオフ経路が「自分で終端遷移を記録し、
  // cutoffRecorded=true で caller にそれを伝える」ことを実 production コード
  // (verify-self-repair.ts:400) を走らせて実証する。caller
  // (status-transition.ts / verify-adversarial-review.ts) はこのフラグと
  // wasNonConvergenceCutoffJustRecorded を見て自分の verify_validation_failed /
  // adversarial_review_failed を記録しない — これが #674 で観測された
  // verify_repair_non_convergence の 43ms 後に adversarial_review_failed が
  // 二重記録され反復ループ誤検出を招いたバグの根本原因対策。
  test('非収束カットオフは自ら verify_repair_non_convergence を記録し cutoffRecorded:true を返す', async () => {
    // task 614 実データ型フィクスチャ（verify-self-repair.test.ts と同型）:
    // 受入基準1が R1・R3 の2回指摘され、収束していない。
    const CRITERIA_JSON = JSON.stringify([
      'tests/services/test-triage.test.ts のすべてのテストが成功する',
      '`detectRepeatLoop` が bounce 回数との対応関係を検証する',
      '`escalateBlockedTask` が通知を送る',
    ]);
    const R1 =
      '受入基準1「tests/services/test-triage.test.ts のすべてのテストが成功する」が一切対応されていない';
    const R2 =
      'detectRepeatLoop の phase_completed:* 除外が bounce 回数との対応関係を検証していない';
    const R3 =
      '受入基準1 に対して diff は test-triage.test.ts を一切変更しておらず、元原因にも触れていない';
    taskWorkflowStatus = 'in_progress';
    mockPrisma.task.findUnique.mockResolvedValue({
      ...taskRow(),
      themeId: 5,
      title: '対象タスク',
      acceptanceCriteria: CRITERIA_JSON,
    } as unknown as null);
    mockPrisma.workflowTransition.findMany.mockResolvedValue(
      [R1, R2].map((reason, i) => ({
        metadata: JSON.stringify({ attempt: i + 1, max: 10, reason }),
      })),
    );

    const result = await attemptVerifyRepair(614, 'in_progress', R3, 'verify body');

    // 終端シグナル: production が実際に cutoffRecorded を立てる（trivial でない）。
    expect(result.bounced).toBe(false);
    expect(result.stale).toBeUndefined();
    expect(result.cutoffRecorded).toBe(true);
    // このカットオフ経路自身が唯一の終端遷移として非収束 cause を記録する。
    expect(recordTransition).toHaveBeenCalledTimes(1);
    const rt = recordTransition.mock.calls[0]?.[0] as { cause: string };
    expect(rt.cause).toBe('verify_repair_non_convergence');
    // 実装フェーズへは戻さずエスカレーションする（bounce しない証跡）。
    expect(escalateBlockedTask).toHaveBeenCalledTimes(1);
  });
});
