/**
 * post-execution-review.test
 *
 * Task 874: reviewAndCommitWorktree must NOT auto-complete a task whose
 * verification verdict is 'unknown' — the PR is created as draft and
 * markTaskDone is withheld until independent CI or human approval. A
 * verdict of 'pass' keeps the pre-existing behavior (PR non-draft, task
 * marked done) — regression check.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const mockTaskUpdate = mock(() => Promise.resolve({}));
const mockTaskFindUnique = mock(() =>
  Promise.resolve({
    workflowStatus: 'in_progress',
    description: '説明',
    goals: null,
    constraints: null,
    acceptanceCriteria: JSON.stringify(['基準1']),
    theme: { defaultBranch: 'develop' },
  }),
);
const mockSessionUpdate = mock(() => Promise.resolve({}));
const mockWorkflowFileFindFirst = mock(() => Promise.resolve<{ id: number } | null>({ id: 1 }));
const mockAgentExecutionFindFirst = mock(() =>
  Promise.resolve<{ agentConfig: { agentType: string } | null } | null>(null),
);
mock.module('../../../../config/database', () => ({
  prisma: {
    task: { update: mockTaskUpdate, findUnique: mockTaskFindUnique },
    agentSession: { update: mockSessionUpdate },
    workflowFile: { findFirst: mockWorkflowFileFindFirst },
    agentExecution: { findFirst: mockAgentExecutionFindFirst },
  },
}));
mock.module('../../../../config/logger', () => ({ createLogger: () => noopLogger }));

mock.module('../../../../services/workflow/workflow-file-utils', () => ({
  readWorkflowFile: () => Promise.resolve(null),
}));
mock.module('../../../../services/task/task-resolver', () => ({
  resolvePreferredBaseBranch: () => Promise.resolve('develop'),
}));
mock.module('../../../../services/local-llm', () => ({
  getLocalLLMStatus: () => Promise.resolve({ available: false }),
}));
mock.module('../../../../utils/ai-client', () => ({
  sendAIMessage: () =>
    Promise.resolve({
      content: JSON.stringify({
        approved: true,
        summary: 'AI要約',
        issues: [],
        commitMessage: 'feat(task-874): テスト',
      }),
    }),
}));
mock.module('../../../../services/agents/agent-worker-manager', () => ({
  AgentWorkerManager: {
    getInstance: () => ({ removeWorktree: () => Promise.resolve(true) }),
  },
}));
mock.module('../../../../services/agents/orchestrator/git-operations/core/core-ops', () => ({
  createCommit: () => Promise.resolve({ hash: 'abc123' }),
}));

let verifierMode: 'pass' | 'unknown' = 'pass';
mock.module('../../../../services/agents/verification/automated-verifier', () => ({
  runAutomatedVerification: () =>
    Promise.resolve(
      verifierMode === 'unknown'
        ? {
            ok: true,
            changedFiles: ['src/ok.ts'],
            checks: [
              { name: 'lint', ran: true, ok: true, errorCount: 0, details: '' },
              { name: 'acceptance', ran: true, ok: false, errorCount: 1, details: '基準未充足' },
            ],
            summary: 'verification passed (acceptance advisory NG)',
          }
        : {
            ok: true,
            changedFiles: ['src/ok.ts'],
            checks: [{ name: 'lint', ran: true, ok: true, errorCount: 0, details: '' }],
            summary: 'verification passed',
          },
    ),
  computeVerdict: (checks: Array<{ name: string; ran: boolean; ok: boolean }>) =>
    checks.some((c) => (c.name === 'scope' || c.name === 'acceptance') && c.ran && !c.ok)
      ? 'unknown'
      : 'pass',
}));
mock.module('../../../../services/agents/verification/verification-retry', () => ({
  retryOrBlock: () => Promise.resolve(),
}));
const mockRecordUnknownVerdictMarker = mock(() => Promise.resolve());
mock.module('../../../../services/agents/verification/verification-gate', () => ({
  verificationCrashResult: () => ({
    ok: false,
    unverifiable: true,
    changedFiles: [],
    checks: [],
    summary: 'crashed',
  }),
  recordUnknownVerdictMarker: mockRecordUnknownVerdictMarker,
}));

const mockCreatePullRequest = mock(() =>
  Promise.resolve({ success: true, prUrl: 'https://github.com/x/y/pull/42', prNumber: 42 }),
);
mock.module('../../../../services/agents/orchestrator/git-operations/pr/branch-pr-ops', () => ({
  createPullRequest: mockCreatePullRequest,
}));
const mockNotify = mock(() => Promise.resolve());
mock.module('../../../../services/workflow/auto-merge-notify', () => ({
  notify: mockNotify,
}));
const mockLinkAutoCreatedPr = mock(() => Promise.resolve(null));
mock.module('../../../../services/github/pr-link', () => ({
  linkAutoCreatedPr: mockLinkAutoCreatedPr,
}));
mock.module('../../../../services/github/pr-duplicate-guard', () => ({
  findOpenPrForTask: () => Promise.resolve(null),
  claimPrCreationLock: () => Promise.resolve(true),
  releasePrCreationLock: () => Promise.resolve(),
}));

function execScripted(cmd: string): { stdout: string; stderr: string } {
  if (/diff HEAD --no-color/.test(cmd)) {
    return { stdout: 'diff --git a/src/ok.ts b/src/ok.ts\n+change\n', stderr: '' };
  }
  if (/branch --show-current/.test(cmd)) return { stdout: 'feature/task-874\n', stderr: '' };
  return { stdout: '', stderr: '' };
}
mock.module('node:child_process', () => ({
  exec: (
    cmd: string,
    _opts: unknown,
    cb?: (e: Error | null, r?: { stdout: string; stderr: string }) => void,
  ) => {
    const callback = (typeof _opts === 'function' ? _opts : cb) as (
      e: Error | null,
      r?: { stdout: string; stderr: string },
    ) => void;
    callback(null, execScripted(cmd));
  },
}));

const { reviewAndCommitWorktree } = await import('./post-execution-review');

beforeEach(() => {
  verifierMode = 'pass';
  mockTaskUpdate.mockClear();
  mockCreatePullRequest.mockClear();
  mockNotify.mockClear();
  mockLinkAutoCreatedPr.mockClear();
  mockRecordUnknownVerdictMarker.mockClear();
});

function baseParams() {
  return {
    taskId: 874,
    taskTitle: 'テストタスク',
    sessionId: 100,
    workDir: '/repo',
    executionDir: '/repo/.worktrees/task-874',
  };
}

describe('reviewAndCommitWorktree — verification verdict (task 874)', () => {
  test("verdict 'unknown' → draft PR を作成し、markTaskDone を呼ばない", async () => {
    verifierMode = 'unknown';

    await reviewAndCommitWorktree(baseParams());

    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    const draftArg = mockCreatePullRequest.mock.calls[0]![5];
    expect(draftArg).toBe(true);
    expect(mockRecordUnknownVerdictMarker).toHaveBeenCalledWith(
      874,
      expect.any(String),
      'post-execution-review',
    );
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 874, type: 'auto_pr_draft_unknown' }),
    );
    expect(mockTaskUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'done' }) }),
    );
  });

  test("verdict 'pass' → draft ではない PR を作成し、markTaskDone を呼ぶ（回帰確認）", async () => {
    verifierMode = 'pass';

    await reviewAndCommitWorktree(baseParams());

    expect(mockCreatePullRequest).toHaveBeenCalledTimes(1);
    const draftArg = mockCreatePullRequest.mock.calls[0]![5];
    expect(draftArg).toBe(false);
    expect(mockRecordUnknownVerdictMarker).not.toHaveBeenCalled();
    expect(mockTaskUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'done' }) }),
    );
  });
});
