import { test, expect, mock } from 'bun:test';
const task = mock(async () => ({ status: 'todo', themeId: 1 }));
const run = mock(async () => ({ enabled: false, status: 'idle' }));
mock.module('../../config', () => ({
  prisma: { task: { findUnique: task }, themeAutoRun: { findUnique: run } },
}));
const { isQueueThemeRunning } = await import('./queue-theme-guard');
test('theme-less repair queue items still honor the owning task stop', async () => {
  expect(await isQueueThemeRunning(894)).toBe(false);
  expect(run).toHaveBeenCalledWith({
    where: { themeId: 1 },
    select: { enabled: true, status: true },
  });
  run.mockResolvedValueOnce({ enabled: true, status: 'running' });
  expect(await isQueueThemeRunning(894)).toBe(true);
  task.mockResolvedValueOnce({ status: 'blocked', themeId: 1 });
  expect(await isQueueThemeRunning(894)).toBe(false);
  task.mockRejectedValueOnce(new Error('offline'));
  expect(await isQueueThemeRunning(894)).toBe(false);
});
