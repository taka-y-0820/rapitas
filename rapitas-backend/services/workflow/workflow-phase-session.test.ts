import { beforeEach, expect, mock, test } from 'bun:test';

const updateMany = mock(async (_args: unknown) => ({ count: 1 }));
mock.module('../../config', () => ({ prisma: { agentSession: { updateMany } } }));
mock.module('../../config/logger', () => ({
  createLogger: () => ({ warn: () => {} }),
}));
const { finalizePhaseSession } = await import('./workflow-phase-session');

beforeEach(() => updateMany.mockClear());

test('completion is a conditional write requiring only completed executions and an active session', async () => {
  await finalizePhaseSession(42, true);
  expect(updateMany).toHaveBeenCalledWith({
    where: {
      id: 42,
      status: { in: ['active', 'running'] },
      agentExecutions: { some: {}, every: { status: { in: ['completed'] } } },
    },
    data: {
      status: 'completed',
      completedAt: expect.any(Date),
      lastActivityAt: expect.any(Date),
    },
  });
});

test('rejected output records a failed session even when the CLI succeeded', async () => {
  await finalizePhaseSession(42, false);
  expect(updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        agentExecutions: { some: {}, every: { status: { in: ['completed', 'failed'] } } },
      }),
      data: expect.objectContaining({ status: 'failed' }),
    }),
  );
});

test('a lost conditional write never retries by overwriting a stopped session', async () => {
  updateMany.mockImplementationOnce(async () => ({ count: 0 }));
  await finalizePhaseSession(42, true);
  expect(updateMany).toHaveBeenCalledTimes(1);
});

test('database failure does not turn the phase result into a fabricated success', async () => {
  updateMany.mockImplementationOnce(async () => {
    throw new Error('offline');
  });
  await finalizePhaseSession(42, true);
  expect(updateMany).toHaveBeenCalledTimes(1);
});
