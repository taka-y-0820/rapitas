import { beforeEach, expect, mock, test } from 'bun:test';
const find = mock(
  async (): Promise<{ themeId: number | null; status: string } | null> => ({
    themeId: null,
    status: 'in-progress',
  }),
);
const queued = mock(async (): Promise<{ id: number } | null> => null);
const active = mock(async () => false);
const enqueue = mock(async (_args: unknown) => undefined);
const start = mock(() => undefined);
mock.module('../../config/database', () => ({
  prisma: { task: { findUnique: find }, workflowQueueItem: { findFirst: queued } },
}));
mock.module('../../config/logger', () => ({ createLogger: () => ({ info() {}, warn() {} }) }));
mock.module('./auto-run/theme-auto-run-service', () => ({ isThemeAutoRunActive: active }));
mock.module('./workflow-queue', () => ({
  WorkflowQueueService: { getInstance: () => ({ enqueue }) },
}));
mock.module('./workflow-runner', () => ({
  WorkflowRunner: { getInstance: () => ({ startProcessing: start }) },
}));
const { ensureRunnerResumes } = await import('./verify-self-repair-resume');
beforeEach(() => {
  find.mockReset().mockResolvedValue({ themeId: null, status: 'in-progress' });
  active.mockReset().mockResolvedValue(false);
  enqueue.mockReset().mockResolvedValue(undefined);
  queued.mockReset().mockResolvedValue(null);
  start.mockClear();
});
test('stopped and missing tasks never restart the runner', async () => {
  for (const task of [null, { themeId: 1, status: 'todo' }, { themeId: 1, status: 'done' }]) {
    find.mockResolvedValueOnce(task);
    await ensureRunnerResumes(1);
  }
  expect(enqueue).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});
test('unavailable task or scheduler state never falls through to execution', async () => {
  find.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(ensureRunnerResumes(1)).rejects.toThrow();
  active.mockRejectedValueOnce(new Error('scheduler unavailable'));
  await expect(ensureRunnerResumes(1)).rejects.toThrow();
  expect(enqueue).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});
test('active manual task resumes while scheduler-owned task does not duplicate it', async () => {
  active.mockResolvedValueOnce(true);
  await ensureRunnerResumes(1);
  expect(enqueue).not.toHaveBeenCalled();
  await ensureRunnerResumes(1);
  expect(enqueue).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledTimes(1);
});

test('failed enqueue without a durable queue item never starts processing', async () => {
  enqueue.mockRejectedValueOnce(new Error('queue unavailable'));
  await expect(ensureRunnerResumes(1)).rejects.toThrow('queue unavailable');
  expect(start).not.toHaveBeenCalled();
});

test('confirmed duplicate queue item permits an idempotent resume', async () => {
  enqueue.mockRejectedValueOnce(new Error('already queued'));
  queued.mockResolvedValueOnce({ id: 10 });
  await ensureRunnerResumes(1);
  expect(start).toHaveBeenCalledTimes(1);
});

test('failed duplicate lookup does not assume successful queueing', async () => {
  enqueue.mockRejectedValueOnce(new Error('enqueue failure'));
  queued.mockRejectedValueOnce(new Error('lookup failure'));
  await expect(ensureRunnerResumes(1)).rejects.toThrow('lookup failure');
  expect(start).not.toHaveBeenCalled();
});
