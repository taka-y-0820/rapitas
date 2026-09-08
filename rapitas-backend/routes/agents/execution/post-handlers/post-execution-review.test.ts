/**
 * post-execution-review ユニットテスト (task 895)
 *
 * 非ワークフロー単発実行の公開パイプラインが
 * (1) autoMergePR 要求時に PR 作成だけで done にしないこと、
 * (2) 停止が永続化された時点以降の commit / PR / worktree削除 / 完了を
 *     一切行わないこと
 * を検証する。この経路は独自の commit/PR コードを持つため
 * performAutoCommitAndPR のガードを継承しない。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

mock.module('../../../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const taskFindUnique = mock(
  () => Promise.resolve({ workflowStatus: 'in_progress' }) as ReturnType<typeof mock>,
);
const taskUpdate = mock(() => Promise.resolve({}));
mock.module('../../../../config/database', () => ({
  prisma: {
    task: { findUnique: taskFindUnique, update: taskUpdate },
    workflowFile: { findFirst: mock(() => Promise.resolve({ id: 1 })) },
    agentExecution: { findFirst: mock(() => Promise.resolve({ agentConfig: null })) },
    agentSession: { update: mock(() => Promise.resolve({})) },
  },
}));

/** Ordered log of the irreversible steps, so "nothing after the stop" is provable. */
const steps: string[] = [];

const createCommit = mock(() => {
  steps.push('commit');
  return Promise.resolve({ hash: 'abc123' });
});
mock.module('../../../../services/agents/orchestrator/git-operations/core/core-ops', () => ({
  createCommit,
}));

const createPullRequest = mock(() => {
  steps.push('pr');
  return Promise.resolve({ success: true, prUrl: 'https://x/pr/9', prNumber: 9 });
});
mock.module('../../../../services/agents/orchestrator/git-operations/pr/branch-pr-ops', () => ({
  createPullRequest,
}));

mock.module('../../../../services/workflow/auto-merge-notify', () => ({
  notify: mock(() => Promise.resolve()),
}));

mock.module('../../../../services/agents/verification/automated-verifier', () => ({
  runAutomatedVerification: () => Promise.resolve({ ok: true, summary: '自動検証: OK' }),
}));
mock.module('../../../../services/agents/verification/verification-retry', () => ({
  retryOrBlock: mock(() => Promise.resolve()),
}));
mock.module('../../../../services/agents/verification/verification-gate', () => ({
  verificationCrashResult: () => ({ ok: false, summary: 'crash' }),
}));
mock.module('../../../../services/github/pr-link', () => ({
  linkAutoCreatedPr: mock(() => Promise.resolve()),
}));
mock.module('../../../../services/github/pr-duplicate-guard', () => ({
  findOpenPrForTask: () => Promise.resolve(null),
  claimPrCreationLock: () => Promise.resolve(true),
  releasePrCreationLock: () => Promise.resolve(),
}));
mock.module('../../../../services/task/task-resolver', () => ({
  resolvePreferredBaseBranch: () => Promise.resolve('develop'),
}));

let awaitingRequiredMerge = false;
mock.module('../../../../services/workflow/verify-settle-artifact-recovery', () => ({
  isAwaitingRequiredMerge: () => Promise.resolve(awaitingRequiredMerge),
}));

const holdForRequiredMerge = mock(() => {
  steps.push('hold');
  return Promise.resolve(true);
});
mock.module('../../../../services/workflow/required-merge-hold', () => ({
  holdForRequiredMerge,
  AWAITING_REQUIRED_MERGE_CAUSE: 'verify_awaiting_required_merge',
}));

let cancelAtStep: string | null = null;
mock.module('../../../../services/workflow/publication-cancellation-guard', () => ({
  publicationAborted: (_taskId: number, step: string) => Promise.resolve(cancelAtStep === step),
  PUBLICATION_CANCELLED_ERROR: 'タスクが停止されたため、公開処理を中断しました。',
}));

const cleanupWorktree = mock(() => {
  steps.push('cleanup');
  return Promise.resolve();
});
const markTaskDone = mock(() => {
  steps.push('done');
  return Promise.resolve();
});
mock.module('./post-execution-review-helpers', () => ({
  execAsync: mock(() => Promise.resolve({ stdout: 'feature/t895' })),
  resolveBaseBranch: () => Promise.resolve('develop'),
  getDiff: () => Promise.resolve('diff --git a/x b/x\n+1'),
  runAIReview: () =>
    Promise.resolve({ approved: true, summary: 'ok', issues: [], commitMessage: 'feat: x' }),
  cleanupWorktree,
  markTaskDone,
}));

const { reviewAndCommitWorktree } = await import('./post-execution-review');

const params = {
  taskId: 895,
  taskTitle: 'テストタスク',
  sessionId: 3,
  workDir: 'C:\\repo',
  executionDir: 'C:\\repo\\.worktrees\\t895',
};

beforeEach(() => {
  steps.length = 0;
  createCommit.mockClear();
  createPullRequest.mockClear();
  cleanupWorktree.mockClear();
  markTaskDone.mockClear();
  holdForRequiredMerge.mockClear();
  taskUpdate.mockClear();
  taskFindUnique.mockClear();
  taskFindUnique.mockResolvedValue({ workflowStatus: 'in_progress' });
  awaitingRequiredMerge = false;
  cancelAtStep = null;
});

describe('reviewAndCommitWorktree — 必須マージ待ち (task 895)', () => {
  test('autoMergePR要求時はPR作成後も done にせず保留する', async () => {
    awaitingRequiredMerge = true;

    await reviewAndCommitWorktree(params);

    expect(steps).toEqual(['commit', 'pr', 'cleanup', 'hold']);
    expect(markTaskDone).not.toHaveBeenCalled();
    expect(holdForRequiredMerge).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 895, source: 'post-execution-review' }),
    );
  });

  test('観測した workflowStatus を CAS 条件として渡す', async () => {
    awaitingRequiredMerge = true;
    taskFindUnique.mockResolvedValue({ workflowStatus: 'plan_approved' });

    await reviewAndCommitWorktree(params);

    expect(holdForRequiredMerge).toHaveBeenCalledWith(
      expect.objectContaining({ fromStatus: 'plan_approved' }),
    );
  });

  test('autoMergePR未要求なら従来どおり done にする', async () => {
    awaitingRequiredMerge = false;

    await reviewAndCommitWorktree(params);

    expect(steps).toEqual(['commit', 'pr', 'cleanup', 'done']);
    expect(holdForRequiredMerge).not.toHaveBeenCalled();
  });
});

describe('reviewAndCommitWorktree — 停止後は後続処理を行わない (task 895)', () => {
  const boundaries: Array<[string, string[]]> = [
    ['post_execution_review_entry', []],
    ['after_verification_gate', []],
    ['before_commit', []],
    ['before_pr', ['commit']],
    ['before_worktree_cleanup', ['commit', 'pr']],
  ];

  for (const [step, expected] of boundaries) {
    test(step + ' で停止済みならそれ以降を実行しない', async () => {
      cancelAtStep = step;

      await reviewAndCommitWorktree(params);

      expect(steps).toEqual(expected);
      expect(markTaskDone).not.toHaveBeenCalled();
      expect(cleanupWorktree).not.toHaveBeenCalled();
    });
  }
});
