/**
 * verify-commit-pr テスト
 *
 * runVerifyCommitPrCompletion の完了遷移CAS（compare-and-swap）を検証:
 * no-change完了 / conflict-resolution完了を同一タスクで並行に2回起動しても、
 * 完了遷移 (recordTransition) が1回しか記録されないこと (task 594 で
 * verify_no_change_confirmed が242ms差で二重記録された実測不具合の回帰防止)。
 * ゲート失敗分岐・PR必須ゲートは workflow-handlers-files.test.ts が担当する。
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';

// ---- logger mock ----
mock.module('../../../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// ---- prisma mock with an in-memory workflowStatus for CAS simulation ----
// updateMany honours the `workflowStatus: 'verify_done'` where-clause against
// this shared state, so the FIRST completion flips it and the SECOND gets
// count:0 — the same row-level outcome as two concurrent real requests.
let dbWorkflowStatus = 'verify_done';
let completionRefusal: string | null = null;
const updateManyCalls: unknown[] = [];
const mockUpdateMany = mock(
  (args: { where: { id: number; workflowStatus?: string }; data: Record<string, unknown> }) => {
    updateManyCalls.push(args);
    if (args.where.workflowStatus && args.where.workflowStatus !== dbWorkflowStatus) {
      return Promise.resolve({ count: 0 });
    }
    dbWorkflowStatus = (args.data.workflowStatus as string) ?? dbWorkflowStatus;
    return Promise.resolve({ count: 1 });
  },
) as any;
const mockPrisma = {
  task: {
    updateMany: mockUpdateMany,
    update: mock(() => Promise.resolve({})),
    findUnique: mock(() => Promise.resolve({ githubPrId: null, updatedAt: new Date(0) })),
  },
  gitHubPullRequest: { findFirst: mock(() => Promise.resolve(null)) },
  agentSession: { findFirst: mock(() => Promise.resolve(null)) },
};
mock.module('../../../../config', () => ({ prisma: mockPrisma }));

// ---- transition-recorder mock (the duplicate-detection target) ----
const transitionCalls: Array<{ cause: string }> = [];
const mockRecordTransition = mock((args: { cause: string }) => {
  transitionCalls.push(args);
  return Promise.resolve();
}) as any;
mock.module('../../../../services/workflow/transition-recorder', () => ({
  recordTransition: mockRecordTransition,
}));

// Atomic DB behavior is covered with real SQLite in requirement-replan-commit.test.ts.
mock.module('../../../../services/workflow/requirement-replan-commit', () => ({
  assertReviewedTaskCurrent: async () => undefined,
  completeReviewedTask: async (_db: unknown, _receipt: unknown, completion: { cause: string }) => {
    if (completionRefusal) return { committed: false, reason: completionRefusal };
    if (dbWorkflowStatus === 'completed') return { committed: false, reason: 'already_completed' };
    dbWorkflowStatus = 'completed';
    transitionCalls.push({ cause: completion.cause });
    return { committed: true, reason: completion.cause };
  },
}));

// ---- workflow-auto-commit mock ----
// Drives the no-change branch: PR requested but not produced, zero-diff commit.
let autoCommitPRResultFixture: Record<string, unknown> = {};
mock.module('../../workflow-auto-commit', () => ({
  performAutoCommitAndPR: mock(() => Promise.resolve(autoCommitPRResultFixture)),
  isNoChangeCompletion: () => true,
}));

// ---- remaining collaborators (not exercised by these paths) ----
mock.module('../../../../services/workflow/automation-policy', () => ({
  resolveLandingMode: () => 'none',
}));
mock.module('../../../../services/workflow/verify-completion-inflight', () => ({
  registerVerifyCompletion: () => {},
}));
mock.module('./shared', () => ({
  markLatestExecutionFailed: mock(() => Promise.resolve()),
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

let prVerdictFixture: { dirty: boolean; state: string | null } = { dirty: false, state: 'CLEAN' };
const prVerdictCalls: Array<{ taskId: number; prNumber: number }> = [];
mock.module('./conflict-pr-merge-state', () => ({
  readConflictPrVerdict: (taskId: number, prNumber: number) => {
    prVerdictCalls.push({ taskId, prNumber });
    return Promise.resolve(prVerdictFixture);
  },
}));
let repairFixture: { bounced: boolean; newStatus?: string; attempt?: number; stale?: boolean } = {
  bounced: true,
  newStatus: 'plan_approved',
  attempt: 1,
};
const repairCalls: Array<{ reason: string }> = [];
mock.module('../../../../services/workflow/verify-self-repair', () => ({
  attemptVerifyRepair: (_taskId: number, _status: string | null, reason: string) => {
    repairCalls.push({ reason });
    return Promise.resolve(repairFixture);
  },
}));
// Required-merge gate (task 895). Default false so the CAS suites above keep
// exercising the completion path unchanged.
let awaitingRequiredMerge = false;
mock.module('../../../../services/workflow/verify-settle-artifact-recovery', () => ({
  isAwaitingRequiredMerge: () => Promise.resolve(awaitingRequiredMerge),
}));
const mockHoldForRequiredMerge = mock(() => Promise.resolve(true));
mock.module('../../../../services/workflow/required-merge-hold', () => ({
  holdForRequiredMerge: mockHoldForRequiredMerge,
  AWAITING_REQUIRED_MERGE_CAUSE: 'verify_awaiting_required_merge',
}));

const { runVerifyCommitPrCompletion } = await import('./verify-commit-pr');

/** Builds the params for one completion invocation. / 1回分の完了処理パラメータを組み立てる。 */
function buildParams(overrides: Partial<Parameters<typeof runVerifyCommitPrCompletion>[0]> = {}) {
  return {
    taskId: 594,
    completionReceipt: {
      taskId: 594,
      executionId: null,
      evaluatedUpdatedAt: new Date(),
      review: {
        snapshotDigest: 'test',
        durationMs: 1,
        tokensUsed: 1,
        modelName: null,
        verdict: { kind: 'no_mismatch' as const, reason: 'test' },
      },
    },
    fileType: 'verify' as const,
    newStatus: 'verify_done',
    verifyGateBlocked: false,
    staleVerifyRequest: false,
    isConflictResolutionTask: false,
    conflictTask: null,
    savedContent: '# 検証結果',
    preferredBaseBranchForVerify: null,
    ...overrides,
  };
}

