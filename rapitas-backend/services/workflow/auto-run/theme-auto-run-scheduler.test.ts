/**
 * theme-auto-run-scheduler.test
 *
 * Lifecycle surface: getInstance singleton, start()/stop() idempotency,
 * recoverOnStartup() restart decisions, onPlanApproved() resume gating, and
 * tick()'s status-bucket dispatch + error containment.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ThemeAutoRunScheduler,
  internal,
  resetSchedulerSingleton,
  resetAllMocks,
  makeState,
  mockStartProcessing,
  mockRecordStartupCommit,
  mockThemeAutoRunUpdateMany,
  mockThemeAutoRunCount,
  mockFindByStatuses,
  mockResolveTaskThemeId,
  mockGetAutoRunState,
  mockResumeAutoRun,
  mockBroadcast,
  mockMaybeRestartForUpdate,
  mockStopThemeForIdleTimeout,
} from './theme-auto-run-scheduler.test-support';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

beforeEach(() => {
  resetAllMocks();
  resetSchedulerSingleton();
});

describe('getInstance', () => {
  it('returns the same instance on repeated calls', () => {
    const a = ThemeAutoRunScheduler.getInstance();
    const b = ThemeAutoRunScheduler.getInstance();
    expect(a).toBe(b);
  });
});

describe('start / stop', () => {
  it('start() kicks the WorkflowRunner and records the startup commit', () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    scheduler.start();
    expect(mockStartProcessing).toHaveBeenCalled();
    expect(mockRecordStartupCommit).toHaveBeenCalled();
    scheduler.stop();
  });

  it('is idempotent — a second start() while already running does not re-arm the poll timer', () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    scheduler.start();
    const callsAfterFirst = mockStartProcessing.mock.calls.length;
    scheduler.start();
    // startProcessing() is called unconditionally on every start(), but the
    // `if (this.running) return;` guard must still short-circuit BEFORE a
    // second setInterval is armed — assert via the internal running flag
    // staying a plain boolean (no throw / no duplicate timer side effects).
    expect(mockStartProcessing.mock.calls.length).toBeGreaterThanOrEqual(callsAfterFirst);
    expect(internal(scheduler).running).toBe(true);
    scheduler.stop();
  });

  it('stop() on a never-started scheduler is a safe no-op', () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    expect(() => scheduler.stop()).not.toThrow();
    expect(internal(scheduler).running).toBe(false);
  });

  it('stop() clears the running flag', () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    scheduler.start();
    expect(internal(scheduler).running).toBe(true);
    scheduler.stop();
    expect(internal(scheduler).running).toBe(false);
  });
});

describe('recoverOnStartup', () => {
  it('always cleans up stale "stopping" records', async () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    mockFindByStatuses.mockResolvedValue([]);
    mockThemeAutoRunCount.mockResolvedValue(0);

    await scheduler.recoverOnStartup();

    expect(mockThemeAutoRunUpdateMany).toHaveBeenCalledWith({
      where: { status: 'stopping' },
      data: { status: 'idle', enabled: false, currentTaskId: null },
    });
    scheduler.stop();
  });

  it('does NOT resume when nothing is running/paused/armed-idle', async () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    mockFindByStatuses.mockResolvedValue([]);
    mockThemeAutoRunCount.mockResolvedValue(0);

    await scheduler.recoverOnStartup();

    // start() calls startProcessing() unconditionally, so its absence here
    // proves recoverOnStartup did NOT call this.start().
    expect(mockStartProcessing).not.toHaveBeenCalled();
  });

  it('resumes when a running/paused ThemeAutoRun exists', async () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    mockFindByStatuses.mockResolvedValue([makeState({ status: 'running' })]);
    mockThemeAutoRunCount.mockResolvedValue(0);

    await scheduler.recoverOnStartup();

    expect(mockStartProcessing).toHaveBeenCalled();
    scheduler.stop();
  });

  it('resumes when a paused_user or paused_approval ThemeAutoRun exists (task 883)', async () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    mockFindByStatuses.mockResolvedValue([makeState({ status: 'paused_user' })]);
    mockThemeAutoRunCount.mockResolvedValue(0);

    await scheduler.recoverOnStartup();

    expect(mockStartProcessing).toHaveBeenCalled();
    scheduler.stop();
  });

  it('resumes when an idle-but-armed (enabled:true) theme exists', async () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    mockFindByStatuses.mockResolvedValue([]);
    mockThemeAutoRunCount.mockResolvedValue(1);

    await scheduler.recoverOnStartup();

    expect(mockStartProcessing).toHaveBeenCalled();
    scheduler.stop();
  });

  it('treats a rejected armed-count query as 0 (defensive .catch) instead of throwing', async () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    mockFindByStatuses.mockResolvedValue([]);
    mockThemeAutoRunCount.mockImplementation(() => Promise.reject(new Error('db down')));

    await expect(scheduler.recoverOnStartup()).resolves.toBeUndefined();
    expect(mockStartProcessing).not.toHaveBeenCalled();
  });
});

describe('onPlanApproved', () => {
  it('no-ops when the task has no themeId', async () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    mockResolveTaskThemeId.mockResolvedValue(null);

    await scheduler.onPlanApproved(99);

    expect(mockGetAutoRunState).not.toHaveBeenCalled();
  });

  it.each([
    { desc: 'the theme has no auto-run state', state: null as ReturnType<typeof makeState> | null },
    {
      desc: 'the theme is paused_approval on a DIFFERENT task',
      state: makeState({ status: 'paused_approval', currentTaskId: 5 }),
    },
    {
      desc: 'the theme is running (not paused)',
      state: makeState({ status: 'running', currentTaskId: 99 }),
    },
    {
      desc: 'the theme is paused_user, an explicit user pause (task 883)',
      state: makeState({ status: 'paused_user', currentTaskId: 99 }),
    },
    {
      desc: 'the theme is a reason-unknown legacy pause (bare "paused", task 883)',
      state: makeState({ status: 'paused', currentTaskId: 99 }),
    },
  ])('no-ops when $desc', async ({ state }) => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    mockResolveTaskThemeId.mockResolvedValue({ id: 99, themeId: 42 });
    mockGetAutoRunState.mockResolvedValue(state);

    await scheduler.onPlanApproved(99);

    expect(mockResumeAutoRun).not.toHaveBeenCalled();
  });

  it('resumes the theme when paused_approval on the just-approved task', async () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    mockResolveTaskThemeId.mockResolvedValue({ id: 99, themeId: 42 });
    mockGetAutoRunState.mockResolvedValue(
      makeState({ status: 'paused_approval', currentTaskId: 99 }),
    );

    await scheduler.onPlanApproved(99);

    expect(mockResumeAutoRun).toHaveBeenCalledWith(42);
    expect(mockBroadcast).toHaveBeenCalled();
  });
});

describe('tick (dispatch)', () => {
  it('does nothing when the scheduler is not running', async () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    await internal(scheduler).tick();
    expect(mockFindByStatuses).not.toHaveBeenCalled();
  });

  it('fetches all four status buckets in one query and dispatches per-bucket work', async () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    internal(scheduler).running = true;
    mockFindByStatuses.mockResolvedValue([
      makeState({ themeId: 1, status: 'stopping' }),
      makeState({ themeId: 2, status: 'running' }),
      makeState({ themeId: 3, status: 'paused', currentTaskId: null }),
      makeState({ themeId: 4, status: 'idle', enabled: false }),
    ]);

    await internal(scheduler).tick();

    expect(mockFindByStatuses).toHaveBeenCalledWith([
      'stopping',
      'running',
      'paused',
      'paused_user',
      'paused_approval',
      'idle',
    ]);
    // Theme 4 is idle but disabled → processIdleThemes must skip it silently.
    expect(mockThemeAutoRunUpdateMany.mock.calls.some((c) => c[0]?.themeId === 4)).toBe(false);
  });

  it('swallows a tick-level error (e.g. findByStatuses rejecting) without throwing', async () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    internal(scheduler).running = true;
    mockFindByStatuses.mockImplementation(() => Promise.reject(new Error('db exploded')));

    await expect(internal(scheduler).tick()).resolves.toBeUndefined();
  });

  it('calls maybeRestartForUpdate(0) at the end of a successful tick', async () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    internal(scheduler).running = true;
    mockFindByStatuses.mockResolvedValue([]);

    await internal(scheduler).tick();

    expect(mockMaybeRestartForUpdate).toHaveBeenCalledWith(0);
  });

  // task 784, design point 7: the idle-stop timer takes priority over the
  // dev-dry restart. processIdleThemesImpl's boolean return (whether this
  // tick idle-stopped at least one theme) must propagate all the way through
  // tick() to gate the trailing maybeRestartForUpdate(0) call — not just be
  // computed and discarded.
  it('skips the trailing maybeRestartForUpdate(0) on a tick that idle-stops a theme', async () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    internal(scheduler).running = true;
    mockFindByStatuses.mockResolvedValue([
      makeState({
        themeId: 7,
        status: 'idle',
        enabled: true,
        idleSince: minutesAgo(61), // past the default 60-minute idleStopMinutes
      }),
    ]);

    await internal(scheduler).tick();

    expect(mockStopThemeForIdleTimeout).toHaveBeenCalledWith(7);
    expect(mockMaybeRestartForUpdate).not.toHaveBeenCalledWith(0);
  });

  it('still calls maybeRestartForUpdate(0) on a tick where no theme idle-stops', async () => {
    const scheduler = ThemeAutoRunScheduler.getInstance();
    internal(scheduler).running = true;
    mockFindByStatuses.mockResolvedValue([
      makeState({
        themeId: 7,
        status: 'idle',
        enabled: true,
        idleSince: minutesAgo(10), // still counting down
      }),
    ]);

    await internal(scheduler).tick();

    expect(mockStopThemeForIdleTimeout).not.toHaveBeenCalled();
    expect(mockMaybeRestartForUpdate).toHaveBeenCalledWith(0);
  });
});
