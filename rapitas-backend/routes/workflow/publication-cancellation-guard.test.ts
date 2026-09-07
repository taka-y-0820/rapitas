import { expect, test, mock } from 'bun:test';
import { createPublicationCancellationGuard } from './publication-cancellation-guard';

function fixture(status = 'completed') {
  const rows = [{ id: 2, status }];
  const task = { status: 'in-progress', workflowStatus: 'verify_done' };
  const client = {
    agentExecution: { findMany: mock(async () => rows) },
    task: { findUnique: mock(async () => task) },
  };
  return {
    rows,
    task,
    client,
    prisma: client as unknown as Parameters<typeof createPublicationCancellationGuard>[0],
  };
}

test.each([
  'canceling',
  'cancelled',
  'canceled',
  'interrupted',
  'running',
  'pending',
  'waiting_for_input',
  'failed',
  'unknown',
])('withholds publication for latest execution status %s', async (status) => {
  const f = fixture(status);
  await expect(createPublicationCancellationGuard(f.prisma, 10, 20)).rejects.toThrow(
    'Publication withheld',
  );
});

test('a legitimate completed retry is not blocked by historical cancellation', async () => {
  const f = fixture();
  f.rows.push({ id: 1, status: 'cancelled' });
  const check = await createPublicationCancellationGuard(f.prisma, 10, 20);
  await expect(check()).resolves.toBeUndefined();
  expect(f.client.agentExecution.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { sessionId: 20, session: { config: { taskId: 10 } } } }),
  );
});

test('a still-canceling earlier attempt blocks publication even when the latest one completed', async () => {
  const f = fixture();
  f.rows.push({ id: 1, status: 'canceling' });
  await expect(createPublicationCancellationGuard(f.prisma, 10, 20)).rejects.toThrow(
    'Publication withheld',
  );
});

test('a replacement execution cannot publish under the old guard', async () => {
  const f = fixture();
  const check = await createPublicationCancellationGuard(f.prisma, 10, 20);
  f.rows.unshift({ id: 3, status: 'completed' });
  await expect(check()).rejects.toThrow('superseded');
});

test('stop or missing evidence after binding withholds the next operation', async () => {
  const f = fixture();
  const check = await createPublicationCancellationGuard(f.prisma, 10, 20);
  f.task.status = 'blocked';
  await expect(check()).rejects.toThrow('Publication withheld');
  f.task.status = 'in-progress';
  f.rows.length = 0;
  await expect(check()).rejects.toThrow('Publication withheld');
});

test('DB read failure propagates instead of allowing publication', async () => {
  const f = fixture();
  const check = await createPublicationCancellationGuard(f.prisma, 10, 20);
  f.client.agentExecution.findMany.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(check()).rejects.toThrow('database unavailable');
});
