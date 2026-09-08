/**
 * status-transition テスト
 *
 * task 710: 非収束カットオフ時の `verify_validation_failed` 二重記録防止を
 * `repair.cutoffRecorded`（attemptVerifyRepair 呼び出し自身が返す帯域内シグナル）
 * で検証する。task 674/705 で導入された DB 読み取りガード
 * (wasNonConvergenceCutoffJustRecorded) は task 715 で同一事象が再発した実測が
 * あり単独では不十分 — このテストは DB 読み取りガードがすり抜けるケース
 * （false を返す）を模擬しても、cutoffRecorded フラグ単体で冗長な
 * recordTransition を止めることを実証する。ブロック処理・実行失敗マークは
 * cutoffRecorded の値に関わらず従来どおり実行されることも検証する。
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';

mock.module('../../../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const mockTaskUpdate = mock(() => Promise.resolve({})) as any;
const mockWorkflowTransitionFindFirst = mock(() => Promise.resolve(null)) as any;
const mockPrisma = {
  task: {
    update: mockTaskUpdate,
    findUnique: mock(() => Promise.resolve(null as { githubPrId: number } | null)),
  },
  workflowTransition: { findFirst: mockWorkflowTransitionFindFirst },
};
mock.module('../../../../config', () => ({ prisma: mockPrisma }));

mock.module('../../../../services/workflow/completion-gate', () => ({
  researchConcludesNoChange: () => false,
}));

const transitionCalls: Array<{ cause: string }> = [];
const mockRecordTransition = mock((args: { cause: string }) => {
  transitionCalls.push(args);
  return Promise.resolve();
}) as any;
mock.module('../../../../services/workflow/transition-recorder', () => ({
  recordTransition: mockRecordTransition,
}));

mock.module('../../../../services/workflow/workflow-invariants', () => ({
  checkWorkflowInvariants: mock(() => Promise.resolve([])),
}));

const mockMarkLatestExecutionFailed = mock(() => Promise.resolve()) as any;
// The DB-read guard is forced to `false` throughout — simulating the task 715
// recurrence where this guard alone failed to catch the duplicate — so every
// test here isolates whether `repair.cutoffRecorded` alone stops the record.
const mockWasNonConvergenceCutoffJustRecorded = mock(() => Promise.resolve(false)) as any;
mock.module('./shared', () => ({
  markLatestExecutionFailed: mockMarkLatestExecutionFailed,
  wasNonConvergenceCutoffJustRecorded: mockWasNonConvergenceCutoffJustRecorded,
}));

const mockValidateVerify = mock(() => ({
  ok: false,
  missingSections: [],
  severity: 80,
  summary: 'verify.md self-contradicts',
}));
mock.module('../../../../services/workflow/phase-output-validator', () => ({
  validateVerify: mockValidateVerify,
}));

const mockAttemptVerifyRepair = mock(() => Promise.resolve({ bounced: false })) as any;
mock.module('../../../../services/workflow/verify-self-repair', () => ({
  attemptVerifyRepair: mockAttemptVerifyRepair,
}));

const { computeAndApplyStatusTransition } = await import('./status-transition');

function buildParams() {
  return {
    taskId: 715,
    fileType: 'verify' as const,
    currentStatus: 'in_progress',
    savedContent: 'verify body',
  };
}

describe('computeAndApplyStatusTransition — 非収束カットオフの二重記録防止', () => {
  beforeEach(() => {
    mockValidateVerify.mockReset().mockReturnValue({
      ok: false,
      missingSections: [],
      severity: 80,
      summary: 'verify.md self-contradicts',
    });
    transitionCalls.length = 0;
    mockRecordTransition.mockClear();
    mockTaskUpdate.mockClear();
    mockPrisma.task.findUnique.mockReset().mockResolvedValue(null);
    mockMarkLatestExecutionFailed.mockClear();
    mockWorkflowTransitionFindFirst.mockReset().mockResolvedValue(null);
    mockAttemptVerifyRepair.mockReset().mockResolvedValue({ bounced: false });
  });

  test('a prior pass and existing PR cannot override the current partial verdict', async () => {
    mockWorkflowTransitionFindFirst.mockResolvedValue({ id: 1 });
    mockPrisma.task.findUnique.mockResolvedValue({ githubPrId: 100 });
    mockAttemptVerifyRepair.mockResolvedValue({ bounced: true, newStatus: 'plan_approved' });
    const result = await computeAndApplyStatusTransition({
      ...buildParams(),
      savedContent: '| 全体判定 | ⚠️ 一部失敗 |',
    });
    expect(result.newStatus).toBe('plan_approved');
    expect(mockAttemptVerifyRepair).toHaveBeenCalledTimes(1);
  });

  for (const [severity, savedContent] of [
    [80, '✅ 検証成功\n2 failed'],
    [90, '実装済みのはずだが空diffで❌ 実装漏れと誤検知された本文'],
    [100, '[Claude Code] Starting execution...'],
    [100, ''],
  ] as const) {
    test(`current failure ${severity}: ${JSON.stringify(savedContent)} cannot be rescued by a prior pass and PR`, async () => {
      mockWorkflowTransitionFindFirst.mockResolvedValue({ id: 1 });
      mockPrisma.task.findUnique.mockResolvedValue({ githubPrId: 100 });
      mockValidateVerify.mockReturnValue({
        ok: false,
        missingSections: [],
        severity,
        summary: 'current validation failed',
      });
      mockAttemptVerifyRepair.mockResolvedValue({ bounced: true, newStatus: 'plan_approved' });
      const result = await computeAndApplyStatusTransition({ ...buildParams(), savedContent });
      expect(result.newStatus).toBe('plan_approved');
      expect(result.verifyRerunAlreadyDone).toBe(false);
      expect(mockAttemptVerifyRepair).toHaveBeenCalledTimes(1);
      expect(mockTaskUpdate).not.toHaveBeenCalled();
    });
  }

  test('cutoffRecorded:true なら DB 読み取りガードが false でも verify_validation_failed を記録しないこと', async () => {
    mockAttemptVerifyRepair.mockResolvedValueOnce({ bounced: false, cutoffRecorded: true });

    const result = await computeAndApplyStatusTransition(buildParams());

    expect(transitionCalls.some((c) => c.cause === 'verify_validation_failed')).toBe(false);
    // ブロック処理・実行失敗マークは cutoffRecorded の値に関わらず従来どおり実行される。
    expect(mockTaskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 715 },
        data: expect.objectContaining({ status: 'blocked' }),
      }),
    );
    expect(mockMarkLatestExecutionFailed).toHaveBeenCalledTimes(1);
    expect(result.newStatus).toBeUndefined();
  });

  test('cutoffRecorded が undefined（予算枯渇など非収束カットオフ以外）なら従来どおり記録すること', async () => {
    mockAttemptVerifyRepair.mockResolvedValueOnce({ bounced: false });

    await computeAndApplyStatusTransition(buildParams());

    expect(transitionCalls.filter((c) => c.cause === 'verify_validation_failed')).toHaveLength(1);
    expect(mockTaskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 715 },
        data: expect.objectContaining({ status: 'blocked' }),
      }),
    );
  });
});
