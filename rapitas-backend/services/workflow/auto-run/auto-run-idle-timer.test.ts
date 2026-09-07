/**
 * auto-run-idle-timer.test
 *
 * Covers the pure predicates (isIdleTimerActivelyCounting, isIdleTimerExpired,
 * isWithinSelfRefillWindow, hasRefilledToday, normalize*) plus the impure
 * decision/mutation functions (getIdleStopMinutes, getSelfRefillWindowStart,
 * shouldRefillBacklogNow, countHumanOriginTodo, attemptCriticalConcernBypass,
 * stopThemeForIdleTimeout, markSelfRefillSucceeded) with a mocked prisma.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const mockUserSettingsFindFirst = mock(() =>
  Promise.resolve<{ idleStopMinutes?: unknown; selfRefillWindowStart?: unknown } | null>(null),
);
const mockThemeAutoRunFindUnique = mock(() =>
  Promise.resolve<{
    enabled: boolean;
    status: string;
    idleSince: Date | null;
    lastSelfRefillAt: Date | null;
  } | null>(null),
);
const mockThemeAutoRunUpdate = mock(() => Promise.resolve({}));
const mockThemeAutoRunUpdateMany = mock(() => Promise.resolve({ count: 1 }));
const mockTaskCount = mock(() => Promise.resolve(0));

mock.module('../../../config/database', () => ({
  prisma: {
    userSettings: { findFirst: mockUserSettingsFindFirst },
    themeAutoRun: {
      findUnique: mockThemeAutoRunFindUnique,
      update: mockThemeAutoRunUpdate,
      updateMany: mockThemeAutoRunUpdateMany,
    },
    task: { count: mockTaskCount },
  },
}));

const noopLog = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
};
mock.module('../../../config/logger', () => ({ createLogger: () => noopLog }));

const mockLogCycleEvent = mock(() => {});
mock.module('../../observability', () => ({ logCycleEvent: mockLogCycleEvent }));

const mockListConcerns = mock(() =>
  Promise.resolve({ concerns: [] as Array<{ id: number; severity: string; title?: string }> }),
);
mock.module('../../memory/concern-backlog-service', () => ({ listConcerns: mockListConcerns }));

let outstandingCount = 0;
let limit = 3;
const mockCountOutstandingAutoCreated = mock(() => Promise.resolve(outstandingCount));
const mockResolveLimit = mock(() => Promise.resolve(limit));
mock.module('./backlog-promoter-eligibility', () => ({
  countOutstandingAutoCreated: mockCountOutstandingAutoCreated,
  resolveLimit: mockResolveLimit,
}));

const mockPromoteConcern = mock(() => Promise.resolve(true));
mock.module('./backlog-promoter-execute', () => ({ promoteConcern: mockPromoteConcern }));

const mockNotifyIdleStopped = mock(() => Promise.resolve());
mock.module('./auto-run-notifications-terminal', () => ({
  notifyIdleStopped: mockNotifyIdleStopped,
}));

const {
  DEFAULT_IDLE_STOP_MINUTES,
  DEFAULT_SELF_REFILL_WINDOW_START,
  MAX_IDLE_STOP_MINUTES,
  IDLE_BYPASS_CONCERN_SEVERITIES,
  normalizeIdleStopMinutes,
  normalizeSelfRefillWindowStart,
  getIdleStopMinutes,
  getSelfRefillWindowStart,
  isIdleTimerActivelyCounting,
  isIdleTimerExpired,
  isWithinSelfRefillWindow,
  hasRefilledToday,
  shouldRefillBacklogNow,
  countHumanOriginTodo,
  attemptCriticalConcernBypass,
  stopThemeForIdleTimeout,
  markSelfRefillSucceeded,
} = await import('./auto-run-idle-timer');

/** Local-time constructor so tests are independent of the host timezone. */
const local = (h: number, m: number, day = 30) => new Date(2026, 7, day, h, m, 0, 0);

