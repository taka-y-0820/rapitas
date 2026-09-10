/**
 * workflow-handlers-resume-redispatch.test
 *
 * Tests for triggerReExecutionAfterAnswer (intake question re-run) and
 * triggerRedispatchAfterResume (task 830: re-dispatch nudge after an
 * implementation-phase question is resolved).
 */
import { describe, expect, test, mock, beforeEach, afterAll } from 'bun:test';

// ---- prisma mock ----
const mockFindFirstExecution = mock(() => Promise.resolve<Record<string, unknown> | null>(null));
const mockPrisma = {
  agentExecution: {
    findFirst: mockFindFirstExecution,
  },
};
mock.module('../../../config', () => ({
  prisma: mockPrisma,
  createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }),
}));

// ---- fetch mock (the auto re-run's internal loopback call) ----
const mockFetch = mock(() => Promise.resolve(new Response(null, { status: 200 })));
const originalFetch = global.fetch;

// ---- task-resolver mock ----
const mockResolveTaskThemeId = mock(() =>
  Promise.resolve<{ id: number; themeId: number | null } | null>(null),
);
mock.module('../../../services/task/task-resolver', () => ({
  resolveTaskThemeId: mockResolveTaskThemeId,
}));

// ---- redispatch-nudge collaborators mock (task 830) ----
const mockEnqueue = mock(() => Promise.resolve({}));
mock.module('../../../services/workflow/workflow-queue', () => ({
  WorkflowQueueService: { getInstance: () => ({ enqueue: mockEnqueue }) },
}));
const mockGetAutoRunState = mock(() =>
  Promise.resolve<{ enabled: boolean; status: string; currentTaskId: number | null } | null>(null),
);
const mockSetCurrentTask = mock(() => Promise.resolve());
mock.module('../../../services/workflow/auto-run/theme-auto-run-service', () => ({
  getAutoRunState: mockGetAutoRunState,
  setCurrentTask: mockSetCurrentTask,
}));

const mockAdvance = mock(() => Promise.resolve({ success: true }));
mock.module('../../../services/workflow/workflow-orchestrator', () => ({
  WorkflowOrchestrator: { getInstance: () => ({ advanceWorkflow: mockAdvance }) },
}));

const { triggerReExecutionAfterAnswer, triggerRedispatchAfterResume } =
  await import('./workflow-handlers-resume-redispatch');

