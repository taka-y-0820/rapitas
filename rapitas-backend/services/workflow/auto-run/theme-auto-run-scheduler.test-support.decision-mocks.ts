/**
 * theme-auto-run-scheduler.test-support.decision-mocks
 *
 * bun:test mock.module() definitions for theme-auto-run-scheduler's own
 * decision-layer collaborators: auto-run-selection, open-pr-files-cache,
 * merge-barrier, theme-auto-run-service, auto-run-notifications,
 * resource-telemetry / resource-contention-gate, auto-run-stall-guard, and
 * blocked-task-escalation. Split out of theme-auto-run-scheduler.test-support.ts
 * (task 765) to stay under the file-size ratchet; the barrel file re-exports
 * everything below so existing *.test.ts imports are unaffected.
 *
 * Not responsible for the scheduler's data/infrastructure collaborators
 * (prisma, task-resolver, workflow-queue/runner, realtime-service, etc.) —
 * see theme-auto-run-scheduler.test-support.collaborator-mocks.ts.
 */
import { mock } from 'bun:test';
import type { ThemeAutoRunState } from './theme-auto-run-service';

// ---------------------------------------------------------------------------
// auto-run-selection (pure helper module) — fully replaced with controllable
// mocks so the scheduler's OWN decisions are what's under test, not selection.
// ---------------------------------------------------------------------------
export const mockGetGlobalAutoRunActiveCount = mock(() => Promise.resolve(0));
export const mockGetThemeActiveQueueItems = mock(() =>
  Promise.resolve([] as Array<{ id: number; taskId: number; status: string }>),
);
export const mockIsAwaitingUserAnswer = mock(() => Promise.resolve(false));
// Liveness check for the hang backstop — default false so existing backstop
// tests (tenure exceeded → force-stop) keep exercising the kill path.
export const mockHasLiveExecution = mock(() => Promise.resolve(false));
// 進捗時刻: 既定は「進捗なし」(=0) にして、既存のバックストップ発火テストを維持する。
export const mockResolveLastProgressAt = mock(() => Promise.resolve(0));
export const mockSelectNextTask = mock(() =>
  Promise.resolve({ found: false, reason: 'all_done' } as
    | { found: true; taskId: number }
    | { found: false; reason: 'all_done' | 'concurrency_limit' | 'awaiting_approval' }),
);

/** Test-tunable constants — kept small so cooldown/hang-backstop tests run fast. */
export const TEST_AUTO_RUN_GLOBAL_MAX_CONCURRENCY = 1;
export const TEST_POLL_INTERVAL_MS = 12_000;
export const TEST_COOLDOWN_MS = 5;
export const TEST_MAX_TASK_WALL_MS = 1_000;

mock.module('./auto-run-selection', () => ({
  AUTO_RUN_GLOBAL_MAX_CONCURRENCY: TEST_AUTO_RUN_GLOBAL_MAX_CONCURRENCY,
  POLL_INTERVAL_MS: TEST_POLL_INTERVAL_MS,
  COOLDOWN_MS: TEST_COOLDOWN_MS,
  MAX_TASK_WALL_MS: TEST_MAX_TASK_WALL_MS,
  priorityRank: (p: string | null | undefined) => (p ? 0 : 2),
  isTaskBlocked: (status: string) => status === 'blocked',
  getGlobalAutoRunActiveCount: mockGetGlobalAutoRunActiveCount,
  getThemeActiveQueueItems: mockGetThemeActiveQueueItems,
  isAwaitingUserAnswer: mockIsAwaitingUserAnswer,
  hasLiveExecution: mockHasLiveExecution,
  resolveLastProgressAt: mockResolveLastProgressAt,
  HANG_BACKSTOP_HEARTBEAT_MS: 5 * 60_000,
  selectNextTask: mockSelectNextTask,
  // R6 learnable-band signal — null means "no data", i.e. the legacy ordering.
  recentThemeSuccessRate: mock(() => Promise.resolve(null)),
  valueBandScore: () => 0,
  // Real (trivial) logic — no test needs to override "is any item waiting_approval".
  hasItemAwaitingApproval: (items: Array<{ status: string }>) =>
    items.some((i) => i.status === 'waiting_approval'),
  // Scope-overlap helpers (task 573 B) — bun mock.module must mirror EVERY
  // export. Defaults are "no overlap" so legacy scheduler tests are unaffected.
  hasScopeOverlap: () => false,
  overlappingFiles: () => [] as string[],
}));

