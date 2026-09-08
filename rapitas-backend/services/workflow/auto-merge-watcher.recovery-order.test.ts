/**
 * auto-merge-watcher — tick 内の回収と候補処理の順序 (task 895)
 *
 * findCandidates は open PR しか走査しないため、マージ済みで完了書き込みが
 * 失われたタスクの回収は候補処理より先に行う必要がある。同一 tick で回収済みの
 * タスクが候補としても二重処理されないこと、回収が失敗しても候補処理が続行する
 * ことを検証する。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

mock.module('../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }),
}));

/** Ordered log of the tick's collaborators. / tick の呼び出し順ログ */
const order: string[] = [];

let recoveredIds: number[] = [];
let recoveryThrows = false;
mock.module('./auto-merge-recovery', () => ({
  recoverMergedTasks: () => {
    order.push('recover');
    if (recoveryThrows) return Promise.reject(new Error('recovery exploded'));
    return Promise.resolve(recoveredIds);
  },
}));

const candidate = (taskId: number) => ({
  taskId,
  taskTitle: 'task ' + taskId,
  prNumber: 600 + taskId,
  baseBranch: 'develop',
  cwd: '/repo',
  threshold: 5,
  completedAt: new Date(),
  mode: 'merge' as const,
});

let candidates = [candidate(895), candidate(896)];
mock.module('./auto-merge-candidates', () => ({
  findCandidates: () => {
    order.push('findCandidates');
    return Promise.resolve(candidates);
  },
}));

mock.module('./auto-merge-checks', () => ({
  blockingChecks: () => new Set<string>(),
  evaluateAutoMergeChecks: () => 'pending',
  readPrChecks: mock(() => Promise.resolve([])),
  readMergeState: mock(() => Promise.resolve('CLEAN')),
  readHeadSha: mock(() => Promise.resolve('sha')),
  updatePrBranch: mock(() => Promise.resolve(true)),
}));
mock.module('./auto-merge-ci-failure', () => ({ handleCiFailure: mock(() => Promise.resolve()) }));
mock.module('./ci-self-repair', () => ({
  attemptCiRepair: mock(() => Promise.resolve({ bounced: false })),
  CI_REPAIR_CAUSE: 'ci_repair',
}));
mock.module('../github/conflict-task', () => ({
  fileConflictResolutionTask: mock(() => Promise.resolve({ created: false, taskId: null })),
}));
mock.module('../github/pr-link', () => ({
  resolveIntegrationId: mock(() => Promise.resolve(1)),
  linkAutoCreatedPr: mock(() => Promise.resolve(null)),
}));
mock.module('./auto-merge-exhaustion', () => ({
  EXHAUSTED_CAUSE: 'auto_merge_exhausted',
  resetExhaustedRecheckCooldowns: () => {},
  markExhausted: mock(() => Promise.resolve()),
  decideTerminalState: () => Promise.resolve({ skip: false }),
}));
mock.module('./auto-merge-notify', () => ({ notify: mock(() => Promise.resolve()) }));
mock.module('./transition-recorder', () => ({ recordTransition: mock(() => Promise.resolve()) }));
mock.module('../../utils/database/fail-closed-count', () => ({
  countWithFailClosed: mock((p: Promise<number>) => p),
}));
mock.module('../agents/orchestrator/git-operations/pr/branch-pr-ops', () => ({
  mergePullRequest: mock(() => Promise.resolve({ success: true, mergeStrategy: 'squash' })),
}));
mock.module('../../config/database', () => ({
  prisma: {
    workflowTransition: { count: mock(() => Promise.resolve(0)) },
    gitHubPullRequest: {
      findFirst: mock(() => Promise.resolve(null)),
      updateMany: mock(() => Promise.resolve({ count: 0 })),
    },
    task: {
      findUnique: mock(() => Promise.resolve({ themeId: 1 })),
      update: mock(() => Promise.resolve({})),
      updateMany: mock(() => Promise.resolve({ count: 1 })),
    },
  },
}));

const processed: number[] = [];
mock.module('./auto-merge-task-guard', () => ({
  canContinueAutoMerge: (taskId: number) => {
    processed.push(taskId);
    return Promise.resolve(false); // stop before process(); we only assert selection
  },
}));

const { AutoMergeWatcher } = await import('./auto-merge-watcher');

beforeEach(() => {
  order.length = 0;
  processed.length = 0;
  recoveredIds = [];
  recoveryThrows = false;
  candidates = [candidate(895), candidate(896)];
});

describe('AutoMergeWatcher.tick — マージ済み回収の順序', () => {
  test('recoverMergedTasks を findCandidates より先に実行する', async () => {
    await AutoMergeWatcher.getInstance().tick();

    expect(order).toEqual(['recover', 'findCandidates']);
  });

  test('同一 tick で回収済みのタスクは候補として二重処理しない', async () => {
    recoveredIds = [895];

    await AutoMergeWatcher.getInstance().tick();

    expect(processed).toEqual([896]);
  });

  test('回収が失敗しても候補処理は続行する', async () => {
    recoveryThrows = true;

    await AutoMergeWatcher.getInstance().tick();

    expect(order).toEqual(['recover', 'findCandidates']);
    expect(processed).toEqual([895, 896]);
  });
});
