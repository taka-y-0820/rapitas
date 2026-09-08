/**
 * workflow-runner.advancing.test
 *
 * Covers the "advancing" branch of WorkflowRunner.executeWorkflowItem: a normal
 * phase (draft/research_done/in_progress/...) delegates to
 * WorkflowOrchestrator.advanceWorkflow and reacts to its result — success,
 * skipped (mutex held elsewhere), success-but-aborted, and failure with/without
 * a retry budget.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { QueueItem } from './workflow-queue';
import type { WorkflowAdvanceResult } from './workflow-types';
import type { TaskWorkflowState } from '../task/task-resolver';

const loggerMock = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

mock.module('../../config/logger', () => ({
  createLogger: () => loggerMock,
  logger: loggerMock,
  getBackendLogFilePath: () => '/tmp/fake-backend.log',
}));

mock.module('../../config', () => ({
  prisma: {
    task: {
      findUnique: mock(() => Promise.resolve(null)),
      update: mock(() => Promise.resolve({})),
    },
    userSettings: { findFirst: mock(() => Promise.resolve(null)) },
  },
  ensureDatabaseConnection: () => Promise.resolve(),
  logger: loggerMock,
  createLogger: () => loggerMock,
  getDbProvider: () => 'postgresql',
  getInsensitiveMode: () => 'default',
  getProjectRoot: () => '/tmp/rapitas-test',
}));

let resolveWorkflowStateSequence: (TaskWorkflowState | null)[] = [];
const resolveTaskWorkflowStateMock = mock(
  (): Promise<TaskWorkflowState | null> =>
    Promise.resolve(resolveWorkflowStateSequence.shift() ?? null),
);

mock.module('../task/task-resolver', () => ({
  resolveTaskWorkflowState: resolveTaskWorkflowStateMock,
  resolveTaskForPlanApproval: mock(() => Promise.resolve(null)),
  resolveTaskWithTheme: mock(() => Promise.resolve(null)),
  resolveTaskWithThemeAndCategory: mock(() => Promise.resolve(null)),
  resolveTaskForExecution: mock(() => Promise.resolve(null)),
  resolveTaskWorkingDirectory: mock(() => Promise.resolve(null)),
  resolveTaskTitle: mock(() => Promise.resolve(null)),
  resolveTaskThemeId: mock(() => Promise.resolve(null)),
  resolveTaskForComplexityAnalysis: mock(() => Promise.resolve(null)),
  resolveTaskSubtaskInfo: mock(() => Promise.resolve(null)),
  resolveTaskForAutoMerge: mock(() => Promise.resolve(null)),
  resolveTaskForLearning: mock(() => Promise.resolve(null)),
  taskRowConfirmedAbsent: mock(() => Promise.resolve(false)),
}));

let dequeueSequence: QueueItem[] = [];
const dequeueMock = mock(async (): Promise<QueueItem | null> => dequeueSequence.shift() ?? null);
const updateStatusMock = mock(
  (
    id: number,
    status: string,
    extra?: { currentPhase?: string; errorMessage?: string; result?: string },
  ) =>
    Promise.resolve({
      id,
      taskId: 1,
      status,
      currentPhase: extra?.currentPhase ?? 'in_progress',
      priority: 0,
      dependencies: [],
      retryCount: 0,
      maxRetries: 3,
      errorMessage: extra?.errorMessage ?? null,
      queuedAt: new Date(),
      startedAt: null,
      completedAt: null,
      orchestraSessionId: null,
    }),
);
const retryIfPossibleMock = mock(() => Promise.resolve(false));

const queueMock = {
  getMaxConcurrency: () => 2,
  dequeue: dequeueMock,
  updateStatus: updateStatusMock,
  retryIfPossible: retryIfPossibleMock,
  findByTaskId: mock(() => Promise.resolve(null)),
  notifyItemUpdate: () => {},
};

mock.module('./workflow-queue', () => ({
  WorkflowQueueService: { getInstance: () => queueMock },
}));

let advanceWorkflowImpl: (taskId: number) => Promise<WorkflowAdvanceResult> = () =>
  Promise.resolve({ success: true, role: 'researcher', status: 'plan_created', skipped: false });
const advanceWorkflowMock = mock((taskId: number) => advanceWorkflowImpl(taskId));

mock.module('./workflow-orchestrator', () => ({
  WorkflowOrchestrator: { getInstance: () => ({ advanceWorkflow: advanceWorkflowMock }) },
  resolveWorkflowDir: mock(() => ''),
  readWorkflowFile: mock(() => Promise.resolve(null)),
  writeWorkflowFile: mock(() => Promise.resolve()),
  buildRoleContext: mock(() => ({})),
  callAnthropicAPI: mock(() => Promise.resolve('')),
  callOpenAIAPI: mock(() => Promise.resolve('')),
  decryptApiKey: mock(() => ''),
  resolveSystemPromptContent: mock(() => Promise.resolve('')),
}));

const broadcastItemUpdateCalls: { event: string; phase: string }[] = [];
const broadcastItemUpdateMock = mock(
  (_itemId: number, _taskId: number, event: string, phase: string) => {
    broadcastItemUpdateCalls.push({ event, phase });
  },
);

mock.module('./workflow-runner-events', () => ({
  logPhaseTransition: mock(() => Promise.resolve()),
  broadcastRunnerStatus: mock(() => {}),
  broadcastItemUpdate: broadcastItemUpdateMock,
}));

mock.module('../agents/stop-task-agents', () => ({
  stopTaskAgents: mock(() => Promise.resolve({ stoppedCount: 0, executionIds: [] })),
  stopThemeAgents: mock(() => Promise.resolve({ stoppedCount: 0, executionIds: [] })),
}));

mock.module('./subtask-completion-handler', () => ({
  onSubtaskCompleted: mock(() => Promise.resolve()),
  isSubtaskFinished: () => true,
  isSubtaskFailed: () => false,
  isSubtaskPassed: () => true,
  isParentFinalizable: () => true,
}));

const { WorkflowRunner } = await import('./workflow-runner');

function resetRunner(): void {
  (WorkflowRunner as unknown as { instance: unknown }).instance = undefined;
}

function resetMocks(): void {
  updateStatusMock.mockClear();
  retryIfPossibleMock.mockClear();
  advanceWorkflowMock.mockClear();
  resolveTaskWorkflowStateMock.mockClear();
  broadcastItemUpdateCalls.length = 0;
  dequeueSequence = [];
  resolveWorkflowStateSequence = [];
  advanceWorkflowImpl = () =>
    Promise.resolve({ success: true, role: 'researcher', status: 'plan_created', skipped: false });
}

const QUEUE_ITEM: QueueItem = {
  id: 30,
  taskId: 7,
  orchestraSessionId: null,
  priority: 0,
  status: 'running',
  currentPhase: 'research_done',
  dependencies: [],
  retryCount: 0,
  maxRetries: 3,
  errorMessage: null,
  queuedAt: new Date(),
  startedAt: new Date(),
  completedAt: null,
};

function state(overrides: Partial<TaskWorkflowState>): TaskWorkflowState {
  return {
    id: QUEUE_ITEM.taskId,
    status: 'in-progress',
    workflowStatus: 'research_done',
    workflowMode: null,
    parentId: null,
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Starts processing and waits for the item to finish. All dependencies resolve
 * instantly, so a fully-mocked pass can complete inside a single microtask burst
 * — faster than a 10ms poll tick can observe "started". Give it a short head
 * start before polling for settle, so calling stopProcessing() never races the
 * item's own registration (which would otherwise force a "Runner shutdown"
 * abort instead of the natural completion path under test).
 */
