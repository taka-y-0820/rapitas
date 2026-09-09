/**
 * theme-auto-run-scheduler.test-support.collaborator-mocks
 *
 * bun:test mock.module() definitions for theme-auto-run-scheduler's
 * data/infrastructure collaborators: prisma (config), task-resolver,
 * workflow-queue, workflow-runner, agent-worker-manager, realtime-service,
 * backlog-task-promoter, dev-restart-on-dry, observability, transition-recorder,
 * and stop-task-agents. Split out of theme-auto-run-scheduler.test-support.ts
 * (task 765) to stay under the file-size ratchet; the barrel file re-exports
 * everything below so existing *.test.ts imports are unaffected.
 *
 * Not responsible for the scheduler's own decision-layer collaborators
 * (auto-run-selection, theme-auto-run-service, notifications, resource gate,
 * merge barrier) — see theme-auto-run-scheduler.test-support.decision-mocks.ts.
 */
import { mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Silent logger (mirrors the shape used elsewhere: info/warn/error/debug)
// ---------------------------------------------------------------------------
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// ---------------------------------------------------------------------------
// prisma (config) mocks
// ---------------------------------------------------------------------------
export const mockTaskCount = mock(() => Promise.resolve(0));
export const mockTaskFindMany = mock(() => Promise.resolve([] as Array<{ id: number }>));
export const mockTaskUpdate = mock(() => Promise.resolve({}));
export const mockTaskFindUnique = mock(() =>
  Promise.resolve(null as { workflowStatus: string } | null),
);
export const mockThemeAutoRunUpdateMany = mock(() => Promise.resolve({ count: 0 }));
export const mockThemeAutoRunCount = mock(() => Promise.resolve(0));
export const mockQueueItemFindFirst = mock(() =>
  Promise.resolve(null as { id: number; status: string; errorMessage: string | null } | null),
);
export const mockQueueItemUpdateMany = mock(() => Promise.resolve({ count: 0 }));
/** Counts `actor:'user'` transitions after a failure — the revival check. */
export const mockResumeTransition = mock(() => Promise.resolve<{ createdAt: Date } | null>(null));
export const mockTransitionCount = mock(() => Promise.resolve(0));
/** Resource-contention gate hold record (task 725) — default unused (gate off in tests). */
export const mockActivityLogCreate = mock(() => Promise.resolve({}));
/** UserSettings row for the idle-stop timer (task 784) — null → defaults (60 min armed). */
export const mockUserSettingsFindFirst = mock(() =>
  Promise.resolve(
    null as { idleStopMinutes?: number | null; selfRefillWindowStart?: string | null } | null,
  ),
);

mock.module('../../../config', () => ({
  prisma: {
    userSettings: {
      findFirst: mockUserSettingsFindFirst,
    },
    task: {
      count: mockTaskCount,
      findMany: mockTaskFindMany,
      update: mockTaskUpdate,
      findUnique: (args: any) =>
        args.select?.updatedAt && Object.keys(args.select).length === 1
          ? Promise.resolve({ updatedAt: new Date(0) })
          : mockTaskFindUnique(),
    },
    themeAutoRun: {
      updateMany: mockThemeAutoRunUpdateMany,
      count: mockThemeAutoRunCount,
    },
    workflowQueueItem: {
      findFirst: mockQueueItemFindFirst,
      updateMany: mockQueueItemUpdateMany,
    },
    workflowTransition: {
      count: mockTransitionCount,
      findFirst: mockResumeTransition,
    },
    activityLog: {
      create: mockActivityLogCreate,
    },
  },
  ensureDatabaseConnection: () => Promise.resolve(),
  getDbProvider: () => 'postgresql',
  getInsensitiveMode: () => ({}),
  getProjectRoot: () => '/tmp/rapitas-test',
  logger: silentLogger,
  createLogger: () => silentLogger,
}));

mock.module('../../../config/logger', () => ({
  getBackendLogFilePath: () => '/tmp/rapitas-test/backend.log',
  logger: silentLogger,
  createLogger: () => silentLogger,
}));

// ---------------------------------------------------------------------------
// task-resolver mocks
// ---------------------------------------------------------------------------
export const mockResolveTaskThemeId = mock(() =>
  Promise.resolve(null as { id: number; themeId: number | null } | null),
);
export const mockResolveTaskWorkflowState = mock(() =>
  Promise.resolve(
    null as {
      id: number;
      status: string;
      workflowStatus: string | null;
      workflowMode: string | null;
      parentId: number | null;
    } | null,
  ),
);
export const mockResolveTaskWorkingDirectory = mock(() =>
  Promise.resolve(
    null as {
      themeId: number | null;
      workingDirectory: string | null;
      theme: { workingDirectory: string | null } | null;
    } | null,
  ),
);

mock.module('../../task/task-resolver', () => ({
  resolveTaskWithTheme: mock(() => Promise.resolve(null)),
  resolveTaskWithThemeAndCategory: mock(() => Promise.resolve(null)),
  resolveTaskForExecution: mock(() => Promise.resolve(null)),
  resolveTaskWorkingDirectory: mockResolveTaskWorkingDirectory,
  resolveTaskWorkflowState: mockResolveTaskWorkflowState,
  resolveTaskTitle: mock(() => Promise.resolve(null)),
  resolveTaskThemeId: mockResolveTaskThemeId,
  resolveTaskForComplexityAnalysis: mock(() => Promise.resolve(null)),
  resolveTaskSubtaskInfo: mock(() => Promise.resolve(null)),
  resolveTaskForPlanApproval: mock(() => Promise.resolve(null)),
  resolveTaskForAutoMerge: mock(() => Promise.resolve(null)),
  resolveTaskForLearning: mock(() => Promise.resolve(null)),
}));

// ---------------------------------------------------------------------------
// workflow-queue / workflow-runner / agent-worker-manager / realtime-service
// ---------------------------------------------------------------------------
export const mockEnqueue = mock(() => Promise.resolve({}));

mock.module('../workflow-queue', () => ({
  WorkflowQueueService: {
    getInstance: () => ({
      setMaxConcurrency: () => {},
      getMaxConcurrency: () => 1,
      enqueue: mockEnqueue,
      dequeue: () => Promise.resolve(null),
      updateStatus: () => Promise.resolve({}),
      retryIfPossible: () => Promise.resolve(false),
      cancel: () => Promise.resolve({}),
      updatePriority: () => Promise.resolve({}),
      getQueueState: () => Promise.resolve({}),
      getSessionItems: () => Promise.resolve([]),
      recoverStaleItems: () => Promise.resolve(0),
      findByTaskId: () => Promise.resolve(null),
    }),
  },
}));

export const mockStartProcessing = mock(() => {});

mock.module('../workflow-runner', () => ({
  WorkflowRunner: {
    getInstance: () => ({
      startProcessing: mockStartProcessing,
      stopProcessing: () => Promise.resolve(),
      abortTask: () => 0,
      getStatus: () => ({ activeItems: 0, queuedItems: 0, maxConcurrency: 1, isRunning: false }),
      resumeAfterApproval: () => Promise.resolve(true),
    }),
  },
}));

export const mockRevertChanges = mock(() => Promise.resolve(true));

mock.module('../../agents/agent-worker-manager', () => ({
  AgentWorkerManager: {
    getInstance: () => ({ revertChanges: mockRevertChanges }),
  },
}));

export const mockBroadcast = mock(() => {});

mock.module('../../communication/realtime-service', () => ({
  RealtimeService: class {},
  realtimeService: { broadcast: mockBroadcast },
}));

// ---------------------------------------------------------------------------
// backlog-task-promoter / dev-restart-on-dry / observability
// ---------------------------------------------------------------------------
export const mockHasPromotableBacklog = mock(() => Promise.resolve(false));
export const mockPromoteBacklogForTheme = mock(() => Promise.resolve(0));

mock.module('./backlog-task-promoter', () => ({
  hasPromotableBacklog: mockHasPromotableBacklog,
  promoteBacklogForTheme: mockPromoteBacklogForTheme,
}));

export const mockRecordStartupCommit = mock(() => Promise.resolve());
export const mockMaybeRestartForUpdate = mock(() => Promise.resolve(false));

mock.module('./dev-restart-on-dry', () => ({
  recordStartupCommit: mockRecordStartupCommit,
  maybeRestartForUpdate: mockMaybeRestartForUpdate,
}));

export const mockRecordTransition = mock(() => Promise.resolve());
mock.module('../transition-recorder', () => ({ recordTransition: mockRecordTransition }));

export const mockLogCycleEvent = mock(() => {});

mock.module('../../observability', () => ({
  logCycleEvent: mockLogCycleEvent,
  getCycleLogFilePath: () => '/tmp/rapitas-test/cycle.ndjson',
}));

// ---------------------------------------------------------------------------
// stop-task-agents (dynamically imported inside stopThemeExecution)
// ---------------------------------------------------------------------------
export const mockStopTaskAgents = mock(() =>
  Promise.resolve({ stoppedCount: 0, executionIds: [] }),
);
export const mockStopThemeAgents = mock(() =>
  Promise.resolve({ stoppedCount: 0, executionIds: [] }),
);

export const mockStopTaskTreeAgents = mock(() =>
  Promise.resolve({ stoppedCount: 0, executionIds: [] }),
);
mock.module('../../agents/stop-task-agents', () => ({
  stopTaskTreeAgents: mockStopTaskTreeAgents,
  stopTaskAgents: mockStopTaskAgents,
  stopThemeAgents: mockStopThemeAgents,
}));
