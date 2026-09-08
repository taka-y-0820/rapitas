/**
 * auto-merge-watcher — verification-verdict guard on the checkless-CLEAN
 * fallback (task 874)
 *
 * The fallback that reads GitHub mergeStateStatus=CLEAN as "pass" when no
 * blocking CI check was ever reported must NOT wave through a PR whose
 * verification verdict is 'unknown' for the CURRENT head — that fallback only
 * proves "no CI is configured", not that the change was verified. A verdict
 * of 'unknown' reached via a REAL green CI check (state:'pass' directly) is
 * unaffected: only the checkless-CLEAN substitution path is gated.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

let evaluateAutoMergeChecksResult: 'pass' | 'unknown' = 'pass';
mock.module('../../services/workflow/auto-merge-checks', () => ({
  blockingChecks: () => new Set(['Lint Code']),
  evaluateAutoMergeChecks: () => evaluateAutoMergeChecksResult,
  readPrChecks: mock(() => Promise.resolve([{ name: 'Lint Code', bucket: 'pass' }])),
  readMergeState: mock(() => Promise.resolve('CLEAN')),
  readHeadSha: mock(() => Promise.resolve('sha-current')),
  updatePrBranch: mock(() => Promise.resolve(true)),
}));

mock.module('../../services/workflow/ci-self-repair', () => ({
  attemptCiRepair: mock(() => Promise.resolve({ bounced: false })),
  CI_REPAIR_CAUSE: 'ci_repair',
}));

mock.module('../../services/github/conflict-task', () => ({
  fileConflictResolutionTask: mock(() => Promise.resolve({ created: false, taskId: null })),
}));

mock.module('../../services/github/pr-link', () => ({
  resolveIntegrationId: mock(() => Promise.resolve<number | null>(1)),
  linkAutoCreatedPr: mock(() => Promise.resolve(null)),
}));

mock.module('../../services/workflow/auto-merge-exhaustion', () => ({
  EXHAUSTED_CAUSE: 'auto_merge_exhausted',
  resetExhaustedRecheckCooldowns: () => {},
  markExhausted: mock(() => Promise.resolve()),
  decideTerminalState: () => Promise.resolve({ terminal: false }),
}));

const mockNotify = mock(() => Promise.resolve());
mock.module('../../services/workflow/auto-merge-notify', () => ({
  notify: mockNotify,
}));

mock.module('../../services/workflow/transition-recorder', () => ({
  recordTransition: mock(() => Promise.resolve()),
}));

mock.module('../../utils/database/fail-closed-count', () => ({
  countWithFailClosed: mock((p: Promise<number>) => p),
}));

let verdictMarkerRow: { metadata: string } | null = null;
const mockTaskUpdate = mock(() => Promise.resolve({}));
const mockPrisma = {
  workflowTransition: {
    count: mock(() => Promise.resolve(0)),
    findFirst: mock(() => Promise.resolve(verdictMarkerRow)),
    findMany: mock(() => Promise.resolve([])),
  },
  gitHubPullRequest: {
    findFirst: mock(() =>
      Promise.resolve({ title: 'PR title', headBranch: 'feature/x', baseBranch: 'develop' }),
    ),
    updateMany: mock(() => Promise.resolve({ count: 1 })),
  },
  task: {
    findUnique: mock(() => Promise.resolve({ themeId: 1 })),
    update: mockTaskUpdate,
  },
};
mock.module('../../config/database', () => ({ prisma: mockPrisma }));

const mockMergePullRequest = mock(() =>
  Promise.resolve({ success: true, mergeStrategy: 'squash' as const }),
);
mock.module('../../services/agents/orchestrator/git-operations/pr/branch-pr-ops', () => ({
  mergePullRequest: mockMergePullRequest,
}));

mock.module('../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }),
}));

const { AutoMergeWatcher } = await import('../../services/workflow/auto-merge-watcher');

type ProcessFn = (
  c: {
    taskId: number;
    taskTitle: string;
    prNumber: number;
    baseBranch: string;
    cwd: string;
    threshold: number;
    completedAt: Date | null;
    mode: 'merge' | 'pr';
  },
  blocking: Set<string>,
) => Promise<void>;

function getProcess(): ProcessFn {
  const instance = AutoMergeWatcher.getInstance() as unknown as { process: ProcessFn };
  return instance.process.bind(instance);
}

const candidate = {
  taskId: 874,
  taskTitle: 'test task',
  prNumber: 9,
  baseBranch: 'develop',
  cwd: '/repo/tripla',
  threshold: 0,
  completedAt: new Date(),
  mode: 'merge' as const,
};

beforeEach(() => {
  evaluateAutoMergeChecksResult = 'pass';
  verdictMarkerRow = null;
  mockMergePullRequest.mockClear();
  mockTaskUpdate.mockClear();
  mockNotify.mockClear();
});

describe('AutoMergeWatcher — verification-verdict guard (task 874)', () => {
  test('real CI green (state=pass directly) merges even with an unknown-verdict marker present', async () => {
    evaluateAutoMergeChecksResult = 'pass';
    verdictMarkerRow = {
      metadata: JSON.stringify({ headSha: 'sha-current', source: 'workflow-auto-commit' }),
    };

    await getProcess()(candidate, new Set(['Lint Code']));

    expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
  });

  test('checkless-CLEAN fallback + marker matches current head → holds, notifies, does not merge', async () => {
    evaluateAutoMergeChecksResult = 'unknown';
    verdictMarkerRow = {
      metadata: JSON.stringify({ headSha: 'sha-current', source: 'workflow-auto-commit' }),
    };

    await getProcess()(candidate, new Set(['Lint Code']));

    expect(mockMergePullRequest).not.toHaveBeenCalled();
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'auto_merge_awaiting_approval', taskId: 874 }),
    );
  });

  test('checkless-CLEAN fallback + no marker (verdict pass) → merges as before (regression check)', async () => {
    evaluateAutoMergeChecksResult = 'unknown';
    verdictMarkerRow = null;

    await getProcess()(candidate, new Set(['Lint Code']));

    expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
    expect(mockTaskUpdate).toHaveBeenCalledTimes(1);
  });
});
