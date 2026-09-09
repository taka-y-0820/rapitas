/**
 * workflow-auto-commit テスト
 *
 * Auto-PR作成失敗時のログ出力を検証する(task 687):
 * - 失敗理由が `err`(Error)キーで渡され、log-format-parser が抽出できること
 * - `isNoChangeCompletion` が真の「既に実装済み・変更なし」ケースは
 *   ERRORではなくWARNで記録され、同一の汎用バグとして再起票されないこと
 * - 認証エラー等の本当の失敗はERRORのまま維持されること
 */
import { describe, expect, test, mock } from 'bun:test';

type LogCall = [Record<string, unknown>, string];
const errorLogCalls: LogCall[] = [];
const warnLogCalls: LogCall[] = [];
mock.module('../../config/logger', () => ({
  createLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: (obj: Record<string, unknown>, msg: string) => {
      warnLogCalls.push([obj, msg]);
    },
    error: (obj: Record<string, unknown>, msg: string) => {
      errorLogCalls.push([obj, msg]);
    },
  }),
}));

const mockPrisma = {
  agentExecutionConfig: {
    findUnique: mock(() =>
      Promise.resolve({
        autoCommit: true,
        autoCreatePR: true,
        autoMergePR: false,
        workingDirectory: 'C:\\work\\project',
        targetBranch: null,
      }),
    ),
  },
  task: {
    findUnique: mock(() =>
      Promise.resolve({
        id: 687,
        title: 'テストタスク',
        theme: { workingDirectory: 'C:\\work\\project', defaultBranch: 'develop' },
        developerModeConfig: {
          agentSessions: [{ id: 1, branchName: 'feature/t687', worktreePath: null }],
        },
      }),
    ),
  },
  agentSession: { update: mock(() => Promise.resolve({})) },
};
mock.module('../../config', () => ({
  prisma: mockPrisma,
  getProjectRoot: () => 'C:\\Projects\\other',
}));

// Publication cancellation guard (task 895). Default: no stop on record, so the
// pre-existing cases below are unaffected; the cancellation suite flips
// `cancelAtStep` to assert each boundary withholds the steps after it.
let cancelAtStep: string | null = null;
const publicationAbortedCalls: string[] = [];
mock.module('../../services/workflow/publication-cancellation-guard', () => ({
  PUBLICATION_CANCELLED_ERROR: 'タスクが停止されたため、公開処理を中断しました。',
  publicationAborted: (_taskId: number, step: string) => {
    publicationAbortedCalls.push(step);
    return Promise.resolve(cancelAtStep === step);
  },
}));

mock.module('../../services/workflow/automation-policy', () => ({
  resolveAutomationPolicy: () =>
    Promise.resolve({ autoCommit: true, autoCreatePR: true, autoMergePR: false }),
}));

mock.module('../../services/agents/verification/verification-gate', () => ({
  runVerificationGate: () => Promise.resolve({ ok: true }),
}));

// One mutable fixture per test drives createPullRequest's outcome and the
// commit's filesChanged count (both feed isNoChangeCompletion's classifier).
let prResultFixture: { success: boolean; error: string; prNumber?: number } = {
  success: false,
  error: 'no commits between develop and feature/t687',
};
let filesChangedFixture = 0;
let removeWorktreeFixture = true;
mock.module('../../services/agents/agent-orchestrator', () => ({
  AgentOrchestrator: {
    getInstance: () => ({
      createBranch: () => Promise.resolve(),
      createCommit: () => {
        createCommitCalls++;
        return Promise.resolve({
          hash: 'abc123',
          branch: 'feature/t687',
          filesChanged: filesChangedFixture,
          additions: 0,
          deletions: 0,
          alreadyCommitted: false,
        });
      },
      createPullRequest: () => {
        createPullRequestCalls++;
        return Promise.resolve(prResultFixture);
      },
      removeWorktree: () => {
        removeWorktreeCalls++;
        return Promise.resolve(removeWorktreeFixture);
      },
    }),
  },
}));

mock.module('./workflow-activity-logger', () => ({
  logAutoCommit: () => Promise.resolve(),
  logAutoPR: () => Promise.resolve(),
}));

mock.module('../../services/github/pr-link', () => ({
  linkAutoCreatedPr: () => Promise.resolve(),
}));

mock.module('../../services/agents/orchestrator/git-operations/pr/branch-pr-ops', () => ({
  FOREIGN_PR_ERROR_PREFIX: 'PR_IDENTITY_MISMATCH:',
}));

mock.module('../../services/workflow/auto-merge-notify', () => ({
  notify: () => Promise.resolve(),
}));