beforeEach(() => {
  mockUserSettingsFindFirst.mockReset().mockResolvedValue(null);
  mockThemeAutoRunFindUnique.mockReset().mockResolvedValue(null);
  mockThemeAutoRunUpdate.mockReset().mockResolvedValue({});
  mockThemeAutoRunUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  mockTaskCount.mockReset().mockResolvedValue(0);
  mockLogCycleEvent.mockClear();
  mockListConcerns.mockReset().mockResolvedValue({ concerns: [] });
  outstandingCount = 0;
  limit = 3;
  mockCountOutstandingAutoCreated.mockClear();
  mockResolveLimit.mockClear();
  mockPromoteConcern.mockReset().mockResolvedValue(true);
  mockNotifyIdleStopped.mockReset().mockResolvedValue(undefined);
});

describe('normalizeIdleStopMinutes / normalizeSelfRefillWindowStart', () => {
  test('non-numeric / absent idleStopMinutes falls back to the default', () => {
    expect(normalizeIdleStopMinutes(undefined)).toBe(DEFAULT_IDLE_STOP_MINUTES);
    expect(normalizeIdleStopMinutes('60')).toBe(DEFAULT_IDLE_STOP_MINUTES);
    expect(normalizeIdleStopMinutes(Number.NaN)).toBe(DEFAULT_IDLE_STOP_MINUTES);
  });

  test('0 disables, negatives clamp to 0, large values clamp to the 24h ceiling, floats floor', () => {
    expect(normalizeIdleStopMinutes(0)).toBe(0);
    expect(normalizeIdleStopMinutes(-5)).toBe(0);
    expect(normalizeIdleStopMinutes(99_999)).toBe(MAX_IDLE_STOP_MINUTES);
    expect(normalizeIdleStopMinutes(45.9)).toBe(45);
  });

  test("selfRefillWindowStart: '' stays '', valid HH:MM kept, malformed/absent falls back", () => {
    expect(normalizeSelfRefillWindowStart('')).toBe('');
    expect(normalizeSelfRefillWindowStart('04:30')).toBe('04:30');
    expect(normalizeSelfRefillWindowStart('24:00')).toBe(DEFAULT_SELF_REFILL_WINDOW_START);
    expect(normalizeSelfRefillWindowStart(undefined)).toBe(DEFAULT_SELF_REFILL_WINDOW_START);
  });
});

describe('getIdleStopMinutes / getSelfRefillWindowStart', () => {
  test('read and normalise from UserSettings; a lookup failure yields the defaults', async () => {
    mockUserSettingsFindFirst.mockResolvedValue({
      idleStopMinutes: 90,
      selfRefillWindowStart: '04:00',
    });
    expect(await getIdleStopMinutes()).toBe(90);
    expect(await getSelfRefillWindowStart()).toBe('04:00');

    mockUserSettingsFindFirst.mockRejectedValue(new Error('db down'));
    expect(await getIdleStopMinutes()).toBe(DEFAULT_IDLE_STOP_MINUTES);
    expect(await getSelfRefillWindowStart()).toBe(DEFAULT_SELF_REFILL_WINDOW_START);
  });
});

describe('isIdleTimerActivelyCounting', () => {
  const now = local(12, 0);

  test('disabled timer (0) never counts', () => {
    expect(
      isIdleTimerActivelyCounting(
        { enabled: true, status: 'idle', idleSince: local(11, 0) },
        0,
        now,
      ),
    ).toBe(false);
  });

  test('not enabled, not idle, or no idleSince → not counting', () => {
    expect(
      isIdleTimerActivelyCounting(
        { enabled: false, status: 'idle', idleSince: local(11, 0) },
        60,
        now,
      ),
    ).toBe(false);
    expect(
      isIdleTimerActivelyCounting(
        { enabled: true, status: 'running', idleSince: local(11, 0) },
        60,
        now,
      ),
    ).toBe(false);
    expect(
      isIdleTimerActivelyCounting({ enabled: true, status: 'idle', idleSince: null }, 60, now),
    ).toBe(false);
  });

  test('counts down while elapsed < threshold, stops counting at/after the threshold', () => {
    expect(
      isIdleTimerActivelyCounting(
        { enabled: true, status: 'idle', idleSince: local(11, 1) },
        60,
        now,
      ),
    ).toBe(true);
    expect(
      isIdleTimerActivelyCounting(
        { enabled: true, status: 'idle', idleSince: local(11, 0) },
        60,
        now,
      ),
    ).toBe(false);
  });
});

