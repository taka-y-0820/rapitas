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

const { triggerReExecutionAfterAnswer, triggerRedispatchAfterResume } =
  await import('./workflow-handlers-resume-redispatch');

beforeEach(() => {
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
  test('re-triggers execution with the last-used agentConfigId', async () => {
    mockFindFirstExecution.mockResolvedValue({ agentConfigId: 1 });

    await triggerReExecutionAfterAnswer(512);

    expect(mockFindFirstExecution).toHaveBeenCalledWith(
      expect.objectContaining({ where: { session: { config: { taskId: 512 } } } }),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3001/tasks/512/execute');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ agentConfigId: 1 });
  });

  test('still re-triggers execution (default agent config) when the task has no prior execution', async () => {
    // Regression test (task 513): a task run through the workflow CLI
    // executor never gets an AgentExecution row via this session→config
    // chain — that relation is populated by a different execution path.
    mockFindFirstExecution.mockResolvedValue(null);

    await triggerReExecutionAfterAnswer(999);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3001/tasks/999/execute');
    expect(JSON.parse(init.body as string)).toEqual({ agentConfigId: undefined });
  });

  test('does not throw when the re-trigger request is rejected', async () => {
    mockFindFirstExecution.mockResolvedValue({ agentConfigId: 1 });
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'AUTO_RUN_ACTIVE' }), { status: 409 }),
    );

    await expect(triggerReExecutionAfterAnswer(512)).resolves.toBeUndefined();
  });

  test('does not throw when the fetch itself rejects', async () => {
    mockFindFirstExecution.mockResolvedValue({ agentConfigId: 1 });
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(triggerReExecutionAfterAnswer(512)).resolves.toBeUndefined();
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
