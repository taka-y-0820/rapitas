/**
 * verify-commit-pr-pipeline テスト
 *
 * 履歴汚染リカバリ後の再試行（performAutoCommitAndPR の2回目呼び出し）が
 * 完了するまで runVerifyCommitPrPipeline の戻り値Promiseが解決しないことを
 * 検証する。task 657 の受入基準（リカバリ・再試行の実行中に in-flight が
 * true を返す）は、この Promise 全体を registerVerifyCompletion に渡す
 * verify-commit-pr.ts 側で担保される（別テスト
 * verify-commit-pr-inflight-coverage.test.ts）。ここではその「全体を覆う
 * 1つの Promise」がリカバリ・再試行の完了まで実際に解決しないことを
 * 直接検証する。
 */
import { describe, expect, test, mock } from 'bun:test';
import type { CompletionReviewReceipt } from '../../../../services/workflow/requirement-replan-commit';
const receipt: CompletionReviewReceipt = {
  taskId: 653,
  executionId: 1,
  evaluatedUpdatedAt: new Date(),
  review: {
    snapshotDigest: 'test',
    durationMs: 1,
    tokensUsed: 1,
    modelName: null,
    verdict: { kind: 'no_mismatch', reason: 'test' },
  },
};
const completeReview = mock(async (_db: unknown, _receipt: unknown, _completion: unknown) => ({
  committed: true,
  reason: 'verify_passed',
}));
const preflight = mock(async () => undefined);
mock.module('../../../../services/workflow/requirement-replan-commit', () => ({
  assertReviewedTaskCurrent: preflight,
  completeReviewedTask: completeReview,
}));

