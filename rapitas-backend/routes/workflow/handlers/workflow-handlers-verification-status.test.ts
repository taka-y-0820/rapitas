/**
 * workflow-handlers-verification-status.test
 *
 * Unit tests for the GET verification-job status endpoints: running/
 * completed/failed/interrupted/404, the `latest` alias, and confirmation
 * that the literal string `latest` is never mistaken for a runId.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { VerificationJobRecord } from '../../../services/workflow/verification-job-store';

const getJobByRunIdMock = mock(async (): Promise<VerificationJobRecord | null> => null);
const getLatestJobMock = mock(async (): Promise<VerificationJobRecord | null> => null);

mock.module('../../../services/workflow/verification-job-store', () => ({
  getJobByRunId: getJobByRunIdMock,
  getLatestJob: getLatestJobMock,
}));

mock.module('../../../config/logger', () => ({
  createLogger: () => ({ info: mock(() => {}), warn: mock(() => {}), debug: mock(() => {}) }),
}));

const { handleRunVerificationStatus, handleRunVerificationLatest } =
  await import('./workflow-handlers-verification-status');

function statusCtx(taskId: string, runId: string) {
  return { params: { taskId, runId }, set: {} as { status?: number | string } };
}
function latestCtx(taskId: string) {
  return { params: { taskId }, set: {} as { status?: number | string } };
}

beforeEach(() => {
  getJobByRunIdMock.mockClear();
  getLatestJobMock.mockClear();
  getJobByRunIdMock.mockImplementation(async () => null);
  getLatestJobMock.mockImplementation(async () => null);
});

describe('handleRunVerificationStatus', () => {
  it('running: startedAt を含めて返す', async () => {
    getJobByRunIdMock.mockImplementation(async () => ({
      runId: 'r1',
      taskId: 7,
      status: 'running',
      startedAt: '2026-09-08T00:00:00.000Z',
    }));
    const res = await handleRunVerificationStatus(statusCtx('7', 'r1'));
    expect(res).toMatchObject({
      success: true,
      status: 'running',
      startedAt: '2026-09-08T00:00:00.000Z',
    });
  });

  it('completed: ok/unverifiable/checks/markdown を含めて返す', async () => {
    getJobByRunIdMock.mockImplementation(async () => ({
      runId: 'r2',
      taskId: 7,
      status: 'completed',
      startedAt: '2026-09-08T00:00:00.000Z',
      finishedAt: '2026-09-08T00:02:00.000Z',
      ok: true,
      unverifiable: false,
      checks: [{ name: 'lint', ran: true, ok: true, errorCount: 0, details: '' }],
      summary: 'all green',
      markdown: '# ok',
      durationMs: 120_000,
    }));
    const res = await handleRunVerificationStatus(statusCtx('7', 'r2'));
    expect(res).toMatchObject({
      success: true,
      status: 'completed',
      ok: true,
      unverifiable: false,
      summary: 'all green',
      markdown: '# ok',
      durationMs: 120_000,
    });
  });

  it('failed: error を含めて返す', async () => {
    getJobByRunIdMock.mockImplementation(async () => ({
      runId: 'r3',
      taskId: 7,
      status: 'failed',
      startedAt: '2026-09-08T00:00:00.000Z',
      finishedAt: '2026-09-08T00:01:00.000Z',
      error: 'gate threw',
    }));
    const res = await handleRunVerificationStatus(statusCtx('7', 'r3'));
    expect(res).toMatchObject({ success: true, status: 'failed', error: 'gate threw' });
  });

  it('interrupted: note を含めて返す', async () => {
    getJobByRunIdMock.mockImplementation(async () => ({
      runId: 'r4',
      taskId: 7,
      status: 'interrupted',
      startedAt: '2026-09-08T00:00:00.000Z',
    }));
    const res = await handleRunVerificationStatus(statusCtx('7', 'r4'));
    expect(res).toMatchObject({ success: true, status: 'interrupted' });
    expect((res as { note?: string }).note).toBeTruthy();
  });

  it('存在しない runId は404を返す', async () => {
    const ctx = statusCtx('7', 'no-such-run');
    const res = await handleRunVerificationStatus(ctx);
    expect(ctx.set.status).toBe(404);
    expect(res).toMatchObject({ success: false });
  });

  it('不正な taskId は400を返す', async () => {
    const ctx = statusCtx('abc', 'r1');
    const res = await handleRunVerificationStatus(ctx);
    expect(ctx.set.status).toBe(400);
    expect(res).toMatchObject({ success: false });
  });

  it('runId が "latest" のときは getLatestJob に委譲し getJobByRunId は呼ばない', async () => {
    getLatestJobMock.mockImplementation(async () => ({
      runId: 'r-latest',
      taskId: 7,
      status: 'running',
      startedAt: '2026-09-08T00:00:00.000Z',
    }));
    const res = await handleRunVerificationStatus(statusCtx('7', 'latest'));
    expect(res).toMatchObject({ success: true, runId: 'r-latest' });
    expect(getLatestJobMock).toHaveBeenCalledTimes(1);
    expect(getJobByRunIdMock).not.toHaveBeenCalled();
  });
});

describe('handleRunVerificationLatest', () => {
  it('最新ジョブを返す', async () => {
    getLatestJobMock.mockImplementation(async () => ({
      runId: 'r5',
      taskId: 9,
      status: 'completed',
      startedAt: '2026-09-08T00:00:00.000Z',
      finishedAt: '2026-09-08T00:02:00.000Z',
      ok: true,
    }));
    const res = await handleRunVerificationLatest(latestCtx('9'));
    expect(res).toMatchObject({ success: true, runId: 'r5', status: 'completed', ok: true });
  });

  it('ジョブが無ければ404を返す（新規検証は起動しない）', async () => {
    const ctx = latestCtx('9');
    const res = await handleRunVerificationLatest(ctx);
    expect(ctx.set.status).toBe(404);
    expect(res).toMatchObject({ success: false });
  });
});