// ---------------------------------------------------------------------------
// open-pr-files-cache (task 573 B) — no open auto-PRs by default so the
// scheduler's selection path stays on its legacy behavior in existing tests.
// ---------------------------------------------------------------------------
export const mockGetOpenAutoPrsForTheme = mock(() =>
  Promise.resolve([] as Array<{ prNumber: number; linkedTaskId: number | null }>),
);
export const mockGetPrChangedFiles = mock(() => Promise.resolve([] as string[]));

mock.module('./open-pr-files-cache', () => ({
  PR_FILES_CACHE_TTL_MS: 60_000,
  clearPrFilesCache: () => {},
  getOpenAutoPrsForTheme: mockGetOpenAutoPrsForTheme,
  getPrChangedFiles: mockGetPrChangedFiles,
}));

// ---------------------------------------------------------------------------
// merge-barrier (task 573 C) — default OFF; barrier decision mirrors the real
// pure logic so a test can flip the toggle mock and exercise the hold path.
// ---------------------------------------------------------------------------
export const mockReadMergeBarrierEnabled = mock(() => false);

mock.module('../../scheduling/merge-barrier/merge-barrier', () => ({
  MERGE_BARRIER_DEFAULT_MAX_HOLD_MS: 30 * 60 * 1000,
  getMergeBarrierMaxHoldMs: () => 30 * 60 * 1000,
  readMergeBarrierEnabled: mockReadMergeBarrierEnabled,
  writeMergeBarrierEnabled: mock(() => {}),
  shouldHoldForBarrier: (
    enabled: boolean,
    openPrExists: boolean,
    holdSinceMs: number | null,
    nowMs: number,
    maxHoldMs: number,
  ) => {
    if (!enabled || !openPrExists) return false;
    if (holdSinceMs === null) return true;
    return nowMs - holdSinceMs < maxHoldMs;
  },
}));

// ---------------------------------------------------------------------------
// theme-auto-run-service — fully replaced; the scheduler's calls into it are
// what several tests assert on directly (e.g. onTaskCompleted, setCurrentTask).
// ---------------------------------------------------------------------------
export const mockFindByStatuses = mock(() => Promise.resolve([] as ThemeAutoRunState[]));
export const mockSetCurrentTask = mock(() => Promise.resolve());
export const mockOnTaskCompleted = mock(() => Promise.resolve());
export const mockOnTaskFailed = mock(() => Promise.resolve());
export const mockOnAwaitingPlanApproval = mock(() => Promise.resolve());
export const mockResumeAutoRun = mock(() => Promise.resolve(null as ThemeAutoRunState | null));
export const mockFinalizeStop = mock(() => Promise.resolve());
export const mockGetAutoRunState = mock(() => Promise.resolve(null as ThemeAutoRunState | null));
export const mockStartAutoRun = mock(() => Promise.resolve({} as ThemeAutoRunState));

const PAUSED_AUTO_RUN_STATUSES_TEST = ['paused', 'paused_user', 'paused_approval'];

mock.module('./theme-auto-run-service', () => ({
  AUTO_RUN_STATUSES: ['idle', 'running', 'paused', 'paused_user', 'paused_approval', 'stopping'],
  PAUSED_AUTO_RUN_STATUSES: PAUSED_AUTO_RUN_STATUSES_TEST,
  narrowAutoRunStatus: (s: string | null | undefined) => s ?? 'idle',
  isPausedAutoRunStatus: (status: string) => PAUSED_AUTO_RUN_STATUSES_TEST.includes(status),
  isAutoResumablePauseStatus: (status: string) => status === 'paused_approval',
  toPauseReason: (status: string) =>
    status === 'paused_user'
      ? 'user'
      : status === 'paused_approval'
        ? 'awaiting_approval'
        : status === 'paused'
          ? 'unknown'
          : null,
  toPublicAutoRunState: (state: ThemeAutoRunState) => {
    const reason =
      state.status === 'paused_user'
        ? 'user'
        : state.status === 'paused_approval'
          ? 'awaiting_approval'
          : state.status === 'paused'
            ? 'unknown'
            : null;
    return { ...state, status: reason !== null ? 'paused' : state.status, pauseReason: reason };
  },
  isAutoRunHandlingTask: () => false,
  getOrCreateAutoRun: mock(() => Promise.resolve({})),
  getAutoRunState: mockGetAutoRunState,
  startAutoRun: mockStartAutoRun,
  pauseAutoRun: mock(() => Promise.resolve({})),
  resumeAutoRun: mockResumeAutoRun,
  stopAutoRun: mock(() => Promise.resolve({})),
  finalizeStop: mockFinalizeStop,
  setCurrentTask: mockSetCurrentTask,
  onTaskCompleted: mockOnTaskCompleted,
  onTaskFailed: mockOnTaskFailed,
  onAwaitingPlanApproval: mockOnAwaitingPlanApproval,
  isThemeAutoRunActive: mock(() => Promise.resolve(false)),
  findByStatuses: mockFindByStatuses,
}));

