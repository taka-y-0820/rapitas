/**
 * preview-session-manager.pending-cleanup.test
 *
 * Regression coverage for the orphaned-process bug: startPreview keeps
 * running to completion server-side even after the calling client gives up
 * (a timed-out/abandoned fetch does NOT cancel the in-flight request), and
 * previously nothing tracked the dev-server process or browser until the
 * ENTIRE chain succeeded — so a client that gave up left them running
 * forever, invisible to `sessions`/stopPreview. Confirmed live: three
 * abandoned `next dev` processes for the same task, all still running,
 * fighting over the same build cache.
 *
 * These tests exercise the `pending` map directly via a startPreview call
 * deliberately stalled at the health-check step (waitForHealthy mocked to
 * hang until the test resolves it), verifying stopPreview can reach in and
 * kill the launched app before the attempt ever reaches `sessions`.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import * as realFs from 'fs';

mock.module('../../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }),
}));
mock.module('../../../config/database', () => ({
  ensureDatabaseConnection: () => Promise.resolve(),
  prisma: { task: { findUnique: () => Promise.resolve(null) } },
}));
let resolveWorktree = () => Promise.resolve({ worktreePath: '/repo', branchName: 'feature/x' });
mock.module('../agent-session-resolver', () => ({
  resolveLatestSessionWorktree: () => resolveWorktree(),
}));
// mock.module is process-global in bun:test — spread the real module so any
// OTHER export a transitive import needs (e.g. agent-process-tracker's
// readFileSync, pulled in via preview-session-manager's killProcessTreeSafely
// import) stays intact, and only override what this file actually needs.
mock.module('fs', () => ({ ...realFs, existsSync: () => true }));
mock.module('../verification/runtime-smoke/runtime-config', () => ({
  resolveRuntimeConfig: () =>
    Promise.resolve({
      config: {
        start: 'npm run dev -- -p {port}',
        url: 'http://localhost:{port}',
        healthPath: '/',
        readyTimeoutMs: 5_000,
        checkPaths: ['/'],
      },
    }),
  substitutePort: (template: string, port: number) => template.split('{port}').join(String(port)),
}));

const mockCancel = mock(() => {});
const mockLaunchApp = mock(() => {});
let resolveHealthy: (v: boolean) => void = () => {};
let healthyPromise: Promise<boolean>;
mock.module('../verification/runtime-smoke/worktree-server-registry', () => ({
  acquireRuntimeServer: async (_workdir: string, _cfg: unknown, opts: { signal: AbortSignal }) => {
    mockLaunchApp();
    opts.signal.addEventListener('abort', mockCancel, { once: true });
    await healthyPromise;
    return { ok: false, reason: 'cancelled or unhealthy', logs: [] };
  },
  releaseRuntimeServer: mock(() => {}),
}));
const { startPreview, stopPreview, getPreviewStatus } = await import('./preview-session-manager');

beforeEach(() => {
  resolveWorktree = () => Promise.resolve({ worktreePath: '/repo', branchName: 'feature/x' });
  mockCancel.mockClear();
  mockLaunchApp.mockClear();
  healthyPromise = new Promise<boolean>((res) => {
    resolveHealthy = res;
  });
});

it('stop during worktree resolution prevents a late server acquisition', async () => {
  let complete!: (value: { worktreePath: string; branchName: string }) => void;
  resolveWorktree = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  const starting = startPreview(43);
  await new Promise((r) => setTimeout(r, 10));
  expect(getPreviewStatus(43)).toEqual({ active: false, pending: true });
  await stopPreview(43);
  complete({ worktreePath: '/repo', branchName: 'feature/x' });
  expect((await starting).ok).toBe(false);
  expect(mockLaunchApp).not.toHaveBeenCalled();
});

describe('stopPreview cancels an in-progress launch', () => {
  it('aborts only the pending registry acquisition', async () => {
    const startResult = startPreview(42); // hangs at waitForHealthy until resolved below

    // Let startPreview run far enough to have called launchApp and
    // registered it in `pending` (a microtask tick is enough — everything
    // before waitForHealthy is either synchronous or resolves immediately
    // against the mocks above).
    await new Promise((r) => setTimeout(r, 10));
    expect(mockLaunchApp).toHaveBeenCalledTimes(1);
    expect(mockCancel).not.toHaveBeenCalled();

    await stopPreview(42);
    expect(mockCancel).toHaveBeenCalledTimes(1);

    // Let the stalled startPreview call finish so it doesn't dangle into
    // the next test — its own result no longer matters (app.stop() from
    // stopPreview doesn't make waitForHealthy resolve on its own; the mock
    // needs an explicit answer here).
    resolveHealthy(false);
    const result = await startResult;
    expect(result.ok).toBe(false);
  });

  it('is a no-op when nothing is pending or active for the task', async () => {
    await expect(stopPreview(999_999)).resolves.toBeUndefined();
    expect(mockCancel).not.toHaveBeenCalled();
  });
});

describe('getPreviewStatus reflects an in-progress launch', () => {
  it('reports pending:true while a launch is stalled before `sessions`, then settles', async () => {
    // Confirms a page reload mid-start (before the original request's own
    // response ever arrives) can tell "already starting" apart from "not
    // running at all" instead of the two looking identical.
    expect(getPreviewStatus(42)).toEqual({ active: false });

    const startResult = startPreview(42);
    await new Promise((r) => setTimeout(r, 10));
    expect(getPreviewStatus(42)).toEqual({ active: false, pending: true });

    resolveHealthy(false); // fail fast — this test only cares about the pending window
    await startResult;
    expect(getPreviewStatus(42)).toEqual({ active: false });
  });
});