beforeEach(() => {
  mockAdvance.mockReset().mockResolvedValue({ success: true });
  mockFindFirstExecution.mockReset().mockResolvedValue(null);
  mockResolveTaskThemeId.mockReset().mockResolvedValue(null);
  mockEnqueue.mockReset().mockResolvedValue({});
  mockGetAutoRunState.mockReset().mockResolvedValue(null);
  mockSetCurrentTask.mockReset().mockResolvedValue(undefined);
  mockFetch.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('triggerReExecutionAfterAnswer', () => {
  test('uses workflow role selection instead of generic manual execution', async () => {
    await triggerReExecutionAfterAnswer(512);
    expect(mockAdvance).toHaveBeenCalledWith(512);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockFindFirstExecution).not.toHaveBeenCalled();
  });
  test('resumes only the answered task while its theme is disabled', async () => {
    mockResolveTaskThemeId.mockResolvedValue({ id: 512, themeId: 1 });
    mockGetAutoRunState.mockResolvedValue({ enabled: false, status: 'idle', currentTaskId: null });
    await triggerReExecutionAfterAnswer(512);
    expect(mockAdvance).toHaveBeenCalledWith(512);
    expect(mockSetCurrentTask).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
  test('does not reject the persisted answer on workflow failure', async () => {
    mockAdvance.mockRejectedValue(new Error('workflow failed'));
    await expect(triggerReExecutionAfterAnswer(512)).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// Regression tests (task 830): task #829 sat at status='todo' with an
// advanced workflowStatus for 24+ minutes after its question was resolved
// because nothing re-dispatched it — ThemeAutoRun.currentTaskId was left
// untouched by the resume handler, so the task waited for the theme to
// happen to reselect it (or never did). The nudge below claims it back only
// when that is provably safe.
describe('triggerRedispatchAfterResume', () => {
  beforeEach(() => {
    mockResolveTaskThemeId.mockResolvedValue({ id: 829, themeId: 42 });
  });

  test('re-enqueues and claims the task when the theme is idle (no current task)', async () => {
    mockGetAutoRunState.mockResolvedValue({
      enabled: true,
      status: 'running',
      currentTaskId: null,
    });

    await triggerRedispatchAfterResume(829);

    expect(mockEnqueue).toHaveBeenCalledWith({ taskId: 829, themeId: 42, priority: 50 });
    expect(mockSetCurrentTask).toHaveBeenCalledWith(42, 829);
  });

  test('re-enqueues when the theme already tracks this exact task as current', async () => {
    mockGetAutoRunState.mockResolvedValue({ enabled: true, status: 'running', currentTaskId: 829 });

    await triggerRedispatchAfterResume(829);

    expect(mockEnqueue).toHaveBeenCalledWith({ taskId: 829, themeId: 42, priority: 50 });
    expect(mockSetCurrentTask).toHaveBeenCalledWith(42, 829);
  });

  test('never claims the theme when it is mid-flight on a DIFFERENT task (no concurrent agents)', async () => {
    mockGetAutoRunState.mockResolvedValue({ enabled: true, status: 'running', currentTaskId: 999 });

    await triggerRedispatchAfterResume(829);

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockSetCurrentTask).not.toHaveBeenCalled();
  });

  test('does nothing when the theme has no auto-run state', async () => {
    mockGetAutoRunState.mockResolvedValue(null);

    await triggerRedispatchAfterResume(829);

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('does nothing when auto-run is disabled for the theme', async () => {
    mockGetAutoRunState.mockResolvedValue({ enabled: false, status: 'idle', currentTaskId: null });

    await triggerRedispatchAfterResume(829);

    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('does nothing when the task has no theme', async () => {
    mockResolveTaskThemeId.mockResolvedValue({ id: 829, themeId: null });

    await triggerRedispatchAfterResume(829);

    expect(mockGetAutoRunState).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  // Judge finding (task 830 repair): claiming currentTaskId for a task that
  // was never actually enqueued would recreate the same desync this nudge
  // exists to close — setCurrentTask must never fire on a failed enqueue.
  test('never claims currentTaskId when the enqueue call fails', async () => {
    mockGetAutoRunState.mockResolvedValue({
      enabled: true,
      status: 'running',
      currentTaskId: null,
    });
    mockEnqueue.mockRejectedValue(new Error('queue down'));

    await expect(triggerRedispatchAfterResume(829)).resolves.toBeUndefined();

    expect(mockSetCurrentTask).not.toHaveBeenCalled();
  });
});

describe('intake answer under AutoRun', () => {
  test('requeues and rebases the current claim instead of using the forbidden manual route', async () => {
    mockResolveTaskThemeId.mockResolvedValue({ id: 894, themeId: 1 });
    mockGetAutoRunState.mockResolvedValue({ enabled: true, status: 'running', currentTaskId: 894 });
    await triggerReExecutionAfterAnswer(894);
    expect(mockEnqueue).toHaveBeenCalledWith({ taskId: 894, themeId: 1, priority: 50 });
    expect(mockSetCurrentTask).toHaveBeenCalledWith(1, 894);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  test('does not take over another task or fall back to manual execution', async () => {
    mockResolveTaskThemeId.mockResolvedValue({ id: 894, themeId: 1 });
    mockGetAutoRunState.mockResolvedValue({ enabled: true, status: 'running', currentTaskId: 999 });
    await triggerReExecutionAfterAnswer(894);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockSetCurrentTask).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
  test('failed enqueue cannot refresh the claim or launch a second execution', async () => {
    mockResolveTaskThemeId.mockResolvedValue({ id: 894, themeId: 1 });
    mockGetAutoRunState.mockResolvedValue({ enabled: true, status: 'running', currentTaskId: 894 });
    mockEnqueue.mockRejectedValue(new Error('queue unavailable'));
    await triggerReExecutionAfterAnswer(894);
    expect(mockSetCurrentTask).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
