import { test, expect, mock } from 'bun:test';
import { writeBlockedTask } from './blocked-task-write';

test('two writers observing the same revision cannot both commit', async () => {
  const observed = new Date(Date.now() + 60_000);
  let revision = observed;
  const update = mock(async ({ where, data }: any) => {
    if (where.updatedAt.getTime() !== revision.getTime()) throw new Error('revision conflict');
    revision = data.updatedAt;
    return data;
  });
  const db = { task: { findUnique: mock(async () => ({ updatedAt: observed })), update } };
  const results = await Promise.allSettled([
    writeBlockedTask(db as never, 1, { workflowStatus: 'verify_done' }),
    writeBlockedTask(db as never, 1),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(revision.getTime()).toBe(observed.getTime() + 1);
  expect(update.mock.calls[0][0].data).toMatchObject({
    status: 'blocked',
    workflowStatus: 'verify_done',
  });
});

test('missing or unreadable task cannot produce a blind write', async () => {
  const update = mock(async () => ({}));
  const findUnique = mock(async (): Promise<{ updatedAt: Date } | null> => null);
  const db = { task: { findUnique, update } };
  await expect(writeBlockedTask(db as never, 2)).rejects.toThrow('missing task');
  findUnique.mockRejectedValueOnce(new Error('read unavailable'));
  await expect(writeBlockedTask(db as never, 2)).rejects.toThrow('read unavailable');
  expect(update).not.toHaveBeenCalled();
});

test('caller data cannot override the hold or its revision', async () => {
  const previous = new Date(Date.now() + 60_000);
  const update = mock(async ({ data }: any) => data);
  const db = { task: { findUnique: mock(async () => ({ updatedAt: previous })), update } };
  const result = await writeBlockedTask(db as never, 3, { status: 'done', updatedAt: new Date(0) });
  expect(result.status).toBe('blocked');
  expect(result.updatedAt.getTime()).toBe(previous.getTime() + 1);
});
