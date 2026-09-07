import { beforeEach, expect, mock, test } from 'bun:test';
let configured = true;
let healthy = true;
let logs: string[] = [];
let browserAvailable = true;
let harnessError = false;
const stop = mock(() => {});
const launch = mock(() => ({ logs: () => logs, stop }));
mock.module('./runtime-config', () => ({
  resolveRuntimeConfig: async () =>
    configured
      ? {
          config: {
            start: 'app',
            url: 'http://127.0.0.1:3009',
            healthPath: '/',
            readyTimeoutMs: 100,
            checkPaths: ['/'],
          },
        }
      : null,
  substitutePort: (s: string) => s,
}));
mock.module('./app-launcher', () => ({
  allocateFreePort: async () => 3009,
  launchApp: launch,
  waitForHealthy: async () => {
    if (harnessError) throw new Error('harness');
    return healthy;
  },
}));
mock.module('./browser-smoke', () => ({
  runBrowserSmoke: async () => ({
    browserAvailable,
    unavailableReason: 'missing browser',
    findings: [{ path: '/', httpStatus: 200, pageErrors: [], serverErrors: [], consoleErrors: [] }],
  }),
}));
const { runRuntimeSmokeCheck } = await import('./runtime-check');
beforeEach(() => {
  configured = true;
  healthy = true;
  logs = [];
  browserAvailable = true;
  harnessError = false;
  stop.mockClear();
  launch.mockClear();
});
test('unconfigured projects remain not applicable', async () => {
  configured = false;
  expect(await runRuntimeSmokeCheck('/no-config')).toBeNull();
  expect(launch).not.toHaveBeenCalled();
});
test('completed browser verification succeeds and cleans up', async () => {
  expect(await runRuntimeSmokeCheck('/success')).toMatchObject({ ran: true, ok: true });
  expect(stop).toHaveBeenCalledTimes(1);
});
test('app startup failure remains a failed executed check', async () => {
  healthy = false;
  expect(await runRuntimeSmokeCheck('/app-failure')).toMatchObject({
    ran: true,
    ok: false,
    errorCount: 1,
  });
});
test('environment failure and its cached result are both unverifiable', async () => {
  healthy = false;
  logs = ['points out of the filesystem root'];
  for (let i = 0; i < 2; i++) {
    expect(await runRuntimeSmokeCheck('/broken-env')).toMatchObject({
      ran: false,
      ok: false,
      unverifiable: true,
    });
  }
  expect(launch).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(1);
});
test('HTTP readiness without browser cannot complete runtime verification', async () => {
  browserAvailable = false;
  expect(await runRuntimeSmokeCheck('/missing-browser')).toMatchObject({
    ran: false,
    ok: false,
    unverifiable: true,
  });
  expect(stop).toHaveBeenCalledTimes(1);
});
test('harness error retains unavailable evidence and cleans up', async () => {
  harnessError = true;
  expect(await runRuntimeSmokeCheck('/harness-error')).toMatchObject({
    ran: false,
    ok: false,
    unverifiable: true,
  });
  expect(stop).toHaveBeenCalledTimes(1);
});