mock.module('../../../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

mock.module('../../../../config', () => ({
  prisma: {
    task: {
      updateMany: mock(() => Promise.resolve({ count: 1 })),
      update: mock(() => Promise.resolve({})),
      findUnique: mock(() => Promise.resolve({ githubPrId: null })),
    },
    gitHubPullRequest: { findFirst: mock(() => Promise.resolve(null)) },
    agentSession: { findFirst: mock(() => Promise.resolve({ worktreePath: '/tmp/wt' })) },
  },
}));

mock.module('../../../../services/workflow/transition-recorder', () => ({
  recordTransition: mock(() => Promise.resolve()),
}));
mock.module('../../../../services/workflow/automation-policy', () => ({
  resolveLandingMode: (policy: { autoMergePR?: boolean }) =>
    policy.autoMergePR ? 'merge' : 'none',
}));
const markLatestExecutionFailedMock = mock(() => Promise.resolve());
mock.module('./shared', () => ({
  markLatestExecutionFailed: markLatestExecutionFailedMock,
}));
mock.module('./verify-commit-pr-gate-blocked', () => ({
  handleVerifyGateBlocked: mock(() => Promise.resolve({})),
}));
const sideEffectsCalls: number[] = [];
mock.module('./verify-commit-pr-side-effects', () => ({
  runVerifyCompletionSideEffects: (taskId: number) => {
    sideEffectsCalls.push(taskId);
  },
}));

mock.module('../../../../services/workflow/worktree-rebuild-recovery', () => ({
  tryRecoverFromHistoryContamination: mock(() => Promise.resolve({ recovered: true })),
  notifyRecoveryFallbackBlocked: mock(() => Promise.resolve()),
}));

// First call: blocked by the verification gate (history contamination).
// Second call (the post-recovery retry) is resolved manually by the test —
// stands in for the task-653 timeline where the retry finished well past a
// naive 60s settle window.
let resolveRetry: ((result: Record<string, unknown>) => void) | null = null;
let autoCommitCallCount = 0;
const performAutoCommitAndPRMock = mock(() => {
  autoCommitCallCount++;
  if (autoCommitCallCount === 1) {
    return Promise.resolve({
      verificationBlocked: true,
      requested: { autoCommit: true, autoCreatePR: true, autoMergePR: false },
    });
  }
  return new Promise((resolve) => {
    resolveRetry = resolve;
  });
});
mock.module('../../workflow-auto-commit', () => ({
  performAutoCommitAndPR: performAutoCommitAndPRMock,
  isNoChangeCompletion: () => false,
}));

const { runVerifyCommitPrPipeline } = await import('./verify-commit-pr-pipeline');

describe('requested merge is a completion requirement', () => {
  test.each([undefined, 'false', 'true'])(
    'keeps deferred merge pending with staged=%s',
    async (flag) => {
      const previous = process.env.RAPITAS_STAGED_COMPLETION;
      if (flag === undefined) delete process.env.RAPITAS_STAGED_COMPLETION;
      else process.env.RAPITAS_STAGED_COMPLETION = flag;
      performAutoCommitAndPRMock.mockImplementationOnce(() =>
        Promise.resolve({
          requested: { autoCommit: true, autoCreatePR: true, autoMergePR: true },
          autoCommitResult: { success: true, filesChanged: 0 },
          autoPRResult: { success: true, prNumber: 623 },
          autoMergeResult: { success: false, deferred: true },
        }),
      );
      const before = sideEffectsCalls.length;
      try {
        const outcome = await runVerifyCommitPrPipeline({
          taskId: 897,
          completionReceipt: { ...receipt, taskId: 897 },
          savedContent: '# 検証結果',
          preferredBaseBranchForVerify: null,
        });
        expect(outcome.taskMarkedDone).toBe(false);
        expect(outcome.newStatus).toBe('verify_done');
        expect(sideEffectsCalls.length).toBe(before);
      } finally {
        sideEffectsCalls.splice(before);
        if (previous === undefined) delete process.env.RAPITAS_STAGED_COMPLETION;
        else process.env.RAPITAS_STAGED_COMPLETION = previous;
      }
    },
  );
});

describe('runVerifyCommitPrPipeline — リカバリ後の再試行を待つこと', () => {
  test('再試行(2回目の performAutoCommitAndPR)が解決するまでパイプラインが完了しないこと', async () => {
    let settled = false;
    const work = runVerifyCommitPrPipeline({
      completionReceipt: receipt,
      taskId: 653,
      savedContent: '# 検証結果',
      preferredBaseBranchForVerify: null,
    }).then((outcome) => {
      settled = true;
      return outcome;
    });

    // 1回目の呼び出し(ゲートブロック)とリカバリ判定(動的importを含む)が
    // 進むまで待つ — マイクロタスクだけでなく実I/Oを跨ぐためポーリングする。
    const deadline = Date.now() + 2000;
    while (autoCommitCallCount < 2) {
      if (Date.now() > deadline)
        throw new Error('2回目の performAutoCommitAndPR 呼び出し待ちでタイムアウト');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(settled).toBe(false); // リカバリ後の再試行がまだ解決していない
    expect(autoCommitCallCount).toBe(2);

    resolveRetry?.({
      autoCommitResult: { success: true, filesChanged: 3 },
      autoPRResult: { success: true, prNumber: 454 },
      requested: { autoCommit: true, autoCreatePR: true, autoMergePR: false },
    });

    const outcome = await work;
    expect(settled).toBe(true);
    expect(outcome.taskMarkedDone).toBe(true);
    expect(outcome.newStatus).toBe('completed');
    expect(sideEffectsCalls).toEqual([653]);
  });
});

test('a stale review after PR work cannot trigger completion side effects', async () => {
  performAutoCommitAndPRMock.mockImplementationOnce(() =>
    Promise.resolve({
      autoPRResult: { success: true, prNumber: 1 },
      requested: { autoCommit: true, autoCreatePR: true, autoMergePR: false },
    }),
  );
  completeReview.mockResolvedValueOnce({ committed: false, reason: 'stop_not_resumed' });
  const before = sideEffectsCalls.length;
  await expect(
    runVerifyCommitPrPipeline({
      taskId: 653,
      savedContent: '# verify',
      preferredBaseBranchForVerify: null,
      completionReceipt: receipt,
    }),
  ).rejects.toThrow('Reviewed completion held');
  expect(sideEffectsCalls.length).toBe(before);
});

describe('runVerifyCommitPrPipeline — PR未作成時の失敗メッセージ（task 793）', () => {
  test('prRequested && !prSatisfied で、軽量な自動リトライが控えている旨を markLatestExecutionFailed に伝えること', async () => {
    markLatestExecutionFailedMock.mockClear();
    performAutoCommitAndPRMock.mockImplementationOnce(() =>
      Promise.resolve({
        verificationBlocked: false,
        requested: { autoCommit: true, autoCreatePR: true, autoMergePR: false },
        autoCommitResult: { success: true, filesChanged: 1 },
        autoPRResult: { success: false, error: 'PR作成に失敗しました' },
      }),
    );

    await runVerifyCommitPrPipeline({
      taskId: 793,
      completionReceipt: { ...receipt, taskId: 793 },
      savedContent: '# 検証結果',
      preferredBaseBranchForVerify: null,
    });

    expect(markLatestExecutionFailedMock).toHaveBeenCalledWith(
      793,
      expect.stringContaining('数分以内にPR再作成のみを行う軽量な自動リトライが1回行われます'),
    );
  });
});

test('a stopped preflight prevents any commit or PR attempt', async () => {
  const before = performAutoCommitAndPRMock.mock.calls.length;
  preflight.mockRejectedValueOnce(new Error('stop_not_resumed'));
  await expect(
    runVerifyCommitPrPipeline({
      taskId: 653,
      savedContent: 'PASS',
      preferredBaseBranchForVerify: null,
      completionReceipt: receipt,
    }),
  ).rejects.toThrow('stop_not_resumed');
  expect(performAutoCommitAndPRMock.mock.calls.length).toBe(before);
});
