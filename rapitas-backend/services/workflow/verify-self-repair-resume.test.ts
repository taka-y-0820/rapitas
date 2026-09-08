import { beforeEach, expect, mock, test } from 'bun:test';
const enqueue = mock(
  async (..._args: unknown[]): Promise<'queued' | 'existing' | 'held' | 'scheduler_owned'> =>
    'queued',
);
const start = mock(() => undefined);
const db = {};
mock.module('../../config/database', () => ({ prisma: db }));
mock.module('../../config/logger', () => ({ createLogger: () => ({ info() {}, warn() {} }) }));
mock.module('./verify-repair-queue', () => ({ enqueueCommittedRepair: enqueue }));
mock.module('./workflow-runner', () => ({
  WorkflowRunner: { getInstance: () => ({ startProcessing: start }) },
}));
const { ensureRunnerResumes } = await import('./verify-self-repair-resume');
const receipt = { updatedAt: new Date(), workflowStatus: 'plan_approved', executionId: 7 };
beforeEach(() => {
  enqueue.mockReset().mockResolvedValue('queued');
  start.mockClear();
});
test('passes the exact committed repair identity to queue admission', async () => {
  await ensureRunnerResumes(1, receipt);
  expect(enqueue).toHaveBeenCalledWith(db, 1, receipt);
  expect(start).toHaveBeenCalledTimes(1);
});
test('held and scheduler-owned repairs never start a competing runner', async () => {
  for (const result of ['held', 'scheduler_owned'] as const) {
    enqueue.mockResolvedValueOnce(result);
    await ensureRunnerResumes(1, receipt);
  }
  expect(start).not.toHaveBeenCalled();
});
test('a durable existing queue item permits idempotent runner wake-up', async () => {
  enqueue.mockResolvedValueOnce('existing');
  await ensureRunnerResumes(1, receipt);
  expect(start).toHaveBeenCalledTimes(1);
});
test('transaction failure propagates without waking the runner', async () => {
  enqueue.mockRejectedValueOnce(new Error('queue transaction unavailable'));
  await expect(ensureRunnerResumes(1, receipt)).rejects.toThrow('queue transaction unavailable');
  expect(start).not.toHaveBeenCalled();
});
