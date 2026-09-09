/**
 * workflow-cli-executor.verify.test
 *
 * executeCLIAgent's verify-phase completion gating: hard validation failures
 * block (durable write + transition), the completion gate refuses to
 * complete a task with no real diff and no explicit justification, and
 * completion always requires a confirmed PR — with the "no diff, already
 * implemented" exception that completes WITHOUT a PR when gh reports nothing
 * to land. Worktree resolution and non-verify output handling are covered in
 * the sibling split files.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import {
  wf,
  spies,
  resetWfMockState,
  installWorkflowCliExecutorMocks,
} from '../../tests/helpers/workflow-cli-executor-mock-state';
import type { RoleTransition, WorkflowAdvanceResult } from './workflow-types';

type RepairResult = {
  bounced: boolean;
  newStatus?: string;
  attempt?: number;
  stale?: boolean;
  cutoffRecorded?: boolean;
};

// task 705: this file is the only workflow-cli-executor split suite that
// exercises the verify phase's hardFail branch, which now dynamically
// imports verify-self-repair. Mocked locally (not in the shared barrel —
// no other split file reaches this module) so hardFail tests control the
// repair outcome instead of hitting the real Prisma calls against the
// shared prismaMock (which has no workflowTransition/userSettings fields).
let hasFreshVerifyRejectionImpl: (taskId: number) => Promise<boolean> = async () => false;
let attemptVerifyRepairImpl: (
  taskId: number,
  currentStatus: string | null,
  reason: string,
  verifyContent: string,
) => Promise<RepairResult> = async () => ({ bounced: false });
const mockHasFreshVerifyRejection = mock((taskId: number) => hasFreshVerifyRejectionImpl(taskId));
const mockAttemptVerifyRepair = mock(
  (taskId: number, currentStatus: string | null, reason: string, verifyContent: string) =>
    attemptVerifyRepairImpl(taskId, currentStatus, reason, verifyContent),
);
mock.module('./verify-self-repair', () => ({
  hasFreshVerifyRejection: mockHasFreshVerifyRejection,
  attemptVerifyRepair: mockAttemptVerifyRepair,
}));

installWorkflowCliExecutorMocks();
const { executeCLIAgent } = await import('./workflow-cli-executor');

const advanceWorkflow = (): Promise<WorkflowAdvanceResult> =>
  Promise.resolve({ success: true, role: 'implementer', status: 'verify_done' });
const getOrCreateDevConfig = (): Promise<{ id: number }> => Promise.resolve({ id: 42 });
const task = { title: 'Verify the thing', description: 'desc' };
const agentConfig = { id: 1, agentType: 'claude-code', name: 'Agent', modelId: null };

function verifyTransition(): RoleTransition {
  return { role: 'verifier', outputFile: 'verify', nextStatus: 'completed' };
}

async function run(): Promise<WorkflowAdvanceResult> {
  return executeCLIAgent(
    1,
    task,
    agentConfig,
    'system prompt',
    'context',
    verifyTransition(),
    'ja',
    advanceWorkflow,
    getOrCreateDevConfig,
  );
}

function taskUpdateCalls(): Array<{ data: Record<string, unknown> }> {
  return spies.taskUpdate.mock.calls.map((c) => c[0] as { data: Record<string, unknown> });
}

function recordedCauses(): string[] {
  return spies.recordTransition.mock.calls.map((c) => (c[0] as { cause: string }).cause);
}

describe('executeCLIAgent — verify phase', () => {
  beforeEach(() => {
    resetWfMockState();
    wf.readWorkflowFileImpl = async () => '# Verify\nAll checks passed.';
    wf.taskWorkflowState = { ...wf.taskWorkflowState!, workflowStatus: 'in_progress' };
    hasFreshVerifyRejectionImpl = async () => false;
    attemptVerifyRepairImpl = async () => ({ bounced: false });
    mockHasFreshVerifyRejection.mockClear();
    mockAttemptVerifyRepair.mockClear();
  });

  test('already completed by the HTTP handler — never re-touched', async () => {
    wf.taskWorkflowState = { ...wf.taskWorkflowState!, workflowStatus: 'completed' };

    const result = await run();

    expect(result.status).toBe('completed');
    expect(spies.evaluateCompletionGate).not.toHaveBeenCalled();
    expect(spies.taskUpdate).not.toHaveBeenCalled();
    expect(spies.executeTask.mock.calls[0][1]).toEqual(
      expect.objectContaining({ investigationMode: true, investigationOutputType: 'verify' }),
    );
  });

  test('hard validation failure blocks durably instead of completing', async () => {
    wf.validateVerify = {
      ok: false,
      missingSections: ['テスト結果'],
      severity: 90,
      summary: 'missing sections',
    };

    const result = await run();

    expect(result.status).toBe('in_progress');
    expect(spies.writeBlockedStatusDurable).toHaveBeenCalledTimes(1);
    expect(recordedCauses()).toContain('verify_validation_failed');
    expect(spies.evaluateCompletionGate).not.toHaveBeenCalled();
  });

  // task 705: the CLI/orchestrator-driven epilogue must give hardFail the same
  // self-repair chance as the HTTP save path (status-transition.ts) instead of
  // blocking directly — the original task #684 defect.
  test('hard validation failure with repair budget available bounces to the implementer instead of blocking', async () => {
    wf.validateVerify = {
      ok: false,
      missingSections: ['テスト結果'],
      severity: 90,
      summary: 'missing sections',
    };
    attemptVerifyRepairImpl = async () => ({
      bounced: true,
      newStatus: 'plan_approved',
      attempt: 1,
    });

    const result = await run();

    expect(mockAttemptVerifyRepair).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('plan_approved');
    expect(spies.writeBlockedStatusDurable).not.toHaveBeenCalled();
    expect(recordedCauses()).not.toContain('verify_validation_failed');
  });

  test('hard validation failure with a stale repair verdict neither bounces nor blocks', async () => {
    wf.validateVerify = {
      ok: false,
      missingSections: ['テスト結果'],
      severity: 90,
      summary: 'missing sections',
    };
    attemptVerifyRepairImpl = async () => ({ bounced: false, stale: true });

    const result = await run();

    expect(result.status).toBe('in_progress');
    expect(spies.writeBlockedStatusDurable).not.toHaveBeenCalled();
    expect(recordedCauses()).not.toContain('verify_validation_failed');
  });

  test('hard validation failure with repair budget exhausted still blocks and records verify_validation_failed', async () => {
    wf.validateVerify = {
      ok: false,
      missingSections: ['テスト結果'],
      severity: 90,
      summary: 'missing sections',
    };
    attemptVerifyRepairImpl = async () => ({ bounced: false });

    const result = await run();

    expect(result.status).toBe('in_progress');
    expect(spies.writeBlockedStatusDurable).toHaveBeenCalledTimes(1);
    expect(recordedCauses()).toContain('verify_validation_failed');
  });

  test('hard validation failure cut off for non-convergence blocks WITHOUT double-recording verify_validation_failed', async () => {
    wf.validateVerify = {
      ok: false,
      missingSections: ['テスト結果'],
      severity: 90,
      summary: 'missing sections',
    };
    attemptVerifyRepairImpl = async () => ({ bounced: false, cutoffRecorded: true });

    const result = await run();

    expect(result.status).toBe('in_progress');
    // Still blocks durably (task must stop), but does not also record
    // verify_validation_failed — attemptVerifyRepair already recorded its own
    // verify_repair_non_convergence transition for this rejection.
    expect(spies.writeBlockedStatusDurable).toHaveBeenCalledTimes(1);
    expect(recordedCauses()).not.toContain('verify_validation_failed');
  });

  test('a soft validation miss (low severity) still proceeds to the completion gate', async () => {
    wf.validateVerify = {
      ok: false,
      missingSections: ['minor'],
      severity: 20,
      summary: 'minor miss',
    };

    await run();

    expect(spies.evaluateCompletionGate).toHaveBeenCalledTimes(1);
  });

  test('no code changes and no justification blocks instead of completing', async () => {
    wf.evaluateCompletionGateImpl = async () => ({
      allow: false,
      reason: 'no_diff_no_justification',
    });

    const result = await run();

    expect(result.status).toBe('in_progress');
    const blocked = taskUpdateCalls().find((c) => c.data.status === 'blocked');
    expect(blocked).toBeDefined();
    expect(recordedCauses()).toContain('verify_no_changes');
    expect(spies.performAutoCommitAndPR).not.toHaveBeenCalled();
  });

  test('completes immediately when a PR is already linked (no auto-commit/PR call needed)', async () => {
    wf.linkedPrRow = { id: 7 };

    const result = await run();

    expect(result.status).toBe('completed');
    expect(spies.performAutoCommitAndPR).not.toHaveBeenCalled();
    expect(spies.taskUpdate).not.toHaveBeenCalled();
    expect(spies.completeReviewedTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ cause: 'verify_passed' }),
    );
  });

  test('completes after a successful auto-commit + PR when none existed yet', async () => {
    wf.performAutoCommitAndPRImpl = async () => ({
      requested: { autoCommit: true, autoCreatePR: true, autoMergePR: false },
      autoPRResult: { success: true, prUrl: 'https://x/1', prNumber: 1 },
    });

    const result = await run();

    expect(spies.performAutoCommitAndPR).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
    expect(spies.completeReviewedTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ cause: 'verify_passed' }),
    );
  });

  test('completes without a PR when auto-commit/PR was not requested at all', async () => {
    wf.performAutoCommitAndPRImpl = async () => ({
      requested: { autoCommit: false, autoCreatePR: false, autoMergePR: false },
    });

    const result = await run();

    expect(result.status).toBe('completed');
  });

  test('"no commits between" PR failure completes WITHOUT a PR (already-implemented no-op)', async () => {
    wf.performAutoCommitAndPRImpl = async () => ({
      requested: { autoCommit: true, autoCreatePR: true, autoMergePR: false },
      autoPRResult: { success: false, error: 'No commits between main and feature/x' },
    });

    const result = await run();

    expect(result.status).toBe('completed');
    expect(spies.taskUpdate).not.toHaveBeenCalled();
    expect(spies.completeReviewedTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ cause: 'verify_no_change_confirmed' }),
    );
  });

  test('a genuine PR-creation failure blocks — completion always requires a PR', async () => {
    wf.performAutoCommitAndPRImpl = async () => ({
      requested: { autoCommit: true, autoCreatePR: true, autoMergePR: false },
      autoPRResult: { success: false, error: 'gh: permission denied' },
    });

    const result = await run();

    expect(result.status).toBe('in_progress');
    const blocked = taskUpdateCalls().find((c) => c.data.status === 'blocked');
    expect(blocked).toBeDefined();
    expect(recordedCauses()).toContain('verify_pr_not_created');
  });

  test('a throwing performAutoCommitAndPR is treated as PR-not-created (blocked), not a crash', async () => {
    wf.performAutoCommitAndPRImpl = async () => {
      throw new Error('unexpected auto-commit crash');
    };

    const result = await run();

    expect(result.status).toBe('in_progress');
    expect(recordedCauses()).toContain('verify_pr_not_created');
  });
});
