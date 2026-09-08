import { test, expect, mock } from 'bun:test';
const task = mock(async () => ({ status: 'in-progress', themeId: 1 }));
const run = mock(async () => ({ enabled: true, status: 'running' }));
mock.module('../../config/database', () => ({
  prisma: { task: { findUnique: task }, themeAutoRun: { findUnique: run } },
}));
const { canContinueAutoMerge } = await import('./auto-merge-task-guard');
test('honors stopped themes and cancellation, and fails closed on DB failure', async () => {
  expect(await canContinueAutoMerge(1)).toBe(true);
  run.mockResolvedValueOnce({ enabled: false, status: 'idle' });
  expect(await canContinueAutoMerge(1)).toBe(false);
  task.mockResolvedValueOnce({ status: 'cancelled', themeId: 1 });
  expect(await canContinueAutoMerge(1)).toBe(false);
  task.mockRejectedValueOnce(new Error('db unavailable'));
  expect(await canContinueAutoMerge(1)).toBe(false);
});
