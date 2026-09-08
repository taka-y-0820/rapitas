/**
 * workflow-handlers-verification.test
 *
 * Unit tests for the implementer self-verification job-launch endpoint:
 * invalid id, missing worktree, immediate-response happy path, the per-task
 * idempotent re-request (no double gate launch), the synchronous-reservation
 * regression (task 897), and failure to start a job.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

const findFirstMock = mock(async (): Promise<unknown> => null);
mock.module('../../../config', () => ({
  prisma: { agentSession: { findFirst: findFirstMock } },
}));

mock.module('../../../config/logger', () => ({
  createLogger: () => ({ info: mock(() => {}), warn: mock(() => {}), debug: mock(() => {}) }),
}));

let nextRunId = 0;
const beginVerificationRunMock = mock(
  async (): Promise<{
    runId: string;
    cacheInputsBefore: { worktreePath: string; requireTests: boolean };
    keyBefore: string | null;
  }> => {
    nextRunId += 1;
    return {
      runId: `run-${nextRunId}`,
      cacheInputsBefore: { worktreePath: 'C:/wt/task-1', requireTests: false },
      keyBefore: 'key-1',
    };
  },
);
const runVerificationGateAndRecordMock = mock(async (): Promise<void> => {});

mock.module('../../../services/workflow/verification-job-runner', () => ({
  beginVerificationRun: beginVerificationRunMock,
  runVerificationGateAndRecord: runVerificationGateAndRecordMock,
}));

const { handleRunVerification } = await import('./workflow-handlers-verification');

function ctx(taskId: string) {
  return { params: { taskId }, set: {} as { status?: number | string } };
}

beforeEach(() => {
  nextRunId = 0;
  findFirstMock.mockClear();
  beginVerificationRunMock.mockClear();
  runVerificationGateAndRecordMock.mockClear();
  findFirstMock.mockImplementation(async () => ({ worktreePath: 'C:/wt/task-1' }));
  runVerificationGateAndRecordMock.mockImplementation(async () => {});
});

describe('handleRunVerification', () => {
  it('rejects a non-numeric task id with 400', async () => {
    const c = ctx('abc');
    const res = await handleRunVerification(c);
    expect(c.set.status).toBe(400);
    expect(res).toMatchObject({ success: false });
  });

  it('returns 404 when the task has no worktree session, and releases the reservation', async () => {
    findFirstMock.mockImplementation(async () => null);
    const c = ctx('7');
    const res = await handleRunVerification(c);
    expect(c.set.status).toBe(404);
    expect(res).toMatchObject({ success: false });

    findFirstMock.mockImplementation(async () => ({ worktreePath: 'C:/wt/task-1' }));
    const res2 = await handleRunVerification(ctx('7'));
    expect(res2).toMatchObject({ success: true, status: 'running' });
  });

  it('starts a job and responds immediately with runId/pollUrl, without waiting for the gate', async () => {
    const c = ctx('11');
    const res = await handleRunVerification(c);
    expect(res).toMatchObject({
      success: true,
      runId: 'run-1',
      status: 'running',
      pollUrl: '/workflow/tasks/11/run-verification/run-1',
    });
    expect(beginVerificationRunMock).toHaveBeenCalledTimes(1);
    expect(beginVerificationRunMock).toHaveBeenCalledWith(11, 'C:/wt/task-1');
    // Fire-and-forget: at the moment the handler returns, the background
    // gate call has been kicked off but this test never awaits it directly
    // (matches production: the caller gets the response first).
    await new Promise((r) => setTimeout(r, 10));
    expect(runVerificationGateAndRecordMock).toHaveBeenCalledTimes(1);
    expect(runVerificationGateAndRecordMock).toHaveBeenCalledWith(
      11,
      'run-1',
      'C:/wt/task-1',
      expect.objectContaining({ worktreePath: 'C:/wt/task-1' }),
      'key-1',
    );
  });

  it('returns 500 when beginVerificationRun fails, and releases the reservation', async () => {
    beginVerificationRunMock.mockImplementationOnce(async () => {
      throw new Error('fingerprint failed');
    });
    const c = ctx('12');
    const res = await handleRunVerification(c);
    expect(c.set.status).toBe(500);
    expect(res).toMatchObject({ success: false });

    // Slot released — a follow-up run must reach beginVerificationRun again.
    const res2 = await handleRunVerification(ctx('12'));
    expect(res2).toMatchObject({ success: true, status: 'running' });
    expect(beginVerificationRunMock).toHaveBeenCalledTimes(2);
  });

  describe('実行中ジョブへの冪等応答', () => {
    it('ジョブ完了後の2回目のPOSTで runAutomatedVerification 相当（beginVerificationRun）が呼ばれる', async () => {
      let releaseGate: (() => void) | undefined;
      runVerificationGateAndRecordMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseGate = resolve;
          }),
      );
      const first = await handleRunVerification(ctx('9'));
      expect(first).toMatchObject({ success: true, runId: 'run-1' });

      // Second request while the job is still running: same runId, no new
      // gate launch (idempotent — this is what breaks the task 897 429
      // retry-storm: the caller gets a 200 with the existing runId instead).
      const second = await handleRunVerification(ctx('9'));
      expect(second).toMatchObject({
        success: true,
        runId: 'run-1',
        status: 'running',
        idempotent: true,
      });
      expect(beginVerificationRunMock).toHaveBeenCalledTimes(1);

      releaseGate?.();
      await new Promise((r) => setTimeout(r, 10));

      // After the background job finishes, the slot is released — a new
      // request starts a fresh job.
      const third = await handleRunVerification(ctx('9'));
      expect(third).toMatchObject({ success: true, runId: 'run-2' });
      expect(beginVerificationRunMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('回帰(task897 監督差戻し): runningJobs の同期予約', () => {
    it('session読み取りが保留中でも同一taskへの2件目は即座に既存予約を返す（awaitより前に予約）', async () => {
      let releaseSession!: () => void;
      findFirstMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSession = () => resolve({ worktreePath: 'C:/wt/task-1' });
          }),
      );
      const first = handleRunVerification(ctx('55'));
      const secondContext = ctx('55');
      try {
        const second = await handleRunVerification(secondContext);
        // No new session lookup for the second call — the reservation guard
        // short-circuits before findFirst is reached a second time.
        expect(findFirstMock).toHaveBeenCalledTimes(1);
        expect(second).toMatchObject({ success: true, status: 'running', idempotent: true });
      } finally {
        releaseSession();
        await first;
      }
    });

    it('404(worktreeなし)応答の直後は同一taskへの再要求が固着しない', async () => {
      findFirstMock.mockImplementation(async () => null);
      const c1 = ctx('56');
      const res1 = await handleRunVerification(c1);
      expect(c1.set.status).toBe(404);
      expect(res1).toMatchObject({ success: false });

      findFirstMock.mockImplementation(async () => ({ worktreePath: 'C:/wt/task-1' }));
      const c2 = ctx('56');
      const res2 = await handleRunVerification(c2);
      expect(c2.set.status).toBeUndefined();
      expect(res2).toMatchObject({ success: true, status: 'running' });
    });
  });
});
