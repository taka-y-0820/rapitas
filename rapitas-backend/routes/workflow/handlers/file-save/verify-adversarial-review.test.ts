/**
 * verify-adversarial-review テスト
 *
 * task 710: 非収束カットオフ時の `adversarial_review_failed` 二重記録防止を
 * `repair.cutoffRecorded`（attemptVerifyRepair 呼び出し自身が返す帯域内シグナル）
 * で検証する。task 674/705 で導入された DB 読み取りガード
 * (wasNonConvergenceCutoffJustRecorded) は task 715 で同一事象が再発した実測が
 * あり単独では不十分 — このテストは DB 読み取りガードがすり抜けるケース
 * （false を返す）を模擬しても、cutoffRecorded フラグ単体で冗長な
 * recordTransition を止めることを実証する。ブロック処理・実行失敗マークは
 * cutoffRecorded の値に関わらず従来どおり実行されることも検証する。
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';

const warnCalls: Array<[unknown, string]> = [];
mock.module('../../../../config/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: (fields: unknown, msg: string) => {
      warnCalls.push([fields, msg]);
    },
    error: () => {},
    debug: () => {},
  }),
}));

const mockFindUnique = mock(() =>
  Promise.resolve({ workflowStatus: 'verify_done', updatedAt: new Date(0) }),
) as any;
const mockTaskUpdate = mock(() => Promise.resolve({})) as any;
const mockUpdateMany = mock(() => Promise.resolve({ count: 1 })) as any;
const mockPrisma = {
  task: { findUnique: mockFindUnique, update: mockTaskUpdate, updateMany: mockUpdateMany },
  agentSession: { findFirst: mock(() => Promise.resolve({ worktreePath: '/wt/1' })) },
};
mock.module('../../../../config', () => ({ prisma: mockPrisma }));

const transitionCalls: Array<{ cause: string }> = [];
const mockRecordTransition = mock((args: { cause: string }) => {
  transitionCalls.push(args);
  return Promise.resolve();
}) as any;
mock.module('../../../../services/workflow/transition-recorder', () => ({
  recordTransition: mockRecordTransition,
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

const mockReviewDiffAdversarially = mock(() =>
  Promise.resolve({ verdict: 'fail', severity: 92, reasons: ['実装が空'] }),
) as any;
mock.module('../../../../services/agents/verification/adversarial-diff-review', () => ({
  reviewDiffAdversarially: mockReviewDiffAdversarially,
}));

mock.module('../../../../services/workflow/worktree-rebuild-recovery', () => ({
  tryRecoverFromHistoryContamination: mock(() =>
    Promise.resolve({ recovered: false, reason: 'no_offending_files' }),
  ),
  notifyRecoveryFallbackBlocked: mock(() => Promise.resolve()),
}));

const mockAttemptVerifyRepair = mock(() => Promise.resolve({ bounced: false })) as any;
mock.module('../../../../services/workflow/verify-self-repair', () => ({
  attemptVerifyRepair: mockAttemptVerifyRepair,
}));

const { runAdversarialDiffReview } = await import('./verify-adversarial-review');

function buildParams() {
  return {
    taskId: 715,
    fileType: 'verify' as const,
    newStatus: 'verify_done',
    verifyGateBlocked: false,
    isConflictResolutionTask: false,
    savedContent: 'verify body',
    preferredBaseBranchForVerify: null,
  };
}

describe('runAdversarialDiffReview — 非収束カットオフの二重記録防止', () => {
  beforeEach(() => {
    transitionCalls.length = 0;
    warnCalls.length = 0;
    mockRecordTransition.mockClear();
    mockTaskUpdate.mockClear();
    mockMarkLatestExecutionFailed.mockClear();
    mockFindUnique
      .mockReset()
      .mockResolvedValue({ workflowStatus: 'verify_done', updatedAt: new Date(0) });
    mockAttemptVerifyRepair.mockReset().mockResolvedValue({ bounced: false });
  });

  test('cutoffRecorded:true なら DB 読み取りガードが false でも adversarial_review_failed を記録しないこと', async () => {
    mockAttemptVerifyRepair.mockResolvedValueOnce({ bounced: false, cutoffRecorded: true });

    const result = await runAdversarialDiffReview(buildParams());

    expect(transitionCalls.some((c) => c.cause === 'adversarial_review_failed')).toBe(false);
    // ブロック処理・実行失敗マークは cutoffRecorded の値に関わらず従来どおり実行される。
    expect(mockTaskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 715, updatedAt: new Date(0) },
        data: expect.objectContaining({ status: 'blocked' }),
      }),
    );
    expect(mockMarkLatestExecutionFailed).toHaveBeenCalledTimes(1);
    expect(result.verifyGateBlocked).toBe(true);
  });

  test('cutoffRecorded が undefined（予算枯渇など非収束カットオフ以外）なら従来どおり記録すること', async () => {
    mockAttemptVerifyRepair.mockResolvedValueOnce({ bounced: false });

    await runAdversarialDiffReview(buildParams());

    expect(transitionCalls.filter((c) => c.cause === 'adversarial_review_failed')).toHaveLength(1);
    expect(mockTaskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 715, updatedAt: new Date(0) },
        data: expect.objectContaining({ status: 'blocked' }),
      }),
    );
  });
});

describe('runAdversarialDiffReview — stale-verdict compare-and-swap (task 783)', () => {
  beforeEach(() => {
    transitionCalls.length = 0;
    warnCalls.length = 0;
    mockRecordTransition.mockClear();
    mockTaskUpdate.mockClear();
    mockMarkLatestExecutionFailed.mockClear();
    mockFindUnique
      .mockReset()
      .mockResolvedValue({ workflowStatus: 'verify_done', updatedAt: new Date(0) });
    mockAttemptVerifyRepair.mockReset().mockResolvedValue({ bounced: false });
  });

  test('タスクが verify_done から既に離脱していれば rollback を完全にスキップし reasons 付きで警告すること', async () => {
    mockFindUnique.mockReset().mockResolvedValue({ workflowStatus: 'completed' });

    const result = await runAdversarialDiffReview(buildParams());

    expect(result.staleVerifyRequest).toBe(true);
    expect(result.newStatus).toBe('completed');
    expect(result.verifyGateBlocked).toBe(false);
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(transitionCalls).toHaveLength(0);

    const staleWarn = warnCalls.find(
      ([, msg]) =>
        msg ===
        '[Workflow] Adversarial review FAIL arrived after the workflow moved on — skipping rollback entirely',
    );
    expect(staleWarn).toBeDefined();
    expect((staleWarn?.[0] as { reasons?: string[] })?.reasons).toEqual(['実装が空']);
  });
});