async function runAndSettle(
  runner: InstanceType<typeof WorkflowRunner>,
  timeoutMs = 3000,
): Promise<void> {
  dequeueSequence = [QUEUE_ITEM, null];
  runner.startProcessing(60_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await waitUntil(() => runner.getStatus().activeItems === 0, timeoutMs);
  await runner.stopProcessing();
}

describe('WorkflowRunner — advancing phase success', () => {
  beforeEach(() => {
    resetMocks();
    resetRunner();
  });

  // NOTE: the runner waits a hardcoded 1s between phases (DB stabilization) before
  // its next loop check — real time, not mockable — hence this test's 5s budget.
  test('logs the transition, marks the item running at the new phase, then completes on the next check', async () => {
    resolveWorkflowStateSequence = [
      state({ workflowStatus: 'research_done' }),
      state({ workflowStatus: 'completed', status: 'done' }),
    ];
    advanceWorkflowImpl = () =>
      Promise.resolve({ success: true, role: 'planner', status: 'plan_created', skipped: false });

    const runner = WorkflowRunner.getInstance();
    await runAndSettle(runner, 5000);

    expect(advanceWorkflowMock).toHaveBeenCalledWith(QUEUE_ITEM.taskId);
    expect(updateStatusMock).toHaveBeenCalledWith(QUEUE_ITEM.id, 'running', {
      currentPhase: 'plan_created',
    });
    expect(broadcastItemUpdateCalls).toContainEqual({
      event: 'phase_started',
      phase: 'research_done',
    });
    expect(broadcastItemUpdateCalls).toContainEqual({
      event: 'phase_completed',
      phase: 'plan_created',
    });
  }, 7000);

  test('a run aborted right after phase success stops without advancing the queue item', async () => {
    resolveWorkflowStateSequence = [state({ workflowStatus: 'research_done' })];
    let runnerRef: InstanceType<typeof WorkflowRunner> | undefined;
    advanceWorkflowImpl = (taskId) => {
      // Simulate a stop landing exactly between the phase finishing and the runner
      // advancing — abortTask flips the same AbortController the loop checks next.
      runnerRef?.abortTask(taskId);
      return Promise.resolve({
        success: true,
        role: 'planner',
        status: 'plan_created',
        skipped: false,
      });
    };

    const runner = WorkflowRunner.getInstance();
    runnerRef = runner;
    await runAndSettle(runner);

    expect(updateStatusMock).not.toHaveBeenCalledWith(QUEUE_ITEM.id, 'running', expect.anything());
    expect(broadcastItemUpdateCalls.some((c) => c.event === 'phase_completed')).toBe(false);
  });
});

describe('WorkflowRunner — advancing phase skipped/failed', () => {
  beforeEach(() => {
    resetMocks();
    resetRunner();
  });

  test('skipped result re-queues the item instead of failing it', async () => {
    resolveWorkflowStateSequence = [state({ workflowStatus: 'research_done' })];
    advanceWorkflowImpl = () =>
      Promise.resolve({ success: true, role: 'planner', status: 'research_done', skipped: true });

    const runner = WorkflowRunner.getInstance();
    await runAndSettle(runner);

    expect(updateStatusMock).toHaveBeenCalledWith(QUEUE_ITEM.id, 'queued', {
      currentPhase: 'research_done',
    });
    expect(broadcastItemUpdateCalls).toContainEqual({
      event: 'execution_requeued',
      phase: 'research_done',
    });
  });

  test('superseded phase requeues the new state without consuming failure retries', async () => {
    resolveWorkflowStateSequence = [state({ workflowStatus: 'in_progress' })];
    advanceWorkflowImpl = () =>
      Promise.resolve({
        success: false,
        role: 'verifier',
        status: 'research_done',
        skipped: false,
        superseded: true,
      });
    await runAndSettle(WorkflowRunner.getInstance());
    expect(retryIfPossibleMock).not.toHaveBeenCalled();
    expect(updateStatusMock).toHaveBeenCalledWith(QUEUE_ITEM.id, 'queued', {
      currentPhase: 'research_done',
    });
  });

  test('stop wins over requeue when a superseded phase returns', async () => {
    resolveWorkflowStateSequence = [state({ workflowStatus: 'in_progress' })];
    const runner = WorkflowRunner.getInstance();
    advanceWorkflowImpl = (taskId) => {
      runner.abortTask(taskId);
      return Promise.resolve({
        success: false,
        role: 'verifier',
        status: 'research_done',
        superseded: true,
      });
    };
    await runAndSettle(runner);
    expect(retryIfPossibleMock).not.toHaveBeenCalled();
    expect(updateStatusMock).not.toHaveBeenCalledWith(QUEUE_ITEM.id, 'queued', expect.anything());
  });

  test('failed result with retry budget left broadcasts execution_retrying', async () => {
    resolveWorkflowStateSequence = [state({ workflowStatus: 'research_done' })];
    advanceWorkflowImpl = () =>
      Promise.resolve({
        success: false,
        role: 'planner',
        status: 'research_done',
        error: 'agent crashed',
        skipped: false,
      });
    retryIfPossibleMock.mockResolvedValueOnce(true);

    const runner = WorkflowRunner.getInstance();
    await runAndSettle(runner);

    expect(retryIfPossibleMock).toHaveBeenCalledWith(QUEUE_ITEM.id, 'agent crashed');
    expect(broadcastItemUpdateCalls).toContainEqual({
      event: 'execution_retrying',
      phase: 'research_done',
    });
  });

  test('failed result with no retry budget broadcasts execution_failed', async () => {
    resolveWorkflowStateSequence = [state({ workflowStatus: 'research_done' })];
    advanceWorkflowImpl = () =>
      Promise.resolve({
        success: false,
        role: 'planner',
        status: 'research_done',
        error: 'role has no agent assigned',
        skipped: false,
      });
    retryIfPossibleMock.mockResolvedValueOnce(false);

    const runner = WorkflowRunner.getInstance();
    await runAndSettle(runner);

    expect(broadcastItemUpdateCalls).toContainEqual({
      event: 'execution_failed',
      phase: 'research_done',
    });
  });
});