describe('isIdleTimerExpired', () => {
  const now = local(12, 0);

  test('disabled (0) or no idleSince never expires', () => {
    expect(isIdleTimerExpired(local(10, 0), 0, now)).toBe(false);
    expect(isIdleTimerExpired(null, 60, now)).toBe(false);
  });

  test('expires exactly at the threshold, not before', () => {
    expect(isIdleTimerExpired(local(11, 1), 60, now)).toBe(false);
    expect(isIdleTimerExpired(local(11, 0), 60, now)).toBe(true);
  });

  test('mirrors isIdleTimerActivelyCounting: exactly one of the two is true whenever armed+idleSince set', () => {
    for (const idleSince of [local(11, 1), local(11, 0), local(10, 30)]) {
      const state = { enabled: true, status: 'idle', idleSince };
      const counting = isIdleTimerActivelyCounting(state, 60, now);
      const expired = isIdleTimerExpired(idleSince, 60, now);
      expect(counting).toBe(!expired);
    }
  });
});

describe('isWithinSelfRefillWindow', () => {
  test("'' or malformed window is always closed", () => {
    expect(isWithinSelfRefillWindow(local(4, 0), '')).toBe(false);
    expect(isWithinSelfRefillWindow(local(4, 0), '25:00')).toBe(false);
  });

  test('open at/after the local opening time, closed before it', () => {
    expect(isWithinSelfRefillWindow(local(3, 0), '03:00')).toBe(true);
    expect(isWithinSelfRefillWindow(local(4, 0), '03:00')).toBe(true);
    expect(isWithinSelfRefillWindow(local(2, 59), '03:00')).toBe(false);
  });
});

describe('hasRefilledToday', () => {
  test('null → not refilled today', () => {
    expect(hasRefilledToday(null, local(4, 0))).toBe(false);
  });

  test('same local day → true; a different day → false', () => {
    expect(hasRefilledToday(local(3, 5), local(23, 0))).toBe(true);
    expect(hasRefilledToday(local(23, 55, 29), local(0, 5, 30))).toBe(false);
  });
});

describe('shouldRefillBacklogNow', () => {
  test('false while the idle timer is actively counting (design point 2)', async () => {
    mockUserSettingsFindFirst.mockResolvedValue({
      idleStopMinutes: 60,
      selfRefillWindowStart: '03:00',
    });
    mockThemeAutoRunFindUnique.mockResolvedValue({
      enabled: true,
      status: 'idle',
      idleSince: local(11, 30),
      lastSelfRefillAt: null,
    });
    expect(await shouldRefillBacklogNow(1, local(12, 0))).toBe(false);
  });

  test('false outside the self-refill window', async () => {
    mockUserSettingsFindFirst.mockResolvedValue({
      idleStopMinutes: 0,
      selfRefillWindowStart: '03:00',
    });
    mockThemeAutoRunFindUnique.mockResolvedValue(null);
    expect(await shouldRefillBacklogNow(1, local(2, 0))).toBe(false);
  });

  test('false when already refilled today', async () => {
    mockUserSettingsFindFirst.mockResolvedValue({
      idleStopMinutes: 0,
      selfRefillWindowStart: '03:00',
    });
    mockThemeAutoRunFindUnique.mockResolvedValue({
      enabled: false,
      status: 'idle',
      idleSince: null,
      lastSelfRefillAt: local(3, 5),
    });
    expect(await shouldRefillBacklogNow(1, local(15, 0))).toBe(false);
  });

  test('true when the timer is not actively counting, the window is open, and not yet refilled today', async () => {
    mockUserSettingsFindFirst.mockResolvedValue({
      idleStopMinutes: 0,
      selfRefillWindowStart: '03:00',
    });
    mockThemeAutoRunFindUnique.mockResolvedValue(null);
    expect(await shouldRefillBacklogNow(1, local(4, 0))).toBe(true);
  });

  test('a missing ThemeAutoRun row (never idled) does not block the window check', async () => {
    mockUserSettingsFindFirst.mockResolvedValue({
      idleStopMinutes: 60,
      selfRefillWindowStart: '03:00',
    });
    mockThemeAutoRunFindUnique.mockResolvedValue(null);
    expect(await shouldRefillBacklogNow(1, local(4, 0))).toBe(true);
  });
});