// ---------------------------------------------------------------------------
// auto-run-idle-timer (task 784) — fully replaced. Pure predicates keep their
// real logic (small, deterministic, no I/O) so scheduler tests exercise
// genuine countdown/window arithmetic; the impure (DB-touching) functions are
// controllable mocks.
// ---------------------------------------------------------------------------
export const mockGetIdleStopMinutes = mock(() => Promise.resolve(60));
export const mockGetSelfRefillWindowStart = mock(() => Promise.resolve('03:00'));
export const mockCountHumanOriginTodo = mock(() => Promise.resolve(0));
export const mockAttemptCriticalConcernBypass = mock(() => Promise.resolve(false));
export const mockStopThemeForIdleTimeout = mock(() => Promise.resolve());
export const mockShouldRefillBacklogNow = mock(() => Promise.resolve(false));
export const mockMarkSelfRefillSucceeded = mock(() => Promise.resolve());

const WINDOW_START_RE_TEST = /^([01]\d|2[0-3]):([0-5]\d)$/;

mock.module('./auto-run-idle-timer', () => ({
  DEFAULT_IDLE_STOP_MINUTES: 60,
  MAX_IDLE_STOP_MINUTES: 24 * 60,
  DEFAULT_SELF_REFILL_WINDOW_START: '03:00',
  IDLE_BYPASS_CONCERN_SEVERITIES: new Set(['urgent', 'high']),
  normalizeIdleStopMinutes: (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1440, Math.floor(v))) : 60,
  normalizeSelfRefillWindowStart: (v: unknown) =>
    typeof v === 'string' && (v === '' || WINDOW_START_RE_TEST.test(v)) ? v : '03:00',
  getIdleStopMinutes: mockGetIdleStopMinutes,
  getSelfRefillWindowStart: mockGetSelfRefillWindowStart,
  isIdleTimerActivelyCounting: (
    state: { enabled: boolean; status: string; idleSince: Date | string | null },
    idleStopMinutes: number,
    now: Date,
  ) => {
    if (idleStopMinutes <= 0) return false;
    if (!state.enabled || state.status !== 'idle' || !state.idleSince) return false;
    const since = typeof state.idleSince === 'string' ? new Date(state.idleSince) : state.idleSince;
    if (Number.isNaN(since.getTime())) return false;
    return now.getTime() - since.getTime() < idleStopMinutes * 60_000;
  },
  isIdleTimerExpired: (
    idleSince: Date | string | null | undefined,
    idleStopMinutes: number,
    now: Date,
  ) => {
    if (idleStopMinutes <= 0 || !idleSince) return false;
    const since = typeof idleSince === 'string' ? new Date(idleSince) : idleSince;
    if (Number.isNaN(since.getTime())) return false;
    return now.getTime() - since.getTime() >= idleStopMinutes * 60_000;
  },
  isWithinSelfRefillWindow: (now: Date, windowStart: string) => {
    const m = WINDOW_START_RE_TEST.exec(windowStart);
    if (!m) return false;
    const openToday = new Date(now.getTime());
    openToday.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return now.getTime() >= openToday.getTime();
  },
  hasRefilledToday: (lastSelfRefillAt: Date | string | null, now: Date) => {
    if (!lastSelfRefillAt) return false;
    const last =
      typeof lastSelfRefillAt === 'string' ? new Date(lastSelfRefillAt) : lastSelfRefillAt;
    if (Number.isNaN(last.getTime())) return false;
    return (
      last.getFullYear() === now.getFullYear() &&
      last.getMonth() === now.getMonth() &&
      last.getDate() === now.getDate()
    );
  },
  shouldRefillBacklogNow: mockShouldRefillBacklogNow,
  countHumanOriginTodo: mockCountHumanOriginTodo,
  attemptCriticalConcernBypass: mockAttemptCriticalConcernBypass,
  stopThemeForIdleTimeout: mockStopThemeForIdleTimeout,
  markSelfRefillSucceeded: mockMarkSelfRefillSucceeded,
}));

