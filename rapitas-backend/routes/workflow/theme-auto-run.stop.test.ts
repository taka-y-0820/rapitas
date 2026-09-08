import { beforeEach, expect, mock, test } from 'bun:test';
const db = {
  theme: { findUnique: async () => ({ id: 1, isDevelopment: true, workingDirectory: '/test' }) },
};
mock.module('../../config', () => ({ prisma: db }));
mock.module('../../config/logger', () => ({ createLogger: () => ({ info() {}, error() {} }) }));
mock.module('../../services/observability', () => ({ logCycleEvent() {} }));
mock.module('../../services/workflow/auto-run/theme-auto-run-scheduler', () => ({
  ThemeAutoRunScheduler: { getInstance: () => ({ start() {} }) },
}));
const state = { currentTaskId: null, enabled: false, status: 'stopping' };
mock.module('../../services/workflow/auto-run/theme-auto-run-service', () => ({
  getOrCreateAutoRun: async () => state,
  startAutoRun: async () => state,
  pauseAutoRun: async () => state,
  stopAutoRun: async () => state,
  toPublicAutoRunState: (s: unknown) => s,
}));
const stop = mock(async () => ({ stoppedCount: 2, executionIds: [91, 92] }));
const settle = mock(async (_db: unknown, _ids: number[]) => [1, 2]);
mock.module('../../services/agents/stop-task-agents', () => ({ stopThemeAgents: stop }));
mock.module('../../services/agents/settle-stopped-tasks', () => ({ settleStoppedTasks: settle }));
const { themeAutoRunRoutes } = await import('./theme-auto-run');
beforeEach(() => {
  stop.mockReset().mockResolvedValue({ stoppedCount: 2, executionIds: [91, 92] });
  settle.mockReset().mockResolvedValue([1, 2]);
});
const request = () =>
  themeAutoRunRoutes.handle(
    new Request('http://localhost/themes/1/auto-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    }),
  );
test('null current task still settles every stopped execution before reporting success', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect((await response.json()).success).toBe(true);
  expect(settle).toHaveBeenCalledWith(db, [91, 92]);
});
test('settlement failure is reported as failure, never successful stop', async () => {
  settle.mockRejectedValueOnce(new Error('DB unavailable'));
  const response = await request();
  expect(response.status).toBe(500);
  expect((await response.json()).success).toBe(false);
});
test('agent stop failure is not converted to an empty successful stop', async () => {
  stop.mockRejectedValueOnce(new Error('stop unavailable'));
  const response = await request();
  expect(response.status).toBe(500);
  expect(settle).not.toHaveBeenCalled();
});
