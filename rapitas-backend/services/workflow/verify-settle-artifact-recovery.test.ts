/**
 * verify-settle-artifact-recovery.test
 *
 * Task 660: before the runner declares a `verify_done` task stuck, a PR already
 * on record must complete the task instead of blocking it — and nothing else
 * may (no PR, a lost compare-and-swap, or any DB error all yield false so the
 * caller keeps its normal `stuck` verdict).
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
const policy = mock(async () => ({ autoMergePR: false }));
mock.module('./automation-policy', () => ({ resolveAutomationPolicy: policy }));

mock.module('../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const findFirstPrMock = mock((): Promise<{ id: number } | null> => Promise.resolve(null));
const findUniqueTaskMock = mock(
  (): Promise<{ githubPrId: number | null } | null> => Promise.resolve(null),
);
const updateManyMock = mock(
  (_args: { where: Record<string, unknown>; data: Record<string, unknown> }) =>
    Promise.resolve({ count: 1 }),
);

mock.module('../../config', () => ({
  prisma: {
    gitHubPullRequest: { findFirst: findFirstPrMock },
    task: { findUnique: findUniqueTaskMock, updateMany: updateManyMock },
  },
}));

const recordTransitionMock = mock((_input: { cause: string; metadata?: unknown }) =>
  Promise.resolve(),
);
mock.module('./transition-recorder', () => ({ recordTransition: recordTransitionMock }));

const { recoverFromLandedArtifact } = await import('./verify-settle-artifact-recovery');

describe('recoverFromLandedArtifact', () => {
  test('PR existence does not complete a task requiring merge', async () => {
    policy.mockResolvedValue({ autoMergePR: true });
    findFirstPrMock.mockResolvedValue({ id: 458 });
    expect(await recoverFromLandedArtifact(658)).toBe(false);
    expect(updateManyMock).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    policy.mockReset().mockResolvedValue({ autoMergePR: false });
    findFirstPrMock.mockReset();
    findUniqueTaskMock.mockReset();
    updateManyMock.mockReset();
    recordTransitionMock.mockReset();
    findFirstPrMock.mockImplementation(() => Promise.resolve(null));
    findUniqueTaskMock.mockImplementation(() => Promise.resolve(null));
    updateManyMock.mockImplementation(() => Promise.resolve({ count: 1 }));
    recordTransitionMock.mockImplementation(() => Promise.resolve());
  });

  test('① GitHubPullRequest に紐づくPRがある → true、Task行を verify_done→completed に CAS 更新して遷移を記録する', async () => {
    findFirstPrMock.mockImplementation(() => Promise.resolve({ id: 458 }));

    await expect(recoverFromLandedArtifact(658)).resolves.toBe(true);

    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const args = updateManyMock.mock.calls[0][0];
    expect(args.where).toEqual({
      id: 658,
      workflowStatus: 'verify_done',
      status: { in: ['todo', 'in-progress', 'in_progress'] },
    });
    expect(args.data).toMatchObject({ status: 'done', workflowStatus: 'completed' });
    expect(args.data.completedAt).toBeInstanceOf(Date);
    // linkedTaskId hit means the githubPrId fallback is never consulted.
    expect(findUniqueTaskMock).not.toHaveBeenCalled();
    expect(recordTransitionMock).toHaveBeenCalledTimes(1);
    expect(recordTransitionMock.mock.calls[0][0]).toMatchObject({
      cause: 'verify_settle_artifact_recovered',
      metadata: { prSource: 'linked_pr', prRef: 458 },
    });
  });

  test('② Task.githubPrId のみある → true（フォールバック経路）', async () => {
    findUniqueTaskMock.mockImplementation(() => Promise.resolve({ githubPrId: 7 }));

    await expect(recoverFromLandedArtifact(580)).resolves.toBe(true);

    expect(findFirstPrMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(recordTransitionMock.mock.calls[0][0]).toMatchObject({
      metadata: { prSource: 'task_github_pr_id', prRef: 7 },
    });
  });

  test('③ どちらにもPRがない → false、Task行には触れない', async () => {
    await expect(recoverFromLandedArtifact(1)).resolves.toBe(false);

    expect(updateManyMock).not.toHaveBeenCalled();
    expect(recordTransitionMock).not.toHaveBeenCalled();
  });

  test('④ CAS が0件更新（別経路で既に完了済み） → false、遷移は記録しない', async () => {
    findFirstPrMock.mockImplementation(() => Promise.resolve({ id: 458 }));
    updateManyMock.mockImplementation(() => Promise.resolve({ count: 0 }));

    await expect(recoverFromLandedArtifact(658)).resolves.toBe(false);

    expect(recordTransitionMock).not.toHaveBeenCalled();
  });

  test('⑤ PR照会が例外を投げる → false（安全側へフォールバック）', async () => {
    findFirstPrMock.mockImplementation(() => Promise.reject(new Error('db offline')));

    await expect(recoverFromLandedArtifact(658)).resolves.toBe(false);

    expect(updateManyMock).not.toHaveBeenCalled();
    expect(recordTransitionMock).not.toHaveBeenCalled();
  });
});