beforeEach(() => {
  completionRefusal = null;
  awaitingRequiredMerge = false;
  mockHoldForRequiredMerge.mockClear();
  dbWorkflowStatus = 'verify_done';
  updateManyCalls.length = 0;
  transitionCalls.length = 0;
  sideEffectsCalls.length = 0;
  mockRecordTransition.mockClear();
  prVerdictFixture = { dirty: false, state: 'CLEAN' };
  prVerdictCalls.length = 0;
  repairFixture = { bounced: true, newStatus: 'plan_approved', attempt: 1 };
  repairCalls.length = 0;
  mockPrisma.task.update.mockClear();
  autoCommitPRResultFixture = {
    requested: { autoCommit: true, autoCreatePR: true, autoMergePR: false },
    autoCommitResult: { success: true, filesChanged: 0 },
    autoPRResult: { success: false, error: 'nothing to compare' },
  };
});

describe('runVerifyCommitPrCompletion — 完了遷移のCAS（二重記録防止）', () => {
  test('conflict completion refuses a stop without writing completion or side effects', async () => {
    completionRefusal = 'stop_not_resumed';
    await expect(
      runVerifyCommitPrCompletion(
        buildParams({
          isConflictResolutionTask: true,
          conflictTask: { title: 'resolve conflict', githubPrId: 7 },
        }),
      ),
    ).rejects.toThrow('Reviewed conflict completion held');
    expect(transitionCalls).toEqual([]);
    expect(sideEffectsCalls).toEqual([]);
    expect(dbWorkflowStatus).toBe('verify_done');
  });
  test('no-change完了を並行2回起動しても verify_no_change_confirmed 遷移が1回のみ記録されること', async () => {
    const [r1, r2] = await Promise.all([
      runVerifyCommitPrCompletion(buildParams()),
      runVerifyCommitPrCompletion(buildParams()),
    ]);

    const noChangeTransitions = transitionCalls.filter(
      (t) => t.cause === 'verify_no_change_confirmed',
    );
    expect(noChangeTransitions.length).toBe(1);
    // 勝者のみ taskMarkedDone / newStatus=completed になること
    const done = [r1, r2].filter((r) => r.taskMarkedDone);
    expect(done.length).toBe(1);
    expect(done[0]!.newStatus).toBe('completed');
    // 完了副作用も勝者の1回のみ発火すること
    expect(sideEffectsCalls.length).toBe(1);
  });

  test('CAS空振り側（後着）は taskMarkedDone:false を返し newStatus を上書きしないこと', async () => {
    // 先着が既に completed へ進めた状態を模擬
    dbWorkflowStatus = 'completed';

    const res = await runVerifyCommitPrCompletion(buildParams());

    expect(res.taskMarkedDone).toBe(false);
    expect(res.newStatus).toBe('verify_done'); // 呼び出し時の newStatus を維持
    expect(transitionCalls.length).toBe(0);
    expect(sideEffectsCalls.length).toBe(0);
  });

  test('conflict-resolution完了を並行2回起動しても conflict_resolution_completed 遷移が1回のみ記録されること', async () => {
    const params = () =>
      buildParams({
        isConflictResolutionTask: true,
        conflictTask: { title: '競合解消', githubPrId: 42 },
      });

    const [r1, r2] = await Promise.all([
      runVerifyCommitPrCompletion(params()),
      runVerifyCommitPrCompletion(params()),
    ]);

    const transitions = transitionCalls.filter((t) => t.cause === 'conflict_resolution_completed');
    expect(transitions.length).toBe(1);
    const done = [r1, r2].filter((r) => r.taskMarkedDone);
    expect(done.length).toBe(1);
  });

  test('conflict-resolution完了のCAS空振り側は遷移を記録せず taskMarkedDone:false を返すこと', async () => {
    dbWorkflowStatus = 'completed';

    const res = await runVerifyCommitPrCompletion(
      buildParams({
        isConflictResolutionTask: true,
        conflictTask: { title: '競合解消', githubPrId: 42 },
      }),
    );

    expect(res.taskMarkedDone).toBe(false);
    expect(transitionCalls.length).toBe(0);
  });
});

