/**
 * self-incident-watcher.test
 *
 * Orchestrator tests over a mocked prisma + submitConcern + notification
 * helper: detections file dedup-keyed concerns, stale unanswered intake
 * questions re-notify (never file concerns), clean tasks file nothing, one
 * task's failure never stops the scan, and the 5-minute throttle skips
 * back-to-back passes.
 * NOTE: `lastRunMs` is module state — every test advances `nowMs` past the
 * interval instead of resetting the module, so ordering stays irrelevant.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const taskFindManyMock = mock((_args: unknown) => Promise.resolve([] as unknown[]));
const taskFindUniqueMock = mock((_args: unknown) => Promise.resolve<unknown>(null));
const transitionFindManyMock = mock((_args: unknown) => Promise.resolve([] as unknown[]));
const transitionFindFirstMock = mock((_args: unknown) => Promise.resolve<unknown>(null));
const sessionFindFirstMock = mock(() => Promise.resolve<unknown>(null));
const executionFindFirstMock = mock((_args: unknown) => Promise.resolve<unknown>(null));
const queueItemFindFirstMock = mock((_args: unknown) => Promise.resolve<unknown>(null));
const notificationFindFirstMock = mock((_args: unknown) => Promise.resolve<unknown>(null));
const prFindFirstMock = mock((_args: unknown) => Promise.resolve<unknown>(null));
const activityLogFindFirstMock = mock((_args: unknown) => Promise.resolve<unknown>(null));
const workflowFileFindFirstMock = mock((_args: unknown) => Promise.resolve<unknown>(null));
const themeAutoRunFindManyMock = mock((_args: unknown) => Promise.resolve([] as unknown[]));
// #860: theme.findMany feeds resolveNonDevelopmentThemeIds — default [] means
// no candidate theme is treated as non-development (fail-open).
const themeFindManyMock = mock((_args: unknown) => Promise.resolve([] as unknown[]));
// Task 837: resolveMaxRepairs() reads UserSettings.verifyRepairLimit once per
// pass; default null → DEFAULT_VERIFY_REPAIR_LIMIT fallback (existing tests
// below never override this, so their repairBounceMinCount stays at the
// pre-task-837 default of REPEAT_LOOP_MIN_COUNT).
const userSettingsFindFirstMock = mock(() => Promise.resolve<unknown>(null));
const submitConcernMock = mock((_input: unknown) => Promise.resolve(1));
const notifyIntakeQuestionPendingMock = mock((_input: unknown) =>
  Promise.resolve<unknown>({ id: 1 }),
);

mock.module('../../config/logger', () => ({
  getBackendLogFilePath: () => '/tmp/backend.log',
  logger: noopLogger,
  createLogger: () => noopLogger,
}));
// Full mirror of every prisma model the watcher + BOTH evidence gatherers
// touch — a missing model would sync-throw inside gatherSupervisorEvidence.
mock.module('../../config/database', () => ({
  prisma: {
    task: { findMany: taskFindManyMock, findUnique: taskFindUniqueMock },
    workflowTransition: { findMany: transitionFindManyMock, findFirst: transitionFindFirstMock },
    agentSession: { findFirst: sessionFindFirstMock },
    agentExecution: { findFirst: executionFindFirstMock },
    workflowQueueItem: { findFirst: queueItemFindFirstMock },
    notification: { findFirst: notificationFindFirstMock },
    gitHubPullRequest: { findFirst: prFindFirstMock },
    activityLog: { findFirst: activityLogFindFirstMock },
    workflowFile: { findFirst: workflowFileFindFirstMock },
    themeAutoRun: { findMany: themeAutoRunFindManyMock },
    theme: { findMany: themeFindManyMock },
    userSettings: { findFirst: userSettingsFindFirstMock },
  },
  ensureDatabaseConnection: () => Promise.resolve(),
}));
mock.module('../memory/concern-backlog-service', () => ({
  submitConcern: submitConcernMock,
}));
mock.module('../communication/notification-service', () => ({
  notifyIntakeQuestionPending: notifyIntakeQuestionPendingMock,
}));

const { runSelfIncidentWatch, shouldRunIncidentWatch, WATCH_INTERVAL_MS } =
  await import('./self-incident-watcher');

// Monotonic clock: each test starts a fresh pass safely past the throttle.
let clockMs = Date.parse('2026-08-11T00:00:00.000Z');
function nextPassTime(): number {
  clockMs += WATCH_INTERVAL_MS * 2;
  return clockMs;
}

function stagnantTask(now: number, over: Record<string, unknown> = {}) {
  return {
    id: 546,
    title: '停滞するタスク',
    status: 'in-progress',
    workflowStatus: 'in_progress',
    updatedAt: new Date(now - 40 * 60 * 1000),
    // #860: a development theme by default — existing scenarios stay
    // detected unless the test explicitly puts themeId in an exclusion set.
    themeId: 1,
    workflowDisabled: false,
    ...over,
  };
}

describe('shouldRunIncidentWatch', () => {
  test('false below the interval, true at and above it (>= boundary)', () => {
    const last = 1_000_000;
    expect(shouldRunIncidentWatch(last, last + WATCH_INTERVAL_MS - 1)).toBe(false);
    expect(shouldRunIncidentWatch(last, last + WATCH_INTERVAL_MS)).toBe(true);
    expect(shouldRunIncidentWatch(last, last + WATCH_INTERVAL_MS + 1)).toBe(true);
  });

  test('honors a custom interval override', () => {
    expect(shouldRunIncidentWatch(0, 999, 1_000)).toBe(false);
    expect(shouldRunIncidentWatch(0, 1_000, 1_000)).toBe(true);
  });
});

describe('runSelfIncidentWatch', () => {
  beforeEach(() => {
    taskFindManyMock.mockReset().mockResolvedValue([]);
    taskFindUniqueMock.mockReset().mockResolvedValue(null);
    transitionFindManyMock.mockReset().mockResolvedValue([]);
    transitionFindFirstMock.mockReset().mockResolvedValue(null);
    sessionFindFirstMock.mockReset().mockResolvedValue(null);
    executionFindFirstMock.mockReset().mockResolvedValue(null);
    queueItemFindFirstMock.mockReset().mockResolvedValue(null);
    notificationFindFirstMock.mockReset().mockResolvedValue(null);
    prFindFirstMock.mockReset().mockResolvedValue(null);
    activityLogFindFirstMock.mockReset().mockResolvedValue(null);
    workflowFileFindFirstMock.mockReset().mockResolvedValue(null);
    themeAutoRunFindManyMock.mockReset().mockResolvedValue([]);
    themeFindManyMock.mockReset().mockResolvedValue([]);
    userSettingsFindFirstMock.mockReset().mockResolvedValue(null);
    submitConcernMock.mockReset().mockResolvedValue(1);
    notifyIntakeQuestionPendingMock.mockReset().mockResolvedValue({ id: 1 });
  });

  test('files a stagnation concern with dedupKey / source / originTaskId', async () => {
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([stagnantTask(now)]);

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(1);
    expect(submitConcernMock).toHaveBeenCalledTimes(1);
    const input = submitConcernMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.dedupKey).toBe('self-incident:stagnation');
    expect(input.source).toBe('self_incident_watch');
    expect(input.originTaskId).toBe(546);
    expect(input.type).toBe('bug');
    expect(input.severity).toBe('medium');
    // #801: recurrence aggregation opts in with the task-varying instance
    // value, keeping the signature itself (dedupKey, asserted above) stable.
    expect(input.recurrencePolicy).toEqual({
      enabled: true,
      instanceValue: 'taskId:546',
      detectedAt: now,
    });
    expect(String(input.detail)).toContain('## 直近の遷移タイムライン(最大10件)');
    expect(String(input.detail)).toContain('## 検出条件');
  });

  // #860: task #811 (themeId=28, isDevelopment=false) stayed stagnant for
  // 490m because nothing could ever dispatch it — these four scenarios cover
  // each way isWorkflowManaged resolves to false, plus the fail-open path.
  test('does NOT file a stagnation concern for a workflowDisabled task', async () => {
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([stagnantTask(now, { workflowDisabled: true })]);

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(0);
    expect(submitConcernMock).not.toHaveBeenCalled();
  });

  test('does NOT file a stagnation concern when the workflow is disabled globally', async () => {
    const now = nextPassTime();
    userSettingsFindFirstMock.mockResolvedValue({ workflowDisabledGlobally: true });
    taskFindManyMock.mockResolvedValue([stagnantTask(now)]);

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(0);
    expect(submitConcernMock).not.toHaveBeenCalled();
  });

  test('does NOT file a stagnation concern for a task in a non-development theme', async () => {
    const now = nextPassTime();
    themeFindManyMock.mockResolvedValue([{ id: 1 }]);
    taskFindManyMock.mockResolvedValue([stagnantTask(now, { themeId: 1 })]);

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(0);
    expect(submitConcernMock).not.toHaveBeenCalled();
  });

  test('still files a stagnation concern when theme lookup fails (fail-open)', async () => {
    const now = nextPassTime();
    themeFindManyMock.mockImplementation(() => Promise.reject(new Error('db down')));
    taskFindManyMock.mockResolvedValue([stagnantTask(now, { themeId: 1 })]);

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(1);
    expect(submitConcernMock).toHaveBeenCalledTimes(1);
  });

  test('two tasks with the same signature share one dedupKey', async () => {
    // 実測 2026-08-27: dedupKey にタスクIDを含めていたため、4種類の欠陥が
    // 41件の懸念になり、それぞれが別のタスクに昇格していた。「#646 が33分停滞」
    // と「#624 が31分停滞」は同じ欠陥を2回見ただけで、直し方は同じ。
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, { id: 700 }),
      stagnantTask(now, { id: 701 }),
    ]);

    await runSelfIncidentWatch(now);

    const keys = submitConcernMock.mock.calls.map(
      (c) => (c[0] as Record<string, unknown>).dedupKey,
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('self-incident:stagnation');
  });

  test('the title names the defect, not one task', async () => {
    // タイトルがそのまま昇格タスクの題になる。特定タスクを名指しすると、
    // 集約された懸念の題が最初の1件に固定されて誤解を招く。
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([stagnantTask(now, { id: 700 })]);

    await runSelfIncidentWatch(now);

    const title = String((submitConcernMock.mock.calls[0]?.[0] as Record<string, unknown>).title);
    expect(title).not.toContain('#700');
    expect(title).toContain('停滞');
  });

  test('files a tri-state desync concern for todo × advanced workflow', async () => {
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, {
        id: 541,
        status: 'todo',
        workflowStatus: 'plan_created',
        updatedAt: new Date(now - 60_000), // fresh → stagnation must NOT fire
      }),
    ]);

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(1);
    const input = submitConcernMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.dedupKey).toBe('self-incident:tristate-desync:todo-workflow-advanced');
    expect(input.severity).toBe('high');
  });

  // #636 repro: requeueOrphanTasks reset #632 to todo × plan_approved on
  // purpose; 59s later the watcher filed that heal as a high-severity desync.
  // The newest timeline transition's cause must suppress Pattern B in-grace.
  test('does NOT file a desync concern right after a reconciler_requeue recovery (#636 repro)', async () => {
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, {
        id: 632,
        status: 'todo',
        workflowStatus: 'plan_approved',
        updatedAt: new Date(now - 60_000),
      }),
    ]);
    // Timeline query (no createdAt filter) → newest-first rows; windowed → [].
    transitionFindManyMock.mockImplementation((args: unknown) => {
      const where = (args as { where: { createdAt?: unknown } }).where;
      if (where.createdAt) return Promise.resolve([]);
      return Promise.resolve([
        {
          fromStatus: 'plan_approved',
          toStatus: 'plan_approved',
          actor: 'system',
          cause: 'reconciler_requeue',
          phase: null,
          createdAt: new Date(now - 59_000),
        },
      ]);
    });

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(0);
    expect(submitConcernMock).not.toHaveBeenCalled();
  });

  test('still files a desync concern when the newest transition is not a recovery cause', async () => {
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, {
        id: 633,
        status: 'todo',
        workflowStatus: 'plan_approved',
        updatedAt: new Date(now - 60_000),
      }),
    ]);
    transitionFindManyMock.mockImplementation((args: unknown) => {
      const where = (args as { where: { createdAt?: unknown } }).where;
      if (where.createdAt) return Promise.resolve([]);
      return Promise.resolve([
        {
          fromStatus: 'verify_done',
          toStatus: 'plan_approved',
          actor: 'system',
          cause: 'verify_repair',
          phase: 'verify',
          createdAt: new Date(now - 59_000),
        },
      ]);
    });

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(1);
    const input = submitConcernMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.dedupKey).toBe('self-incident:tristate-desync:todo-workflow-advanced');
  });

  // Past the grace window the shape is no longer a settling heal: BOTH the
  // re-armed Pattern B and the stagnation backstop fire (double net by design).
  test('files desync + stagnation once a recovery transition settled past the grace window', async () => {
    const now = nextPassTime();
    const settledMs = now - 31 * 60 * 1000;
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, {
        id: 634,
        status: 'todo',
        workflowStatus: 'plan_approved',
        updatedAt: new Date(settledMs),
      }),
    ]);
    transitionFindManyMock.mockImplementation((args: unknown) => {
      const where = (args as { where: { createdAt?: unknown } }).where;
      if (where.createdAt) return Promise.resolve([]);
      return Promise.resolve([
        {
          fromStatus: 'plan_approved',
          toStatus: 'plan_approved',
          actor: 'system',
          cause: 'reconciler_requeue',
          phase: null,
          createdAt: new Date(settledMs),
        },
      ]);
    });

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(2);
    const keys = submitConcernMock.mock.calls.map(
      (c) => (c[0] as Record<string, unknown>).dedupKey,
    );
    expect(keys).toContain('self-incident:tristate-desync:todo-workflow-advanced');
    expect(keys).toContain('self-incident:stagnation');
  });

  // #875: unlike other RECOVERY_REQUEUE_CAUSES, a deliberate withdraw
  // (stop-execution({withdraw:true})) must stay permanently excluded past the
  // grace window — neither Pattern B nor the stagnation backstop may re-fire.
  test('does NOT file desync or stagnation once withdrawn past the grace window (#875)', async () => {
    const now = nextPassTime();
    const settledMs = now - 31 * 60 * 1000;
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, {
        id: 867,
        status: 'todo',
        workflowStatus: 'in_progress',
        updatedAt: new Date(settledMs),
      }),
    ]);
    transitionFindManyMock.mockImplementation((args: unknown) => {
      const where = (args as { where: { createdAt?: unknown } }).where;
      if (where.createdAt) return Promise.resolve([]);
      return Promise.resolve([
        {
          fromStatus: 'in_progress',
          toStatus: 'in_progress',
          actor: 'user',
          cause: 'manual_execution_stop_withdraw',
          phase: null,
          createdAt: new Date(settledMs),
        },
      ]);
    });

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(0);
    expect(submitConcernMock).not.toHaveBeenCalled();
  });

  // Regression: an ordinary (non-withdraw) manual stop must keep re-arming
  // past the grace window exactly as before #875.
  test('still files stagnation + desync past the grace window for a plain manual_execution_stop_revert', async () => {
    const now = nextPassTime();
    const settledMs = now - 31 * 60 * 1000;
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, {
        id: 868,
        status: 'todo',
        workflowStatus: 'in_progress',
        updatedAt: new Date(settledMs),
      }),
    ]);
    transitionFindManyMock.mockImplementation((args: unknown) => {
      const where = (args as { where: { createdAt?: unknown } }).where;
      if (where.createdAt) return Promise.resolve([]);
      return Promise.resolve([
        {
          fromStatus: 'in_progress',
          toStatus: 'in_progress',
          actor: 'user',
          cause: 'manual_execution_stop_revert',
          phase: null,
          createdAt: new Date(settledMs),
        },
      ]);
    });

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(2);
    const keys = submitConcernMock.mock.calls.map(
      (c) => (c[0] as Record<string, unknown>).dedupKey,
    );
    expect(keys).toContain('self-incident:tristate-desync:todo-workflow-advanced');
    expect(keys).toContain('self-incident:stagnation');
  });

  test('files a repeat-loop concern keyed by the looping cause', async () => {
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, { id: 99, updatedAt: new Date(now - 60_000) }),
    ]);
    // Timeline query (no createdAt filter) → []; windowed query → 3× ci_repair.
    transitionFindManyMock.mockImplementation((args: unknown) => {
      const where = (args as { where: { createdAt?: unknown } }).where;
      if (!where.createdAt) return Promise.resolve([]);
      return Promise.resolve([
        { cause: 'ci_repair', createdAt: new Date(now - 5 * 60 * 1000), actor: 'system' },
        { cause: 'ci_repair', createdAt: new Date(now - 10 * 60 * 1000), actor: 'system' },
        { cause: 'ci_repair', createdAt: new Date(now - 15 * 60 * 1000), actor: 'system' },
      ]);
    });

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(1);
    const input = submitConcernMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.dedupKey).toBe('self-incident:repeat-loop:ci_repair');
    expect(String(input.title)).toContain('反復ループ');
  });

  // Task 835: `verify_repair` fires once per repair round, so a task that
  // spends a UI-configured budget of 3 in full produced exactly the 3 firings
  // the static threshold reported as a loop. The watcher now resolves
  // UserSettings.verifyRepairLimit once per pass and raises the threshold to
  // limit + 1, so a fully-spent budget is no longer filed as an incident.
  test('verify_repair×3 は verifyRepairLimit=3 のとき反復ループとして起票しないこと', async () => {
    const now = nextPassTime();
    userSettingsFindFirstMock.mockResolvedValue({ verifyRepairLimit: 3 });
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, { id: 833, updatedAt: new Date(now - 60_000) }),
    ]);
    transitionFindManyMock.mockImplementation((args: unknown) => {
      const where = (args as { where: { createdAt?: unknown } }).where;
      if (!where.createdAt) return Promise.resolve([]);
      return Promise.resolve([
        { cause: 'verify_repair', createdAt: new Date(now - 5 * 60 * 1000), actor: 'system' },
        { cause: 'verify_repair', createdAt: new Date(now - 10 * 60 * 1000), actor: 'system' },
        { cause: 'verify_repair', createdAt: new Date(now - 15 * 60 * 1000), actor: 'system' },
      ]);
    });

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(0);
    expect(submitConcernMock).not.toHaveBeenCalled();
  });

  // Same window, default budget (2): the 3rd bounce IS an overrun, so the
  // signature must still fire — the fix narrows detection, never removes it.
  test('同じ窓でも既定予算(2)なら予算超過として起票すること', async () => {
    const now = nextPassTime();
    userSettingsFindFirstMock.mockResolvedValue(null);
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, { id: 833, updatedAt: new Date(now - 60_000) }),
    ]);
    transitionFindManyMock.mockImplementation((args: unknown) => {
      const where = (args as { where: { createdAt?: unknown } }).where;
      if (!where.createdAt) return Promise.resolve([]);
      return Promise.resolve([
        { cause: 'verify_repair', createdAt: new Date(now - 5 * 60 * 1000), actor: 'system' },
        { cause: 'verify_repair', createdAt: new Date(now - 10 * 60 * 1000), actor: 'system' },
        { cause: 'verify_repair', createdAt: new Date(now - 15 * 60 * 1000), actor: 'system' },
      ]);
    });

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(1);
    const input = submitConcernMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.dedupKey).toBe('self-incident:repeat-loop:verify_repair');
    // The filed concern must quote the threshold that fired (task 710), which
    // for verify_repair is the budget-derived one: default budget 2 → 3.
    expect(String(input.detail)).toContain('3回以上');
  });

  // The settings lookup must never break the pass: detection-only by design.
  test('UserSettings 取得が失敗しても既定予算にフォールバックし例外を投げないこと', async () => {
    const now = nextPassTime();
    userSettingsFindFirstMock.mockImplementation(() => Promise.reject(new Error('db down')));
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, { id: 833, updatedAt: new Date(now - 60_000) }),
    ]);
    transitionFindManyMock.mockImplementation((args: unknown) => {
      const where = (args as { where: { createdAt?: unknown } }).where;
      if (!where.createdAt) return Promise.resolve([]);
      return Promise.resolve([
        { cause: 'verify_repair', createdAt: new Date(now - 5 * 60 * 1000), actor: 'system' },
        { cause: 'verify_repair', createdAt: new Date(now - 10 * 60 * 1000), actor: 'system' },
        { cause: 'verify_repair', createdAt: new Date(now - 15 * 60 * 1000), actor: 'system' },
      ]);
    });

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(1);
  });

  // Task 710: invariantViolation-flagged transitions use a lower threshold
  // (INVARIANT_REPEAT_LOOP_MIN_COUNT=2) than the general path
  // (REPEAT_LOOP_MIN_COUNT=3) — the notification text must reflect the
  // threshold that actually fired, not always the general one.
  test('invariant経路で検出した場合、閾値表示に INVARIANT_REPEAT_LOOP_MIN_COUNT(2) を反映すること', async () => {
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, { id: 674, updatedAt: new Date(now - 60_000) }),
    ]);
    transitionFindManyMock.mockImplementation((args: unknown) => {
      const where = (args as { where: { createdAt?: unknown } }).where;
      if (!where.createdAt) return Promise.resolve([]);
      return Promise.resolve([
        {
          cause: 'adversarial_review_failed',
          createdAt: new Date(now - 5 * 60 * 1000),
          actor: 'system',
          invariantViolation: true,
        },
        {
          cause: 'adversarial_review_failed',
          createdAt: new Date(now - 10 * 60 * 1000),
          actor: 'system',
          invariantViolation: true,
        },
      ]);
    });

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(1);
    const input = submitConcernMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.dedupKey).toBe('self-incident:repeat-loop:adversarial_review_failed');
    expect(String(input.detail)).toContain('2回以上');
    expect(String(input.detail)).not.toContain('3回以上');
  });

  // Task 837 (task #833 repro): a task whose UserSettings.verifyRepairLimit is
  // raised to 3 legitimately produces exactly 3 verify_repair bounces — this
  // must NOT be misreported as a repeat loop.
  test('does not file a repeat-loop concern when verify_repair count matches a raised verifyRepairLimit (task 833 repro)', async () => {
    const now = nextPassTime();
    userSettingsFindFirstMock.mockResolvedValue({ verifyRepairLimit: 3 });
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, { id: 833, updatedAt: new Date(now - 60_000) }),
    ]);
    transitionFindManyMock.mockImplementation((args: unknown) => {
      const where = (args as { where: { createdAt?: unknown } }).where;
      if (!where.createdAt) return Promise.resolve([]);
      return Promise.resolve([
        { cause: 'verify_repair', createdAt: new Date(now - 5 * 60 * 1000), actor: 'system' },
        { cause: 'verify_repair', createdAt: new Date(now - 10 * 60 * 1000), actor: 'system' },
        { cause: 'verify_repair', createdAt: new Date(now - 15 * 60 * 1000), actor: 'system' },
      ]);
    });

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(0);
    expect(submitConcernMock).not.toHaveBeenCalled();
  });

  // Same raised budget (3), but a 4th verify_repair exceeds it — a genuine
  // anomaly beyond the configured budget must still be detected.
  test('files a repeat-loop concern when verify_repair count exceeds a raised verifyRepairLimit', async () => {
    const now = nextPassTime();
    userSettingsFindFirstMock.mockResolvedValue({ verifyRepairLimit: 3 });
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, { id: 834, updatedAt: new Date(now - 60_000) }),
    ]);
    transitionFindManyMock.mockImplementation((args: unknown) => {
      const where = (args as { where: { createdAt?: unknown } }).where;
      if (!where.createdAt) return Promise.resolve([]);
      return Promise.resolve([
        { cause: 'verify_repair', createdAt: new Date(now - 4 * 60 * 1000), actor: 'system' },
        { cause: 'verify_repair', createdAt: new Date(now - 8 * 60 * 1000), actor: 'system' },
        { cause: 'verify_repair', createdAt: new Date(now - 12 * 60 * 1000), actor: 'system' },
        { cause: 'verify_repair', createdAt: new Date(now - 16 * 60 * 1000), actor: 'system' },
      ]);
    });

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(1);
    const input = submitConcernMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.dedupKey).toBe('self-incident:repeat-loop:verify_repair');
  });

  // resolveMaxRepairs() and resolveWorkflowDisabledGlobally() (#860) must each
  // be resolved once per pass, not once per candidate task, to avoid N DB
  // round-trips per watch pass (task 837). Both read UserSettings, so the
  // per-pass total is 2 regardless of candidate count.
  test('resolves UserSettings exactly twice per pass regardless of candidate count', async () => {
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, { id: 1, updatedAt: new Date(now - 60_000) }),
      stagnantTask(now, { id: 2, updatedAt: new Date(now - 60_000) }),
      stagnantTask(now, { id: 3, updatedAt: new Date(now - 60_000) }),
    ]);

    await runSelfIncidentWatch(now);

    expect(userSettingsFindFirstMock.mock.calls.length).toBe(2);
  });

  // 受入(a): a never-started todo backlog item files nothing however stale it is.
  test('a stale never-started todo task (draft workflow, no history) files nothing', async () => {
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, {
        id: 553,
        status: 'todo',
        workflowStatus: 'draft',
        updatedAt: new Date(now - 34 * 60 * 1000),
      }),
    ]);

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(0);
    expect(submitConcernMock).not.toHaveBeenCalled();
  });

  // 受入(b): operator manual recovery (actor=user) is not a repeat loop.
  test('a repeat made solely of actor=user manual transitions files nothing', async () => {
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, { id: 551, updatedAt: new Date(now - 60_000) }), // fresh → no stagnation
    ]);
    transitionFindManyMock.mockImplementation((args: unknown) => {
      const where = (args as { where: { createdAt?: unknown } }).where;
      if (!where.createdAt) return Promise.resolve([]);
      return Promise.resolve([
        { cause: 'manual_status_change', createdAt: new Date(now - 5 * 60 * 1000), actor: 'user' },
        { cause: 'manual_status_change', createdAt: new Date(now - 10 * 60 * 1000), actor: 'user' },
        { cause: 'manual_status_change', createdAt: new Date(now - 15 * 60 * 1000), actor: 'user' },
      ]);
    });

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(0);
    expect(submitConcernMock).not.toHaveBeenCalled();
  });

  test('a clean task files nothing', async () => {
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, { updatedAt: new Date(now - 60_000) }), // fresh, consistent
    ]);

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(0);
    expect(submitConcernMock).not.toHaveBeenCalled();
  });

  test('a stagnant task with a live execution files nothing', async () => {
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([stagnantTask(now)]);
    executionFindFirstMock.mockResolvedValue({ id: 1 });

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(0);
    expect(submitConcernMock).not.toHaveBeenCalled();
  });

  test('one task submitConcern failure does not stop the remaining tasks', async () => {
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, { id: 101 }),
      stagnantTask(now, { id: 102 }),
    ]);
    submitConcernMock.mockRejectedValueOnce(new Error('backlog down')).mockResolvedValueOnce(2);

    const filed = await runSelfIncidentWatch(now);

    // Task 101's filing failed (counted 0) but task 102 still filed.
    expect(filed).toBe(1);
    expect(submitConcernMock).toHaveBeenCalledTimes(2);
    const second = submitConcernMock.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(second.dedupKey).toBe('self-incident:stagnation');
  });

  test('a second call inside the throttle interval is skipped entirely', async () => {
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([stagnantTask(now)]);

    const first = await runSelfIncidentWatch(now);
    const second = await runSelfIncidentWatch(now + 1_000);

    expect(first).toBe(1);
    expect(second).toBe(0);
    // The throttled call never queried nor filed (2 queries per pass: main
    // candidates + the dedicated awaiting_question scan).
    expect(taskFindManyMock).toHaveBeenCalledTimes(2);
    expect(submitConcernMock).toHaveBeenCalledTimes(1);
  });

  // 受入基準3: the supervisor cwd-mismatch signature files a concern whose
  // detail carries the same evidence a human supervisor read (both paths + line).
  test('files a supervisor cwd-mismatch concern with path evidence in the detail', async () => {
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, { id: 580, updatedAt: new Date(now - 60_000) }), // fresh → no stagnation
    ]);
    taskFindUniqueMock.mockResolvedValue({
      theme: { workingDirectory: 'C:\\Projects\\ime-live-converter' },
    });
    // gatherTaskState probes executions with select:{id}; the supervisor
    // gatherer asks for select:{output} — dispatch on the requested field.
    executionFindFirstMock.mockImplementation((args: unknown) => {
      const select = (args as { select?: { output?: boolean } }).select;
      if (select?.output) {
        return Promise.resolve({
          output: '[Claude Code] Working directory: C:\\Projects\\rapitas\\rapitas-backend\n…',
        });
      }
      return Promise.resolve(null);
    });

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(1);
    const input = submitConcernMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.dedupKey).toBe('self-incident:supervisor-cwd-mismatch');
    expect(input.severity).toBe('high');
    const detail = String(input.detail);
    expect(detail).toContain('## 検出証拠');
    expect(detail).toContain('実行cwd: C:\\Projects\\rapitas\\rapitas-backend');
    expect(detail).toContain('テーマ作業ディレクトリ: C:\\Projects\\ime-live-converter');
    expect(detail).toContain(
      '該当行: [Claude Code] Working directory: C:\\Projects\\rapitas\\rapitas-backend',
    );
  });

  // 受入基準3: the false-failure signature carries the gap seconds + artifact ref.
  test('files a supervisor false-failure concern with the 57s gap in the detail', async () => {
    const now = nextPassTime();
    taskFindManyMock.mockResolvedValue([
      stagnantTask(now, { id: 581, updatedAt: new Date(now - 60_000) }),
    ]);
    // Serves BOTH the active-queue probe (treated as active → no stagnation)
    // and the supervisor failure-mark lookup (completedAt of the failed item).
    queueItemFindFirstMock.mockResolvedValue({
      id: 7,
      completedAt: new Date(now - 120_000),
      status: 'failed',
    });
    prFindFirstMock.mockResolvedValue({
      createdAt: new Date(now - 120_000 + 57_000),
      prNumber: 7,
      url: 'https://github.com/takamurayuki/ime-live-converter/pull/7',
    });

    const filed = await runSelfIncidentWatch(now);

    expect(filed).toBe(1);
    const input = submitConcernMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.dedupKey).toBe('self-incident:supervisor-false-failure');
    const detail = String(input.detail);
    expect(detail).toContain('## 検出証拠');
    expect(detail).toContain('時刻差: 57秒');
    expect(detail).toContain('PR #7 (https://github.com/takamurayuki/ime-live-converter/pull/7)');
  });

  test('the kill switch disables the supervisor pass without touching its queries', async () => {
    process.env.RAPITAS_SUPERVISOR_INCIDENT_DISABLED = '1';
    try {
      const now = nextPassTime();
      taskFindManyMock.mockResolvedValue([
        stagnantTask(now, { id: 582, updatedAt: new Date(now - 60_000) }),
      ]);
      taskFindUniqueMock.mockResolvedValue({
        theme: { workingDirectory: 'C:\\Projects\\ime-live-converter' },
      });

      const filed = await runSelfIncidentWatch(now);

      expect(filed).toBe(0);
      expect(submitConcernMock).not.toHaveBeenCalled();
      expect(taskFindUniqueMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.RAPITAS_SUPERVISOR_INCIDENT_DISABLED;
    }
  });

  test('scans oldest-first within the 24h lookback with the defensive cap', async () => {
    const now = nextPassTime();
    await runSelfIncidentWatch(now);

    const query = taskFindManyMock.mock.calls[0]?.[0] as {
      where: { parentId: null; updatedAt: { gte: Date } };
      orderBy: { updatedAt: string };
      take: number;
    };
    expect(query.where.parentId).toBeNull();
    expect(now - query.where.updatedAt.gte.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(query.orderBy).toEqual({ updatedAt: 'asc' });
    expect(query.take).toBe(200);
  });
});

describe('runSelfIncidentWatch — awaiting_question re-notification', () => {
  // #578/#579 shape: question raised, then 4 days of silence — updatedAt froze
  // at the raise, so the task is far outside the main 24h candidate lookback.
  const STALE_MS = 4 * 24 * 60 * 60 * 1000;

  function awaitingTask(over: Record<string, unknown> = {}) {
    return {
      id: 578,
      title: '質問待ちのタスク',
      status: 'awaiting_question',
      workflowStatus: 'awaiting_question',
      updatedAt: new Date(0), // frozen long ago — irrelevant to the wait clock
      ...over,
    };
  }

  /** Routes the two task queries: main lookback vs the dedicated awaiting scan. */
  function mockTaskQueues(main: unknown[], awaiting: unknown[]) {
    taskFindManyMock.mockImplementation((args: unknown) => {
      const where = (args as { where: { workflowStatus?: string } }).where;
      return Promise.resolve(where.workflowStatus === 'awaiting_question' ? awaiting : main);
    });
  }

  /** Routes the two transition lookups: raise time vs the answered guard. */
  function mockTransitions(raisedAtMs: number | null, answered: boolean) {
    transitionFindFirstMock.mockImplementation((args: unknown) => {
      const where = (args as { where: { toStatus?: string; cause?: string } }).where;
      if (where.toStatus === 'awaiting_question') {
        return Promise.resolve(raisedAtMs === null ? null : { createdAt: new Date(raisedAtMs) });
      }
      if (where.cause === 'intake_question_answered') {
        return Promise.resolve(answered ? { id: 7 } : null);
      }
      return Promise.resolve(null);
    });
  }

  beforeEach(() => {
    // Shared mocks are reset by the outer describe's pattern — repeat here
    // because bun runs each describe's beforeEach independently.
    taskFindManyMock.mockReset().mockResolvedValue([]);
    transitionFindManyMock.mockReset().mockResolvedValue([]);
    transitionFindFirstMock.mockReset().mockResolvedValue(null);
    sessionFindFirstMock.mockReset().mockResolvedValue(null);
    executionFindFirstMock.mockReset().mockResolvedValue(null);
    queueItemFindFirstMock.mockReset().mockResolvedValue(null);
    themeAutoRunFindManyMock.mockReset().mockResolvedValue([]);
    submitConcernMock.mockReset().mockResolvedValue(1);
    notifyIntakeQuestionPendingMock.mockReset().mockResolvedValue({ id: 1 });
  });

  // 受入基準3(発火例): the #578/#579 shape must be caught by the dedicated scan.
  test('re-notifies a 4-day stale unanswered question via notification, never a concern', async () => {
    const now = nextPassTime();
    mockTaskQueues([], [awaitingTask()]);
    mockTransitions(now - STALE_MS, false);

    const surfaced = await runSelfIncidentWatch(now);

    expect(surfaced).toBe(1);
    expect(notifyIntakeQuestionPendingMock).toHaveBeenCalledTimes(1);
    expect(notifyIntakeQuestionPendingMock).toHaveBeenCalledWith({
      taskId: 578,
      taskTitle: '質問待ちのタスク',
      nowMs: now,
    });
    // Re-notification must NOT go through the concern pipeline (task 587 shape).
    expect(submitConcernMock).not.toHaveBeenCalled();
  });

  test('uses a dedicated no-lookback query filtered to awaiting_question', async () => {
    const now = nextPassTime();
    await runSelfIncidentWatch(now);

    const query = taskFindManyMock.mock.calls[1]?.[0] as {
      where: { parentId: null; workflowStatus: string; updatedAt?: unknown };
      orderBy: { updatedAt: string };
      take: number;
    };
    expect(query.where.workflowStatus).toBe('awaiting_question');
    // No lookback — a frozen updatedAt must never age the task out of scope.
    expect(query.where.updatedAt).toBeUndefined();
    expect(query.where.parentId).toBeNull();
    expect(query.take).toBe(200);
  });

  // 受入基準4: an answered task must never re-notify.
  test('does NOT re-notify when an intake_question_answered transition exists', async () => {
    const now = nextPassTime();
    mockTaskQueues([], [awaitingTask()]);
    mockTransitions(now - STALE_MS, true);

    const surfaced = await runSelfIncidentWatch(now);

    expect(surfaced).toBe(0);
    expect(notifyIntakeQuestionPendingMock).not.toHaveBeenCalled();
  });

  // 受入基準3(非発火正常例): a same-day question is a legitimate wait.
  test('does NOT re-notify a question raised below the threshold', async () => {
    const now = nextPassTime();
    mockTaskQueues([], [awaitingTask()]);
    mockTransitions(now - 60 * 60 * 1000, false); // 1h ago

    const surfaced = await runSelfIncidentWatch(now);

    expect(surfaced).toBe(0);
    expect(notifyIntakeQuestionPendingMock).not.toHaveBeenCalled();
  });

  test('does NOT re-notify when no awaiting_question transition is on record', async () => {
    const now = nextPassTime();
    mockTaskQueues([], [awaitingTask()]);
    mockTransitions(null, false);

    const surfaced = await runSelfIncidentWatch(now);

    expect(surfaced).toBe(0);
    expect(notifyIntakeQuestionPendingMock).not.toHaveBeenCalled();
  });

  test('counts a dedup-suppressed re-notification (helper returns null) as zero', async () => {
    const now = nextPassTime();
    mockTaskQueues([], [awaitingTask()]);
    mockTransitions(now - STALE_MS, false);
    notifyIntakeQuestionPendingMock.mockResolvedValue(null); // inside dedup window

    const surfaced = await runSelfIncidentWatch(now);

    expect(surfaced).toBe(0);
    expect(notifyIntakeQuestionPendingMock).toHaveBeenCalledTimes(1);
  });

  test('one task notification failure does not stop the remaining awaiting tasks', async () => {
    const now = nextPassTime();
    mockTaskQueues([], [awaitingTask(), awaitingTask({ id: 579, title: 'もう一つの質問待ち' })]);
    mockTransitions(now - STALE_MS, false);
    notifyIntakeQuestionPendingMock
      .mockRejectedValueOnce(new Error('notification down'))
      .mockResolvedValueOnce({ id: 2 });

    const surfaced = await runSelfIncidentWatch(now);

    expect(surfaced).toBe(1);
    expect(notifyIntakeQuestionPendingMock).toHaveBeenCalledTimes(2);
  });

  test('concern findings and question re-notifications sum in the return value', async () => {
    const now = nextPassTime();
    mockTaskQueues(
      [
        {
          id: 546,
          title: '停滞するタスク',
          status: 'in-progress',
          workflowStatus: 'in_progress',
          updatedAt: new Date(now - 40 * 60 * 1000),
        },
      ],
      [awaitingTask()],
    );
    mockTransitions(now - STALE_MS, false);

    const surfaced = await runSelfIncidentWatch(now);

    expect(surfaced).toBe(2);
    expect(submitConcernMock).toHaveBeenCalledTimes(1);
    expect(notifyIntakeQuestionPendingMock).toHaveBeenCalledTimes(1);
  });
});
