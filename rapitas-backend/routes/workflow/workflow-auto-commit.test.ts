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

mock.module('../../services/workflow/automation-policy', () => ({
  resolveAutomationPolicy: () =>
    Promise.resolve({ autoCommit: true, autoCreatePR: true, autoMergePR: false }),
}));

let gateVerdictFixture: 'pass' | 'unknown' = 'pass';
const mockRecordUnknownVerdictMarker = mock(() => Promise.resolve());
mock.module('../../services/agents/verification/verification-gate', () => ({
  runVerificationGate: () => Promise.resolve({ ok: true, verdict: gateVerdictFixture }),
  recordUnknownVerdictMarker: mockRecordUnknownVerdictMarker,
}));

// One mutable fixture per test drives createPullRequest's outcome and the
// commit's filesChanged count (both feed isNoChangeCompletion's classifier).
let prResultFixture:
  | { success: false; error: string }
  | { success: true; prUrl: string; prNumber: number } = {
  success: false,
  error: 'no commits between develop and feature/t687',
};
let filesChangedFixture = 0;
let removeWorktreeFixture = true;
let lastCreatePullRequestArgs: unknown[] = [];
mock.module('../../services/agents/agent-orchestrator', () => ({
  AgentOrchestrator: {
    getInstance: () => ({
      createBranch: () => Promise.resolve(),
      createCommit: () =>
        Promise.resolve({
          hash: 'abc123',
          branch: 'feature/t687',
          filesChanged: filesChangedFixture,
          additions: 0,
          deletions: 0,
          alreadyCommitted: false,
        }),
      createPullRequest: (...args: unknown[]) => {
        createPullRequestCalls++;
        lastCreatePullRequestArgs = args;
        return Promise.resolve(prResultFixture);
      },
      removeWorktree: () => Promise.resolve(removeWorktreeFixture),
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

describe('performAutoCommitAndPR — removeWorktree の戻り値を worktreeCleanupResult に反映する (task 790 / K-8046)', () => {
  const worktreePath = 'C:\\work\\project\\.worktrees\\task-687';

  test('removeWorktree が false を返す場合、success:false を記録しDBを更新しない', async () => {
    filesChangedFixture = 1;
    revListFixture = '1';
    prResultFixture = { success: false, error: 'gh: authentication failed' };
    removeWorktreeFixture = false;
    mockPrisma.agentSession.update.mockClear();
    mockPrisma.task.findUnique.mockResolvedValueOnce({
      id: 687,
      title: 'テストタスク',
      theme: { workingDirectory: 'C:\\work\\project', defaultBranch: 'develop' },
      developerModeConfig: {
        agentSessions: [{ id: 1, branchName: 'feature/t687', worktreePath }],
      },
    });

    const result = await performAutoCommitAndPR(687, '# 検証結果');

    expect(result.worktreeCleanupResult).toEqual({
      success: false,
      worktreePath,
      error: 'removeWorktree refused or failed',
    });
    expect(mockPrisma.agentSession.update).not.toHaveBeenCalled();
    removeWorktreeFixture = true;
  });

  test('worktree削除失敗はwarnで記録されerrorでは記録されない (task 816 / K-8326)', async () => {
    filesChangedFixture = 1;
    revListFixture = '1';
    prResultFixture = { success: false, error: 'gh: authentication failed' };
    removeWorktreeFixture = false;
    mockPrisma.task.findUnique.mockResolvedValueOnce({
      id: 687,
      title: 'テストタスク',
      theme: { workingDirectory: 'C:\\work\\project', defaultBranch: 'develop' },
      developerModeConfig: {
        agentSessions: [{ id: 1, branchName: 'feature/t687', worktreePath }],
      },
    });
    warnLogCalls.length = 0;
    errorLogCalls.length = 0;

    await performAutoCommitAndPR(687, '# 検証結果');

    expect(warnLogCalls.some(([, msg]) => msg.includes('Worktree cleanup failed'))).toBe(true);
    expect(errorLogCalls.some(([, msg]) => msg.includes('Worktree cleanup failed'))).toBe(false);
    removeWorktreeFixture = true;
  });

  test('removeWorktree が true を返す場合、success:true を記録しDBを更新する', async () => {
    filesChangedFixture = 1;
    revListFixture = '1';
    prResultFixture = { success: false, error: 'gh: authentication failed' };
    removeWorktreeFixture = true;
    mockPrisma.agentSession.update.mockClear();
    mockPrisma.task.findUnique.mockResolvedValueOnce({
      id: 687,
      title: 'テストタスク',
      theme: { workingDirectory: 'C:\\work\\project', defaultBranch: 'develop' },
      developerModeConfig: {
        agentSessions: [{ id: 1, branchName: 'feature/t687', worktreePath }],
      },
    });

    const result = await performAutoCommitAndPR(687, '# 検証結果');

    expect(result.worktreeCleanupResult).toEqual({ success: true, worktreePath });
    expect(mockPrisma.agentSession.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { worktreePath: null },
    });
  });
});

describe('performAutoCommitAndPR — 検証verdict unknown → draft PR + マーカー記録 (task 874)', () => {
  test("verdict 'unknown' のとき createPullRequest に draft:true を渡し、recordUnknownVerdictMarker を呼ぶ", async () => {
    filesChangedFixture = 1;
    revListFixture = '1';
    gateVerdictFixture = 'unknown';
    createPullRequestCalls = 0;
    mockRecordUnknownVerdictMarker.mockClear();
    prResultFixture = { success: true, prUrl: 'https://github.com/x/y/pull/50', prNumber: 50 };

    await performAutoCommitAndPR(687, '# 検証結果');

    expect(createPullRequestCalls).toBe(1);
    expect(lastCreatePullRequestArgs[5]).toBe(true); // draft argument
    expect(mockRecordUnknownVerdictMarker).toHaveBeenCalledTimes(1);
    expect(mockRecordUnknownVerdictMarker.mock.calls[0]?.[2]).toBe('workflow-auto-commit');
    gateVerdictFixture = 'pass';
  });

  test("verdict 'pass' のとき draft を付けず、recordUnknownVerdictMarker を呼ばない（回帰確認）", async () => {
    filesChangedFixture = 1;
    revListFixture = '1';
    gateVerdictFixture = 'pass';
    createPullRequestCalls = 0;
    mockRecordUnknownVerdictMarker.mockClear();
    prResultFixture = { success: true, prUrl: 'https://github.com/x/y/pull/51', prNumber: 51 };

    await performAutoCommitAndPR(687, '# 検証結果');

    expect(createPullRequestCalls).toBe(1);
    expect(lastCreatePullRequestArgs[5]).toBe(false);
    expect(mockRecordUnknownVerdictMarker).not.toHaveBeenCalled();
  });
});
