/**
 * theme-auto-run-scheduler.stopping-idle-paused.test
 *
 * Covers processStoppingThemes(), processIdleThemes(), processPausedThemes(),
 * stopThemeExecution(), and broadcastAutoRunUpdate() — the per-bucket private
 * handlers invoked by tick().
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ThemeAutoRunScheduler,
  internal,
  resetSchedulerSingleton,
  resetAllMocks,
  makeState,
  mockQueueItemUpdateMany,
  mockFinalizeStop,
  mockBroadcast,
  mockResolveTaskWorkingDirectory,
  mockStopThemeAgents,
  mockRevertChanges,
  mockTaskUpdate,
  mockTaskCount,
  mockRecordTransition,
  mockHasPromotableBacklog,
  mockPromoteBacklogForTheme,
  mockStartAutoRun,
  mockGetThemeActiveQueueItems,
  mockQueueItemFindFirst,
  mockResumeAutoRun,
  mockGetIdleStopMinutes,
  mockCountHumanOriginTodo,
  mockAttemptCriticalConcernBypass,
  mockStopThemeForIdleTimeout,
  mockShouldRefillBacklogNow,
  mockMarkSelfRefillSucceeded,
  mockLogCycleEvent,
} from './theme-auto-run-scheduler.test-support';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

let scheduler: ThemeAutoRunScheduler;

beforeEach(() => {
  resetAllMocks();
  resetSchedulerSingleton();
  scheduler = ThemeAutoRunScheduler.getInstance();
});

describe('processStoppingThemes', () => {
  it('does nothing for an empty list', async () => {
    await internal(scheduler).processStoppingThemes([]);
    expect(mockFinalizeStop).not.toHaveBeenCalled();
  });

  it('cancels queue items, finalizes, and broadcasts for each stopping theme', async () => {
    const states = [
      makeState({ themeId: 10, status: 'stopping', currentTaskId: 100 }),
      makeState({ themeId: 20, status: 'stopping', currentTaskId: null }),
    ];

    await internal(scheduler).processStoppingThemes(states);

    expect(mockQueueItemUpdateMany).toHaveBeenCalledTimes(2);
    expect(mockFinalizeStop).toHaveBeenCalledWith(10);
    expect(mockFinalizeStop).toHaveBeenCalledWith(20);
    expect(mockBroadcast).toHaveBeenCalledTimes(2);
  });

  it('an error stopping ONE theme does not block the others in the batch', async () => {
    mockQueueItemUpdateMany.mockImplementationOnce(() => Promise.reject(new Error('db down')));
    const states = [
      makeState({ themeId: 10, status: 'stopping' }),
      makeState({ themeId: 20, status: 'stopping' }),
    ];

    await internal(scheduler).processStoppingThemes(states);

    // Theme 10's stopThemeExecution failed (updateMany rejected), so it never
    // reaches finalizeStop; theme 20 must still complete normally.
    expect(mockFinalizeStop).not.toHaveBeenCalledWith(10);
    expect(mockFinalizeStop).toHaveBeenCalledWith(20);
  });
});

describe('processIdleThemes', () => {
  it('skips a user-stopped (enabled:false) theme entirely', async () => {
    await internal(scheduler).processIdleThemes([makeState({ enabled: false })]);
    expect(mockTaskCount).not.toHaveBeenCalled();
    expect(mockStartAutoRun).not.toHaveBeenCalled();
  });

  it('stays idle when there is no todo task and no promotable backlog', async () => {
    mockTaskCount.mockResolvedValue(0);
    mockHasPromotableBacklog.mockResolvedValue(false);

    await internal(scheduler).processIdleThemes([makeState({ enabled: true, themeId: 7 })]);

    expect(mockStartAutoRun).not.toHaveBeenCalled();
    expect(mockTaskCount).toHaveBeenCalledWith({
      where: {
        themeId: 7,
        status: 'todo',
        parentId: null,
        workflowDisabled: false,
        OR: [{ workflowStatus: null }, { workflowStatus: { not: 'awaiting_question' } }],
      },
    });
  });

  it('resumes on a fresh todo task WITHOUT even checking the backlog (short-circuit)', async () => {
    mockTaskCount.mockResolvedValue(1);

    await internal(scheduler).processIdleThemes([makeState({ enabled: true, themeId: 7 })]);

    expect(mockStartAutoRun).toHaveBeenCalledWith(7);
    expect(mockHasPromotableBacklog).not.toHaveBeenCalled();
  });

  it('resumes when no todo task exists but the backlog has a promotable item', async () => {
    mockTaskCount.mockResolvedValue(0);
    mockHasPromotableBacklog.mockResolvedValue(true);

    await internal(scheduler).processIdleThemes([makeState({ enabled: true, themeId: 7 })]);

    expect(mockStartAutoRun).toHaveBeenCalledWith(7);
  });

  it('a rejection while checking one theme does not stop the next theme in the batch', async () => {
    mockTaskCount
      .mockImplementationOnce(() => Promise.reject(new Error('db down')))
      .mockImplementationOnce(() => Promise.resolve(0));
    mockHasPromotableBacklog.mockImplementation((themeId: number) =>
      // task.count itself is defensively .catch(() => 0)'d inside the scheduler,
      // so make the FAILURE surface via hasPromotableBacklog instead for theme 1.
      themeId === 1 ? Promise.reject(new Error('backlog check failed')) : Promise.resolve(true),
    );

    await internal(scheduler).processIdleThemes([
      makeState({ enabled: true, themeId: 1 }),
      makeState({ enabled: true, themeId: 2 }),
    ]);

    expect(mockStartAutoRun).not.toHaveBeenCalledWith(1);
    expect(mockStartAutoRun).toHaveBeenCalledWith(2);
  });

  it('returns false when nothing timed out this pass', async () => {
    const timedOut = await internal(scheduler).processIdleThemes([
      makeState({ enabled: true, themeId: 7 }),
    ]);
    expect(timedOut).toBe(false);
  });
});

describe('processIdleThemes — idle-stop timer (task 784)', () => {
  it('a human-filed task during the countdown resumes immediately (bypasses the wait)', async () => {
    mockGetIdleStopMinutes.mockResolvedValue(60);
    mockCountHumanOriginTodo.mockResolvedValue(1);

    await internal(scheduler).processIdleThemes([
      makeState({ enabled: true, themeId: 7, status: 'idle', idleSince: minutesAgo(10) }),
    ]);

    expect(mockStartAutoRun).toHaveBeenCalledWith(7);
    expect(mockStopThemeForIdleTimeout).not.toHaveBeenCalled();
  });

  it('a high/urgent concern bypass during the countdown resumes immediately', async () => {
    mockGetIdleStopMinutes.mockResolvedValue(60);
    mockCountHumanOriginTodo.mockResolvedValue(0);
    mockAttemptCriticalConcernBypass.mockResolvedValue(true);

    await internal(scheduler).processIdleThemes([
      makeState({ enabled: true, themeId: 7, status: 'idle', idleSince: minutesAgo(10) }),
    ]);

    expect(mockStartAutoRun).toHaveBeenCalledWith(7);
  });

  it('keeps waiting while the countdown has not expired and nothing bypasses it', async () => {
    mockGetIdleStopMinutes.mockResolvedValue(60);
    mockCountHumanOriginTodo.mockResolvedValue(0);
    mockAttemptCriticalConcernBypass.mockResolvedValue(false);

    const timedOut = await internal(scheduler).processIdleThemes([
      makeState({ enabled: true, themeId: 7, status: 'idle', idleSince: minutesAgo(10) }),
    ]);

    expect(timedOut).toBe(false);
    expect(mockStartAutoRun).not.toHaveBeenCalled();
    expect(mockStopThemeForIdleTimeout).not.toHaveBeenCalled();
  });

  it('stops the theme once the countdown expires, and processIdleThemes returns true', async () => {
    mockGetIdleStopMinutes.mockResolvedValue(60);

    const timedOut = await internal(scheduler).processIdleThemes([
      makeState({ enabled: true, themeId: 7, status: 'idle', idleSince: minutesAgo(61) }),
    ]);

    expect(timedOut).toBe(true);
    expect(mockStopThemeForIdleTimeout).toHaveBeenCalledWith(7);
    expect(mockBroadcast).toHaveBeenCalledWith(
      'orchestra',
      'auto_run_update',
      expect.objectContaining({ themeId: 7 }),
    );
    expect(mockStartAutoRun).not.toHaveBeenCalled();
  });

  it('a legacy row with no idleSince yet checks for work, then starts the timer instead of stopping', async () => {
    mockGetIdleStopMinutes.mockResolvedValue(60);
    mockTaskCount.mockResolvedValue(0);
    mockHasPromotableBacklog.mockResolvedValue(false);

    const timedOut = await internal(scheduler).processIdleThemes([
      makeState({ enabled: true, themeId: 7, idleSince: null }),
    ]);

    expect(timedOut).toBe(false);
    expect(mockStopThemeForIdleTimeout).not.toHaveBeenCalled();
    expect(mockStartAutoRun).not.toHaveBeenCalled();
  });
});

describe('processIdleThemes — re-arm after an idle-stop (task 784)', () => {
  it('a USER stop (no idleStoppedAt) is left untouched', async () => {
    await internal(scheduler).processIdleThemes([
      makeState({ enabled: false, themeId: 7, idleStoppedAt: null }),
    ]);
    expect(mockTaskCount).not.toHaveBeenCalled();
    expect(mockStartAutoRun).not.toHaveBeenCalled();
    expect(mockShouldRefillBacklogNow).not.toHaveBeenCalled();
  });

  it('re-arms (startAutoRun) when a manually-filed task appears after a timer stop', async () => {
    mockTaskCount.mockResolvedValue(1);

    await internal(scheduler).processIdleThemes([
      makeState({ enabled: false, themeId: 7, idleStoppedAt: minutesAgo(5) }),
    ]);

    expect(mockStartAutoRun).toHaveBeenCalledWith(7);
    expect(mockTaskCount).toHaveBeenCalledWith({
      where: {
        themeId: 7,
        status: 'todo',
        parentId: null,
        workflowDisabled: false,
        OR: [{ workflowStatus: null }, { workflowStatus: { not: 'awaiting_question' } }],
        autoCreatedFromBacklog: false,
      },
    });
  });

  it('self-refills IN PLACE while stopped without re-arming (learning loop kept separate)', async () => {
    mockTaskCount.mockResolvedValue(0);
    mockShouldRefillBacklogNow.mockResolvedValue(true);
    mockPromoteBacklogForTheme.mockResolvedValue(1);

    await internal(scheduler).processIdleThemes([
      makeState({ enabled: false, themeId: 7, idleStoppedAt: minutesAgo(5) }),
    ]);

    expect(mockPromoteBacklogForTheme).toHaveBeenCalledWith(7);
    expect(mockMarkSelfRefillSucceeded).toHaveBeenCalledWith(7, expect.any(Date));
    expect(mockLogCycleEvent).toHaveBeenCalledWith(
      'backlog.refill_while_stopped',
      expect.objectContaining({ theme: 7, created: 1 }),
    );
    expect(mockStartAutoRun).not.toHaveBeenCalled();
  });

  it('does nothing when the window is closed and nothing was manually filed', async () => {
    mockTaskCount.mockResolvedValue(0);
    mockShouldRefillBacklogNow.mockResolvedValue(false);

    await internal(scheduler).processIdleThemes([
      makeState({ enabled: false, themeId: 7, idleStoppedAt: minutesAgo(5) }),
    ]);

    expect(mockPromoteBacklogForTheme).not.toHaveBeenCalled();
    expect(mockStartAutoRun).not.toHaveBeenCalled();
  });
});

describe('processPausedThemes', () => {
  it('skips a paused theme with no currentTaskId', async () => {
    await internal(scheduler).processPausedThemes([
      makeState({ status: 'paused', currentTaskId: null }),
    ]);
    expect(mockGetThemeActiveQueueItems).not.toHaveBeenCalled();
  });

  it('leaves the theme paused while a queue item is still waiting_approval', async () => {
    mockGetThemeActiveQueueItems.mockResolvedValue([
      { id: 1, taskId: 5, status: 'waiting_approval' },
    ]);

    await internal(scheduler).processPausedThemes([
      makeState({ status: 'paused', currentTaskId: 5, themeId: 9 }),
    ]);

    expect(mockQueueItemFindFirst).not.toHaveBeenCalled();
    expect(mockResumeAutoRun).not.toHaveBeenCalled();
  });

  it('does not resume when the item is gone AND no queued re-entry exists', async () => {
    mockGetThemeActiveQueueItems.mockResolvedValue([]);
    mockQueueItemFindFirst.mockResolvedValue(null);

    await internal(scheduler).processPausedThemes([
      makeState({ status: 'paused', currentTaskId: 5, themeId: 9 }),
    ]);

    expect(mockResumeAutoRun).not.toHaveBeenCalled();
  });

  it('auto-resumes once the plan was approved (item re-queued)', async () => {
    mockGetThemeActiveQueueItems.mockResolvedValue([]);
    mockQueueItemFindFirst.mockResolvedValue({ id: 1, status: 'queued', errorMessage: null });

    await internal(scheduler).processPausedThemes([
      makeState({ status: 'paused', currentTaskId: 5, themeId: 9 }),
    ]);

    expect(mockResumeAutoRun).toHaveBeenCalledWith(9);
    expect(mockBroadcast).toHaveBeenCalled();
  });

  it('swallows an error from getThemeActiveQueueItems without throwing', async () => {
    mockGetThemeActiveQueueItems.mockImplementation(() => Promise.reject(new Error('db down')));

    await expect(
      internal(scheduler).processPausedThemes([makeState({ status: 'paused', currentTaskId: 5 })]),
    ).resolves.toBeUndefined();
  });
});

describe('stopThemeExecution', () => {
  it('always cancels active queue items for the theme', async () => {
    await internal(scheduler).stopThemeExecution(10, null);
    expect(mockQueueItemUpdateMany).toHaveBeenCalledWith({
      where: { themeId: 10, status: { in: ['queued', 'running', 'waiting_approval'] } },
      data: {
        status: 'cancelled',
        completedAt: expect.any(Date),
        errorMessage: 'Auto-run stopped',
      },
    });
  });

  it('does nothing further when there is no current task', async () => {
    await internal(scheduler).stopThemeExecution(10, null);
    expect(mockResolveTaskWorkingDirectory).not.toHaveBeenCalled();
    expect(mockStopThemeAgents).not.toHaveBeenCalled();
  });

  it('kills theme agents, reverts a resolved working directory, and resets the task to todo', async () => {
    mockResolveTaskWorkingDirectory.mockResolvedValue({
      themeId: 10,
      workingDirectory: '/repo/work',
      theme: null,
    });

    await internal(scheduler).stopThemeExecution(10, 100);

    expect(mockStopThemeAgents).toHaveBeenCalledWith(10, 100, { errorMessage: 'Auto-run stopped' });
    expect(mockRevertChanges).toHaveBeenCalledWith('/repo/work');
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { status: 'todo' },
      select: { workflowStatus: true },
    });
  });

  it('records an auto_run_stop_revert transition so Pattern B grants it recovery grace (task 830)', async () => {
    mockResolveTaskWorkingDirectory.mockResolvedValue({
      themeId: 10,
      workingDirectory: '/repo/work',
      theme: null,
    });
    mockTaskUpdate.mockResolvedValue({ workflowStatus: 'plan_approved' });

    await internal(scheduler).stopThemeExecution(10, 100);

    expect(mockRecordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 100,
        fromStatus: 'plan_approved',
        toStatus: 'plan_approved',
        actor: 'system',
        cause: 'auto_run_stop_revert',
      }),
    );
  });

  it('does not record a transition when the task update itself fails', async () => {
    mockResolveTaskWorkingDirectory.mockResolvedValue({
      themeId: 10,
      workingDirectory: '/repo/work',
      theme: null,
    });
    mockTaskUpdate.mockImplementation(() => Promise.reject(new Error('db down')));

    await internal(scheduler).stopThemeExecution(10, 100);

    expect(mockRecordTransition).not.toHaveBeenCalled();
  });

  it('falls back to the theme working directory when the task has none of its own', async () => {
    mockResolveTaskWorkingDirectory.mockResolvedValue({
      themeId: 10,
      workingDirectory: null,
      theme: { workingDirectory: '/repo/theme-dir' },
    });

    await internal(scheduler).stopThemeExecution(10, 100);

    expect(mockRevertChanges).toHaveBeenCalledWith('/repo/theme-dir');
  });

  it('skips revertChanges entirely when no working directory can be resolved', async () => {
    mockResolveTaskWorkingDirectory.mockResolvedValue({
      themeId: 10,
      workingDirectory: null,
      theme: null,
    });

    await internal(scheduler).stopThemeExecution(10, 100);

    expect(mockRevertChanges).not.toHaveBeenCalled();
    // The task must still be reset even without a working directory to revert.
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { status: 'todo' },
      select: { workflowStatus: true },
    });
  });

  it('swallows an unexpected resolveTaskWorkingDirectory throw without propagating', async () => {
    mockResolveTaskWorkingDirectory.mockImplementation(() => Promise.reject(new Error('boom')));

    await expect(internal(scheduler).stopThemeExecution(10, 100)).resolves.toBeUndefined();
  });
});

describe('broadcastAutoRunUpdate', () => {
  it('broadcasts on the orchestra channel', () => {
    internal(scheduler).broadcastAutoRunUpdate(55);
    expect(mockBroadcast).toHaveBeenCalledWith(
      'orchestra',
      'auto_run_update',
      expect.objectContaining({ themeId: 55 }),
    );
  });

  it('never throws even when the realtime service itself throws (SSE unavailable)', () => {
    mockBroadcast.mockImplementationOnce(() => {
      throw new Error('SSE down');
    });
    expect(() => internal(scheduler).broadcastAutoRunUpdate(55)).not.toThrow();
  });
});