describe('runVerifyCommitPrCompletion — 競合解消タスクは PR の mergeable を確認してから完了する', () => {
  const conflictParams = () =>
    buildParams({
      isConflictResolutionTask: true,
      conflictTask: { title: 'PR #534 の競合を解消', githubPrId: 534 },
    });

  test('PR が DIRTY のままなら完了せず self-repair で差し戻す（#762 再起票の再発防止）', async () => {
    prVerdictFixture = { dirty: true, state: 'DIRTY' };
    const res = await runVerifyCommitPrCompletion(conflictParams());
    expect(prVerdictCalls).toEqual([{ taskId: 594, prNumber: 534 }]);
    expect(res.taskMarkedDone).toBe(false);
    expect(res.newStatus).toBe('plan_approved');
    expect(repairCalls.length).toBe(1);
    expect(repairCalls[0]?.reason).toContain('#534');
    expect(transitionCalls.some((t) => t.cause === 'conflict_resolution_completed')).toBe(false);
    expect(updateManyCalls.length).toBe(0);
  });

  test('DIRTY かつ修復予算を使い切っていればブロックし conflict_pr_still_dirty を記録', async () => {
    prVerdictFixture = { dirty: true, state: 'DIRTY' };
    repairFixture = { bounced: false };
    const res = await runVerifyCommitPrCompletion(conflictParams());
    expect(res.taskMarkedDone).toBe(false);
    expect(mockPrisma.task.update).toHaveBeenCalledTimes(1);
    expect(transitionCalls.map((t) => t.cause)).toEqual(['conflict_pr_still_dirty']);
  });

  test('DIRTY でも verdict が stale なら何もしない（先に進んだワークフローを壊さない）', async () => {
    prVerdictFixture = { dirty: true, state: 'DIRTY' };
    repairFixture = { bounced: false, stale: true };
    const res = await runVerifyCommitPrCompletion(conflictParams());
    expect(res.taskMarkedDone).toBe(false);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
    expect(transitionCalls.length).toBe(0);
  });

  test('PR が CLEAN なら従来どおり conflict_resolution_completed で完了', async () => {
    const res = await runVerifyCommitPrCompletion(conflictParams());
    expect(prVerdictCalls.length).toBe(1);
    expect(res.taskMarkedDone).toBe(true);
    expect(transitionCalls.map((t) => t.cause)).toEqual(['conflict_resolution_completed']);
  });

  test('missing PR number holds conflict completion without a lookup', async () => {
    const res = await runVerifyCommitPrCompletion(
      buildParams({
        isConflictResolutionTask: true,
        conflictTask: { title: '競合解消', githubPrId: null },
      }),
    );
    expect(prVerdictCalls.length).toBe(0);
    expect(res.taskMarkedDone).toBe(false);
    expect(transitionCalls).toHaveLength(0);
  });
});

describe('runVerifyCommitPrCompletion — 競合解消タスクの必須マージゲート (task 895)', () => {
  /** Non-DIRTY conflict-resolution completion input. / 非DIRTYの競合解消完了入力 */
  const conflictParams = () =>
    buildParams({
      isConflictResolutionTask: true,
      conflictTask: { title: '競合解消', githubPrId: 42 },
    });

  test('autoMergePR要求時はPRが非DIRTYでも完了させず verify_done で保留する', async () => {
    awaitingRequiredMerge = true;

    const res = await runVerifyCommitPrCompletion(conflictParams());

    expect(res.taskMarkedDone).toBe(false);
    expect(res.newStatus).toBe('verify_done');
    expect(mockHoldForRequiredMerge).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 594, source: 'verify-commit-pr:conflict-resolution' }),
    );
    expect(transitionCalls.filter((t) => t.cause === 'conflict_resolution_completed').length).toBe(
      0,
    );
    expect(updateManyCalls.length).toBe(0);
  });

  test('autoMergePR未要求なら従来どおり非DIRTYで完了する', async () => {
    awaitingRequiredMerge = false;

    const res = await runVerifyCommitPrCompletion(conflictParams());

    expect(res.taskMarkedDone).toBe(true);
    expect(mockHoldForRequiredMerge).not.toHaveBeenCalled();
    expect(transitionCalls.filter((t) => t.cause === 'conflict_resolution_completed').length).toBe(
      1,
    );
  });
});

test('unknown conflict PR evidence cannot complete a task', async () => {
  for (const state of [null, 'UNKNOWN']) {
    prVerdictFixture = { dirty: false, state };
    const result = await runVerifyCommitPrCompletion(
      buildParams({
        isConflictResolutionTask: true,
        conflictTask: { title: 'Resolve conflict', githubPrId: 534 },
      }),
    );
    expect(result.taskMarkedDone).toBe(false);
    expect(transitionCalls).toHaveLength(0);
  }
});