describe('countHumanOriginTodo', () => {
  test('counts top-level, non-backlog-promoted todo tasks; a DB error yields 0', async () => {
    mockTaskCount.mockResolvedValue(2);
    expect(await countHumanOriginTodo(7)).toBe(2);
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

    mockTaskCount.mockRejectedValue(new Error('db down'));
    expect(await countHumanOriginTodo(7)).toBe(0);
  });
});

describe('attemptCriticalConcernBypass', () => {
  test('false when the cap is disabled or already full', async () => {
    limit = 0;
    expect(await attemptCriticalConcernBypass(1)).toBe(false);
    expect(mockListConcerns).not.toHaveBeenCalled();

    limit = 2;
    outstandingCount = 2;
    expect(await attemptCriticalConcernBypass(1)).toBe(false);
  });

  test('promotes the first available urgent/high concern, urgent probed first', async () => {
    limit = 2;
    outstandingCount = 0;
    mockListConcerns.mockImplementation((opts: { severity?: string }) =>
      opts?.severity === 'urgent'
        ? Promise.resolve({ concerns: [{ id: 1, severity: 'urgent' }] })
        : Promise.resolve({ concerns: [] }),
    );

    expect(await attemptCriticalConcernBypass(1)).toBe(true);
    expect(mockPromoteConcern).toHaveBeenCalledWith(1, { id: 1, severity: 'urgent' });
  });

  test('false when neither severity has an open concern', async () => {
    mockListConcerns.mockResolvedValue({ concerns: [] });
    expect(await attemptCriticalConcernBypass(1)).toBe(false);
    expect(mockPromoteConcern).not.toHaveBeenCalled();
  });

  test('bypass severities are exactly urgent and high', () => {
    expect([...IDLE_BYPASS_CONCERN_SEVERITIES].sort()).toEqual(['high', 'urgent']);
  });
});

describe('stopThemeForIdleTimeout', () => {
  test('sets enabled=false + idleStoppedAt, logs the cycle event, and notifies', async () => {
    await stopThemeForIdleTimeout(7);

    expect(mockThemeAutoRunUpdate).toHaveBeenCalledWith({
      where: { themeId: 7 },
      data: { enabled: false, idleStoppedAt: expect.any(Date) },
    });
    expect(mockLogCycleEvent).toHaveBeenCalledWith(
      'auto_run.idle_stopped',
      expect.objectContaining({ theme: 7 }),
    );
    expect(mockNotifyIdleStopped).toHaveBeenCalledWith(7);
  });

  test('a failed update write skips the notification (no false "stopped" signal)', async () => {
    mockThemeAutoRunUpdate.mockRejectedValue(new Error('db down'));

    await stopThemeForIdleTimeout(7);

    expect(mockNotifyIdleStopped).not.toHaveBeenCalled();
  });
});

describe('markSelfRefillSucceeded', () => {
  test('stamps lastSelfRefillAt; a write failure is swallowed', async () => {
    await markSelfRefillSucceeded(7, local(4, 0));
    expect(mockThemeAutoRunUpdateMany).toHaveBeenCalledWith({
      where: { themeId: 7 },
      data: { lastSelfRefillAt: local(4, 0) },
    });

    mockThemeAutoRunUpdateMany.mockRejectedValue(new Error('db down'));
    await expect(markSelfRefillSucceeded(7, local(4, 0))).resolves.toBeUndefined();
  });
});
