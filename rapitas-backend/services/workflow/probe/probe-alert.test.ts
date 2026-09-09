/**
 * probe-alert.test
 *
 * Tests for alertPermanentProbeFailure: dedupKey shape, task.status='blocked'
 * update, and never-throw behavior when submitConcern rejects.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockSubmitConcern = mock(async (_input: unknown) => 1);
mock.module('../../memory/concern-backlog-service', () => ({
  submitConcern: mockSubmitConcern,
}));

const revision = new Date(0);
const mockTaskUpdate = mock(async (_args: unknown) => ({}));
mock.module('../../../config/database', () => ({
  prisma: {
    task: { update: mockTaskUpdate, findUnique: mock(async () => ({ updatedAt: revision })) },
  },
}));

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
mock.module('../../../config/logger', () => ({
  logger: noopLogger,
  createLogger: () => noopLogger,
}));

const { alertPermanentProbeFailure } = await import('./probe-alert');

describe('alertPermanentProbeFailure', () => {
  beforeEach(() => {
    mockSubmitConcern.mockClear();
    mockSubmitConcern.mockImplementation(async () => 1);
    mockTaskUpdate.mockClear();
    mockTaskUpdate.mockImplementation(async () => ({}));
  });

  it('files a concern with a per-task-per-target dedupKey and blocks the task', async () => {
    await alertPermanentProbeFailure(673, 'db', 'researcher', 'ECONNREFUSED');

    expect(mockSubmitConcern).toHaveBeenCalledTimes(1);
    expect(mockSubmitConcern.mock.calls[0][0]).toMatchObject({
      type: 'other',
      severity: 'high',
      originTaskId: 673,
      source: 'agent',
      dedupKey: 'probe-permanent-fail:673:db',
    });
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 673, updatedAt: revision },
      data: { status: 'blocked', updatedAt: expect.any(Date) },
    });
  });

  it('never throws when submitConcern rejects', async () => {
    mockSubmitConcern.mockImplementation(async () => {
      throw new Error('db unavailable');
    });

    await expect(alertPermanentProbeFailure(1, 'db', 'researcher', 'x')).resolves.toBeUndefined();
    expect(mockTaskUpdate).not.toHaveBeenCalled();
  });

  it('never throws when the task update rejects', async () => {
    mockTaskUpdate.mockImplementation(async () => {
      throw new Error('task not found');
    });

    await expect(alertPermanentProbeFailure(1, 'db', 'researcher', 'x')).resolves.toBeUndefined();
  });
});
