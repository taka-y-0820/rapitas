/**
 * auto-merge-watcher — post-merge local mirror sync scoping
 *
 * After a successful merge the watcher flips the LOCAL GitHubPullRequest row
 * to 'merged'. GitHubPullRequest holds every repo's PRs and prNumber collides
 * across repos, so the updateMany MUST be scoped by the candidate repo's
 * integrationId — an unscoped update also flipped another project's
 * same-numbered OPEN PR to merged, removing it from ITS auto-merge candidacy
 * (task #596). When the integration cannot be resolved the sync is skipped
 * (fail-closed) but completion/notification still proceed.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// NOTE: readHeadSha/updatePrBranch are required by auto-merge-ci-failure — this
// mock replaces auto-merge-checks wholesale (bun mock.module is process-global),
// so omitting any export would crash importers.
mock.module('./auto-merge-checks', () => ({
  blockingChecks: () => new Set(['Lint Code']),
  evaluateAutoMergeChecks: () => 'pass',
  readPrChecks: mock(() => Promise.resolve([{ name: 'Lint Code', bucket: 'pass' }])),
  readMergeState: mock(() => Promise.resolve('CLEAN')),
  readHeadSha: mock(() => Promise.resolve('sha-current')),
  updatePrBranch: mock(() => Promise.resolve(true)),
}));

mock.module('./ci-self-repair', () => ({
  attemptCiRepair: mock(() => Promise.resolve({ bounced: false })),
  CI_REPAIR_CAUSE: 'ci_repair',
}));

mock.module('../github/conflict-task', () => ({
  fileConflictResolutionTask: mock(() => Promise.resolve({ created: false, taskId: null })),
}));

const mockResolveIntegrationId = mock(() => Promise.resolve<number | null>(1));
mock.module('../github/pr-link', () => ({
  resolveIntegrationId: mockResolveIntegrationId,
  linkAutoCreatedPr: mock(() => Promise.resolve(null)),
}));

mock.module('./auto-merge-exhaustion', () => ({
  EXHAUSTED_CAUSE: 'auto_merge_exhausted',
  resetExhaustedRecheckCooldowns: () => {},
  markExhausted: mock(() => Promise.resolve()),
  decideTerminalState: () => Promise.resolve({ terminal: false }),
}));

const mockNotify = mock(() => Promise.resolve());
mock.module('./auto-merge-notify', () => ({
  notify: mockNotify,
}));

mock.module('./transition-recorder', () => ({
  recordTransition: mock(() => Promise.resolve()),
}));

mock.module('../../utils/database/fail-closed-count', () => ({
  countWithFailClosed: mock((p: Promise<number>) => p),
}));

const mockUpdateMany = mock(() => Promise.resolve({ count: 1 }));
const mockTaskUpdate = mock(() => Promise.resolve({}));
const mockTaskComplete = mock(() => Promise.resolve({ count: 1 }));
const mockCanContinue = mock(() => Promise.resolve(true));
mock.module('./auto-merge-task-guard', () => ({ canContinueAutoMerge: mockCanContinue }));
const mockPrisma = {
  workflowTransition: {
    count: mock(() => Promise.resolve(0)),
    findFirst: mock(() => Promise.resolve(null)),
    findMany: mock(() => Promise.resolve([])),
  },
  gitHubPullRequest: {
    findFirst: mock(() =>
      Promise.resolve({ title: 'PR title', headBranch: 'feature/x', baseBranch: 'develop' }),
    ),
    updateMany: mockUpdateMany,
  },
  task: {
    findUnique: mock(() => Promise.resolve({ themeId: 1 })),
    update: mockTaskUpdate,
    updateMany: mockTaskComplete,
  },
};
mock.module('../../config/database', () => ({ prisma: mockPrisma }));

// NOTE (task 865): the real file moved to git-operations/pr/branch-pr-ops.ts;
// the old path here silently created a SEPARATE (never-consulted) module
// registry entry — auto-merge-watcher.ts's real import went unmocked and its
// mergePullRequest call reached the real implementation (2 fail).
mock.module('../agents/orchestrator/git-operations/pr/branch-pr-ops', () => ({
  mergePullRequest: mock(() =>
    Promise.resolve({ success: true, mergeStrategy: 'squash' as const }),
  ),
}));

mock.module('../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }),
}));

const { AutoMergeWatcher } = await import('./auto-merge-watcher');

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
  taskId: 491,
  taskTitle: 'test task',
  prNumber: 6,
  baseBranch: 'develop',
  cwd: '/repo/tripla',
  threshold: 0,
  completedAt: new Date(),
  mode: 'merge' as const,
};

beforeEach(() => {
  mockResolveIntegrationId.mockClear();
  mockResolveIntegrationId.mockImplementation(() => Promise.resolve<number | null>(1));
  mockUpdateMany.mockClear();
  mockTaskUpdate.mockClear();
  mockTaskComplete.mockClear();
  mockTaskComplete.mockResolvedValue({ count: 1 });
  mockCanContinue.mockReset().mockResolvedValue(true);
  mockNotify.mockClear();
});

describe('AutoMergeWatcher — post-merge local mirror sync', () => {
  test('does not complete or notify after a stop during merge', async () => {
    mockCanContinue.mockResolvedValue(false);
    await getProcess()(candidate, new Set(['Lint Code']));
    expect(mockTaskComplete).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });
  test('does not notify when cancellation wins the completion CAS', async () => {
    mockTaskComplete.mockResolvedValue({ count: 0 });
    await getProcess()(candidate, new Set(['Lint Code']));
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockTaskComplete.mock.calls[0][0]).toMatchObject({
      where: { status: { in: ['in-progress', 'in_progress', 'done', 'completed'] } },
    });
  });
  test("scopes the updateMany to the candidate repo's integrationId", async () => {
    await getProcess()(candidate, new Set(['Lint Code']));

    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const arg = mockUpdateMany.mock.calls[0][0] as unknown as {
      where: { prNumber: number; state: string; integrationId?: number };
    };
    expect(arg.where.prNumber).toBe(6);
    expect(arg.where.state).toBe('open');
    // Without this scope another repo's open #6 would also be flipped to merged.
    expect(arg.where.integrationId).toBe(1);
  });

  test('skips the mirror sync (fail-closed) when the integration cannot be resolved, but still completes and notifies', async () => {
    mockResolveIntegrationId.mockImplementation(() => Promise.resolve<number | null>(null));

    await getProcess()(candidate, new Set(['Lint Code']));

    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockTaskComplete).toHaveBeenCalledTimes(1); // completeTaskRow still ran
    expect(mockNotify).toHaveBeenCalledTimes(1); // auto_merge_success still sent
  });
});
