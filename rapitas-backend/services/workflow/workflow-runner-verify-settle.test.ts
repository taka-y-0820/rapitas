/**
 * workflow-runner-verify-settle.test
 *
 * Task 772: a fresh verify-phase rejection (adversarial-review FAIL, bounce,
 * non-convergence cutoff, failed PR creation) must veto the landed-artifact
 * force-completion inside waitForVerifyCompletion — a PR merely existing on
 * record must not overrule a jury verdict recorded moments earlier (task 755:
 * jury FAIL immediately followed by settle force-completing from PR #537).
 * Exercises the guard from both call sites: the task-not-found branch and the
 * grace-window-exceeded branch.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { TaskWorkflowState } from '../task/task-resolver';
import { getEventListeners } from 'node:events';

process.env.RAPITAS_VERIFY_SETTLE_MS = '50';
process.env.RAPITAS_VERIFY_SETTLE_CAP_MS = '50';

let resolveWorkflowStateSequence: (TaskWorkflowState | null)[] = [];
let resolveWorkflowStateCallIndex = 0;
const resolveTaskWorkflowStateMock = mock((): Promise<TaskWorkflowState | null> => {
  const idx = Math.min(resolveWorkflowStateCallIndex, resolveWorkflowStateSequence.length - 1);
  resolveWorkflowStateCallIndex++;
  return Promise.resolve(idx >= 0 ? resolveWorkflowStateSequence[idx] : null);
});

mock.module('../task/task-resolver', () => ({
  resolveTaskWorkflowState: resolveTaskWorkflowStateMock,
}));

const hasFreshVerifyRejectionMock = mock(
  (_taskId: number): Promise<boolean> => Promise.resolve(false),
);
mock.module('./verify-self-repair', () => ({
  hasFreshVerifyRejection: hasFreshVerifyRejectionMock,
}));

const recoverFromLandedArtifactMock = mock(
  (_taskId: number): Promise<boolean> => Promise.resolve(true),
);
const pendingMergeMock = mock(async () => false);
mock.module('./verify-settle-artifact-recovery', () => ({
  recoverFromLandedArtifact: recoverFromLandedArtifactMock,
  isAwaitingRequiredMerge: pendingMergeMock,
}));

const { waitForVerifyCompletion } = await import('./workflow-runner-verify-settle');

function state(overrides: Partial<TaskWorkflowState>): TaskWorkflowState {
  return {
    id: 1,
    status: 'in-progress',
    workflowStatus: 'verify_done',
    workflowMode: null,
    parentId: null,
    ...overrides,
  };
}

describe('waitForVerifyCompletion — fresh-rejection guard on landed-artifact completion', () => {
  test('releases abort listeners after ordinary merge polling completes', async () => {
    resolveWorkflowStateSequence = [
      state({}),
      state({}),
      state({ status: 'done', workflowStatus: 'completed' }),
    ];
    pendingMergeMock.mockResolvedValue(true);
    const controller = new AbortController();
    expect(await waitForVerifyCompletion(1, controller.signal)).toBe('completed');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  }, 10000);
  test('keeps a required merge pending beyond the verification grace period', async () => {
    resolveWorkflowStateSequence = [
      state({}),
      state({}),
      state({ status: 'done', workflowStatus: 'completed' }),
    ];
    pendingMergeMock.mockResolvedValue(true);
    expect(await waitForVerifyCompletion(1, new AbortController().signal)).toBe('completed');
    expect(pendingMergeMock).toHaveBeenCalled();
    expect(recoverFromLandedArtifactMock).not.toHaveBeenCalled();
  }, 10000);
  beforeEach(() => {
    pendingMergeMock.mockReset().mockResolvedValue(false);
    resolveTaskWorkflowStateMock.mockClear();
    hasFreshVerifyRejectionMock.mockClear();
    recoverFromLandedArtifactMock.mockClear();
    hasFreshVerifyRejectionMock.mockImplementation(() => Promise.resolve(false));
    recoverFromLandedArtifactMock.mockImplementation(() => Promise.resolve(true));
    resolveWorkflowStateSequence = [];
    resolveWorkflowStateCallIndex = 0;
  });

  test('フレッシュな拒否がある間はPRが実在しても強制完了をスキップする（stuck）', async () => {
    resolveWorkflowStateSequence = [null];
    hasFreshVerifyRejectionMock.mockImplementation(() => Promise.resolve(true));

    const result = await waitForVerifyCompletion(1, new AbortController().signal);

    expect(result).toBe('stuck');
    expect(hasFreshVerifyRejectionMock).toHaveBeenCalledWith(1);
    expect(recoverFromLandedArtifactMock).not.toHaveBeenCalled();
  });

  test('フレッシュな拒否がなければPR実在で従来どおり完了する（回帰防止）', async () => {
    resolveWorkflowStateSequence = [null];
    hasFreshVerifyRejectionMock.mockImplementation(() => Promise.resolve(false));
    recoverFromLandedArtifactMock.mockImplementation(() => Promise.resolve(true));

    const result = await waitForVerifyCompletion(1, new AbortController().signal);

    expect(result).toBe('completed');
    expect(recoverFromLandedArtifactMock).toHaveBeenCalledWith(1);
  });

  test('猶予窓超過時もフレッシュな拒否があれば強制完了をスキップする（stuck）', async () => {
    resolveWorkflowStateSequence = [state({ workflowStatus: 'verify_done' })];
    hasFreshVerifyRejectionMock.mockImplementation(() => Promise.resolve(true));
    recoverFromLandedArtifactMock.mockImplementation(() => Promise.resolve(true));

    const result = await waitForVerifyCompletion(1, new AbortController().signal);

    expect(result).toBe('stuck');
    expect(recoverFromLandedArtifactMock).not.toHaveBeenCalled();
  }, 8000);
});
