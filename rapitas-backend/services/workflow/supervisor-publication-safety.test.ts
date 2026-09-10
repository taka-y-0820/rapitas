import { expect, mock, test } from 'bun:test';

const lookup = mock(async (): Promise<{ id: number; status: string } | null> => null);
let row = { status: 'in-progress', workflowStatus: 'verify_done' as string | null };
const transition = mock(async () => {});
mock.module('../../config/database', () => ({
  prisma: {
    agentExecution: { findFirst: lookup },
    workflowTransition: { findFirst: async () => null },
    task: {
      updateMany: async ({ where, data }: any) => {
        if (!where.status.in.includes(row.status) || where.workflowStatus !== row.workflowStatus)
          return { count: 0 };
        row = { ...row, ...data };
        return { count: 1 };
      },
    },
  },
}));
mock.module('./transition-recorder', () => ({ recordTransition: transition }));
const { publicationAborted } = await import('./publication-cancellation-guard');
const { holdForRequiredMerge } = await import('./required-merge-hold');

test('unreadable cancellation record withholds publication; a later successful read permits retry', async () => {
  lookup.mockRejectedValueOnce(new Error('database unavailable'));
  expect(await publicationAborted(895, 'before-pr')).toBe(true);
  expect(await publicationAborted(895, 'before-pr')).toBe(false);
});

test('merge hold cannot resurrect stopped/failed tasks or overwrite a newer workflow phase', async () => {
  const input = { taskId: 895, fromStatus: 'verify_done', source: 'supervisor-test' };
  for (const status of ['cancelled', 'canceled', 'canceling', 'blocked', 'failed', 'done']) {
    row = { status, workflowStatus: 'verify_done' };
    expect(await holdForRequiredMerge(input)).toBe(false);
    expect(row.status).toBe(status);
  }
  row = { status: 'in-progress', workflowStatus: 'research_done' };
  expect(await holdForRequiredMerge(input)).toBe(false);
  expect(row.workflowStatus).toBe('research_done');
  expect(transition).not.toHaveBeenCalled();
  row = { status: 'in-progress', workflowStatus: 'verify_done' };
  expect(await holdForRequiredMerge(input)).toBe(true);
  expect(transition).toHaveBeenCalledTimes(1);
});