mock.module('../../services/github/pr-duplicate-guard', () => ({
  findOpenPrForTask: () => Promise.resolve(null),
  claimPrCreationLock: () => Promise.resolve(true),
  releasePrCreationLock: () => Promise.resolve(),
}));

// `git rev-list --count origin/<base>..HEAD` seen by countCommitsAhead. The
// default says the branch IS ahead so the existing tests keep exercising the
// gh path; the no-change test sets it to '0'.
let revListFixture = '1';
let createPullRequestCalls = 0;
let createCommitCalls = 0;
let removeWorktreeCalls = 0;
mock.module('../../services/github/git-exec', () => ({
  runGitCommand: () => Promise.resolve(revListFixture),
}));
mock.module('../../services/workflow/pre-pr-base-sync', () => ({
  syncBaseIntoBranch: () =>
    Promise.resolve({ status: 'skipped', changedFiles: 0, conflicts: [], detail: 'no worktree' }),
}));

const { performAutoCommitAndPR } = await import('./workflow-auto-commit');

describe('performAutoCommitAndPR — Auto-PR失敗時のログ出力', () => {
  test('既に実装済み(no-change)の場合はERRORではなくWARNで記録されること', async () => {
    errorLogCalls.length = 0;
    warnLogCalls.length = 0;
    filesChangedFixture = 0;
    prResultFixture = { success: false, error: 'no commits between develop and feature/t687' };

    const result = await performAutoCommitAndPR(687, '# 検証結果');

    expect(result.autoPRResult).toEqual({ success: false, error: prResultFixture.error });
    expect(errorLogCalls.find(([, msg]) => msg.includes('task 687'))).toBeUndefined();
    const warnLog = warnLogCalls.find(([, msg]) => msg.includes('task 687'));
    expect(warnLog).toBeDefined();
    const [loggedObj] = warnLog!;
    expect(loggedObj).not.toHaveProperty('error');
    expect(loggedObj.err).toBeInstanceOf(Error);
    expect((loggedObj.err as Error).message).toBe(prResultFixture.error);
  });

  test('真の失敗(認証エラー等)はERRORで err キー(Errorインスタンス)を渡して記録されること', async () => {
    errorLogCalls.length = 0;
    warnLogCalls.length = 0;
    filesChangedFixture = 1;
    prResultFixture = { success: false, error: 'gh: authentication failed' };

    const result = await performAutoCommitAndPR(687, '# 検証結果');

    expect(result.autoPRResult).toEqual({ success: false, error: prResultFixture.error });
    expect(warnLogCalls.find(([, msg]) => msg.includes('task 687'))).toBeUndefined();
    const errorLog = errorLogCalls.find(([, msg]) =>
      msg.includes('Auto-PR creation failed for task 687'),
    );
    expect(errorLog).toBeDefined();
    const [loggedObj] = errorLog!;
    expect(loggedObj).not.toHaveProperty('error');
    expect(loggedObj.err).toBeInstanceOf(Error);
    expect((loggedObj.err as Error).message).toBe(prResultFixture.error);
  });
});

describe('performAutoCommitAndPR — base より進んだコミットが無ければ gh を呼ばない', () => {
  test('rev-list が 0 なら createPullRequest を呼ばず、no-change として WARN で記録する', async () => {
    errorLogCalls.length = 0;
    warnLogCalls.length = 0;
    filesChangedFixture = 0;
    revListFixture = '0';
    createPullRequestCalls = 0;
    prResultFixture = { success: false, error: 'gh should not have been called' };
    const result = await performAutoCommitAndPR(739, '# 検証結果');
    expect(createPullRequestCalls).toBe(0);
    expect(result.autoPRResult?.success).toBe(false);
    expect(result.autoPRResult?.error).toContain('No commits between');
    expect(errorLogCalls.find(([, msg]) => msg.includes('task 739'))).toBeUndefined();
    expect(warnLogCalls.find(([, msg]) => msg.includes('task 739'))).toBeDefined();
    revListFixture = '1';
  });

  test('rev-list が 1 以上なら従来どおり createPullRequest を呼ぶ', async () => {
    filesChangedFixture = 1;
    revListFixture = '3';
    createPullRequestCalls = 0;
    prResultFixture = { success: false, error: 'gh: authentication failed' };
    await performAutoCommitAndPR(687, '# 検証結果');
    expect(createPullRequestCalls).toBe(1);
    revListFixture = '1';
  });
});