// ---------------------------------------------------------------------------
// auto-run-notifications
// ---------------------------------------------------------------------------
export const mockNotifyAwaitingPlanApproval = mock(() => Promise.resolve());
export const mockNotifyAwaitingUserAnswer = mock(() => Promise.resolve());
export const mockNotifyTaskSkipped = mock(() => Promise.resolve());
export const mockNotifyAllDone = mock(() => Promise.resolve());
export const mockNotifyAllBlocked = mock(() => Promise.resolve());
export const mockNotifyHangBackstop = mock(() => Promise.resolve());
export const mockNotifyTaskVanished = mock(() => Promise.resolve());
export const mockNotifyResourceContentionHold = mock(() => Promise.resolve());
export const mockNotifyIdleStopped = mock(() => Promise.resolve());

mock.module('./auto-run-notifications', () => ({
  notifyIdleStopped: mockNotifyIdleStopped,
  notifyAwaitingPlanApproval: mockNotifyAwaitingPlanApproval,
  notifyAwaitingUserAnswer: mockNotifyAwaitingUserAnswer,
  notifyTaskSkipped: mockNotifyTaskSkipped,
  notifyAllDone: mockNotifyAllDone,
  notifyAllBlocked: mockNotifyAllBlocked,
  notifyHangBackstop: mockNotifyHangBackstop,
  notifyTaskVanished: mockNotifyTaskVanished,
  notifyResourceContentionHold: mockNotifyResourceContentionHold,
}));

// ---------------------------------------------------------------------------
// resource-telemetry / resource-contention-gate (task 725) — default to the
// gate's own OFF state so every pre-existing scheduler test is unaffected
// regardless of RAPITAS_RESOURCE_GATE_ENABLED. Dedicated resource-gate tests
// override these mocks to exercise the hold path.
// ---------------------------------------------------------------------------
export const mockGetHostCpuBusyPercent = mock(() => null as number | null);

mock.module('../../system/resource-telemetry', () => ({
  startResourceTelemetryIfEnabled: () => {},
  stopResourceTelemetry: () => {},
  getHostCpuBusyPercent: mockGetHostCpuBusyPercent,
  computeBusyPercent: () => null,
}));

export const mockEvaluateResourceGate = mock(() => ({
  hold: false,
  cpuBusyPercent: null as number | null,
  thresholdPercent: 85,
  effectiveMaxConcurrency: 1,
}));
export const mockConsumeResourceGateOverride = mock(() => false);
export const mockRequestResourceGateOverride = mock(() => {});

mock.module('./resource-contention-gate', () => ({
  evaluateResourceGate: mockEvaluateResourceGate,
  requestResourceGateOverride: mockRequestResourceGateOverride,
  consumeResourceGateOverride: mockConsumeResourceGateOverride,
}));

// ---------------------------------------------------------------------------
// auto-run-stall-guard (terminal-task residue release — task 618). Default 0 =
// "nothing released" so every legacy wait-branch test keeps its old behavior.
// ---------------------------------------------------------------------------
export const mockReleaseStaleActiveItems = mock(() => Promise.resolve(0));

mock.module('./auto-run-stall-guard', () => ({
  releaseStaleActiveItems: mockReleaseStaleActiveItems,
}));

// ---------------------------------------------------------------------------
// blocked-task-escalation (all_blocked reporting — task 615)
// ---------------------------------------------------------------------------
export const mockCountEscalatedBlocked = mock(() => Promise.resolve(0));

mock.module('../blocked-task-escalation', () => ({
  escalateBlockedTask: mock(() => Promise.resolve(false)),
  countEscalatedBlocked: mockCountEscalatedBlocked,
  BLOCKED_ESCALATED_CAUSE: 'blocked_escalated',
}));

// ---------------------------------------------------------------------------
// workflow-orchestrator-overlap-guard (task 793) — default false so existing
// hang-backstop tests keep exercising the force-stop path unaffected.
// ---------------------------------------------------------------------------
export const mockIsOverlapHeld = mock(() => false);

mock.module('../workflow-orchestrator-overlap-guard', () => ({
  isOverlapHeld: mockIsOverlapHeld,
}));