describe('publication preserves the verifier worktree until completion is settled', () => {
  test.each([
    { success: false, error: 'gh: authentication failed' },
    { success: false, error: 'no commits between develop and feature/t687' },
    { success: true, error: '', prNumber: 687 },
  ])('retains worktree and session after PR outcome %j', async (outcome) => {
    filesChangedFixture = outcome.success ? 1 : 0;
    revListFixture = '1';
    prResultFixture = outcome;
    removeWorktreeCalls = 0;
    mockPrisma.agentSession.update.mockClear();
    mockPrisma.task.findUnique.mockResolvedValueOnce({
      id: 687,
      title: 'verifier still running',
      theme: { workingDirectory: 'C:\\work\\project', defaultBranch: 'develop' },
      developerModeConfig: {
        agentSessions: [
          {
            id: 1,
            branchName: 'feature/t687',
            worktreePath: 'C:\\work\\project\\.worktrees\\task-687',
          },
        ],
      },
    });
    const result = await performAutoCommitAndPR(687, '# verification');
    expect(removeWorktreeCalls).toBe(0);
    expect(mockPrisma.agentSession.update).not.toHaveBeenCalled();
    expect(result.worktreeCleanupResult).toBeUndefined();
  });
});
describe('performAutoCommitAndPR — 停止後は後続の公開処理を一切行わない (task 895)', () => {
  const worktreePath = 'C:\\work\\project\\.worktrees\\task-895';
  const CANCELLED = 'タスクが停止されたため、公開処理を中断しました。';

  /** Re-arm the shared fixtures for one boundary case. */
  function arm(step: string | null): void {
    cancelAtStep = step;
    publicationAbortedCalls.length = 0;
    createCommitCalls = 0;
    createPullRequestCalls = 0;
    removeWorktreeCalls = 0;
    filesChangedFixture = 1;
    revListFixture = '1';
    removeWorktreeFixture = true;
    prResultFixture = { success: false, error: 'gh: authentication failed' };
    mockPrisma.agentSession.update.mockClear();
    mockPrisma.task.findUnique.mockResolvedValueOnce({
      id: 895,
      title: 'テストタスク',
      theme: { workingDirectory: 'C:\\work\\project', defaultBranch: 'develop' },
      developerModeConfig: {
        agentSessions: [{ id: 1, branchName: 'feature/t895', worktreePath }],
      },
    });
  }

  test('entry で停止済みなら commit も PR も worktree削除も行わない', async () => {
    arm('entry');
    const result = await performAutoCommitAndPR(895, '# 検証結果');
    expect(result.error).toBe(CANCELLED);
    expect(createCommitCalls).toBe(0);
    expect(createPullRequestCalls).toBe(0);
    expect(removeWorktreeCalls).toBe(0);
  });

  test('検証ゲート通過後に停止されたら commit 以降を行わない', async () => {
    arm('after_verification_gate');
    const result = await performAutoCommitAndPR(895, '# 検証結果');
    expect(result.error).toBe(CANCELLED);
    expect(createCommitCalls).toBe(0);
    expect(createPullRequestCalls).toBe(0);
    expect(removeWorktreeCalls).toBe(0);
  });

  test('commit 直前に停止されたら git へ書き込まない', async () => {
    arm('before_commit');
    const result = await performAutoCommitAndPR(895, '# 検証結果');
    expect(result.error).toBe(CANCELLED);
    expect(createCommitCalls).toBe(0);
    expect(createPullRequestCalls).toBe(0);
    expect(removeWorktreeCalls).toBe(0);
  });

  test('PR作成直前に停止されたら commit 済みでも PR を作らず worktree も残す', async () => {
    arm('before_pr');
    const result = await performAutoCommitAndPR(895, '# 検証結果');
    expect(result.error).toBe(CANCELLED);
    expect(createCommitCalls).toBe(1);
    expect(createPullRequestCalls).toBe(0);
    expect(removeWorktreeCalls).toBe(0);
    expect(mockPrisma.agentSession.update).not.toHaveBeenCalled();
  });

  test('worktree削除直前に停止されたら worktree を保全する', async () => {
    arm('before_worktree_cleanup');
    const result = await performAutoCommitAndPR(895, '# 検証結果');
    expect(result.error).toBe(CANCELLED);
    expect(removeWorktreeCalls).toBe(0);
    expect(mockPrisma.agentSession.update).not.toHaveBeenCalled();
  });

  test('停止が無ければ commit/PR へ進むが、完了前の worktree は削除しない', async () => {
    arm(null);
    prResultFixture = { success: false, error: 'gh: authentication failed' };
    const result = await performAutoCommitAndPR(895, '# 検証結果');
    expect(result.error).toBeUndefined();
    expect(createCommitCalls).toBe(1);
    expect(createPullRequestCalls).toBe(1);
    expect(removeWorktreeCalls).toBe(0);
    expect(publicationAbortedCalls).toEqual([
      'entry',
      'after_verification_gate',
      'before_commit',
      'before_pr',
      'before_worktree_cleanup',
    ]);
    cancelAtStep = null;
  });
});
