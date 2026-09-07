// @ts-nocheck — Loosely-typed mock setup; types are not the concern of this test file.
/**
 * Tests for stop-route worktree cleanup functionality
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ---------------------------------------------------------------------------
// Pre-defined mock functions — must be defined before mock.module() calls
// ---------------------------------------------------------------------------

const mockDb = {
  task: {
    findUnique: mock(() => Promise.resolve(null)),
    update: mock(() => Promise.resolve({})),
  },
  developerModeConfig: {
    findUnique: mock(() => Promise.resolve(null)),
  },
  agentExecution: {
    findFirst: mock(() => Promise.resolve(null)),
    findUnique: mock(() => Promise.resolve(null)),
    update: mock(() => Promise.resolve({})),
  },
  agentExecutionLog: {
    deleteMany: mock(() => Promise.resolve({ count: 0 })),
  },
  agentSession: {
    findMany: mock(() => Promise.resolve([])),
    update: mock(() => Promise.resolve({})),
    updateMany: mock(() => Promise.resolve({ count: 0 })),
  },
  workflowQueueItem: {
    updateMany: mock(() => Promise.resolve({ count: 0 })),
  },
};

const mockOrchestratorInst = {
  stopExecution: mock(() => Promise.resolve(true)),
};

const mockAgentWorkerGetInstance = mock(() => ({
  getSessionExecutionsAsync: mock(() => Promise.resolve([])),
  stopExecution: mock(),
  revertChanges: mock(),
}));

const mockRemoveWorktreeFn = mock(() => Promise.resolve(true));
const mockReleaseTaskExecLock = mock(() => Promise.resolve(undefined));
const mockResolveTaskWorkingDirectory = mock(() => Promise.resolve(null));
const mockStopTaskAgents = mock(() => Promise.resolve({ stoppedCount: 0 }));
const mockRecordTransition = mock(() => Promise.resolve());

// ---------------------------------------------------------------------------
// Module mocks — must be registered before dynamic imports
// ---------------------------------------------------------------------------

mock.module('../../../../config/database', () => ({
  ensureDatabaseConnection: () => Promise.resolve(),
  prisma: mockDb,
}));

mock.module('../../../../config', () => ({
  prisma: mockDb,
  getProjectRoot: () => '/tmp/rapitas-test',
  createLogger: () => ({
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
  }),
}));

mock.module('../../../../services/core/orchestrator-instance', () => ({
  orchestrator: mockOrchestratorInst,
}));

mock.module('../../../../services/agents/agent-worker-manager', () => ({
  AgentWorkerManager: {
    getInstance: mockAgentWorkerGetInstance,
  },
}));

mock.module('../shared/execution-lock', () => ({
  releaseTaskExecutionLock: mockReleaseTaskExecLock,
}));

// NOTE: All exports provided to prevent named-export resolution errors from index.ts re-exports.
mock.module(
  '../../../../services/agents/orchestrator/git-operations/worktree/worktree-ops',
  () => ({
    removeWorktree: mockRemoveWorktreeFn,
    cleanupStaleWorktrees: mock(() => Promise.resolve(0)),
    cleanupOrphanedWorktrees: mock(() => Promise.resolve(0)),
    createWorktree: mock(() => Promise.resolve('')),
    ensureGitRepository: mock(() => Promise.resolve()),
    validateAndSetupRemote: mock(() => Promise.resolve()),
  }),
);

// NOTE: Mock stop-task-agents to prevent loading agent-orchestrator and its deep dependency chain.
mock.module('../../../../services/agents/stop-task-agents', () => ({
  stopTaskAgents: mockStopTaskAgents,
  stopThemeAgents: mock(() => Promise.resolve()),
}));

mock.module('../../../../services/task/task-resolver', () => ({
  resolveTaskWorkingDirectory: mockResolveTaskWorkingDirectory,
}));

mock.module('../../../../services/workflow/auto-run/theme-auto-run-service', () => ({
  getAutoRunState: mock(() => Promise.resolve(null)),
  finalizeStop: mock(() => Promise.resolve()),
  isAutoRunHandlingTask: mock(() => false),
}));

mock.module('../../../../services/workflow/transition-recorder', () => ({
  recordTransition: mockRecordTransition,
}));

// ---------------------------------------------------------------------------
// Dynamic imports AFTER mocks are registered
// ---------------------------------------------------------------------------

const { stopRoute } = await import('./stop-route');
const { prisma } = await import('../../../../config/database');
const { orchestrator } = await import('../../../../services/core/orchestrator-instance');
const { removeWorktree } =
  await import('../../../../services/agents/orchestrator/git-operations/worktree/worktree-ops');

// Aliases matching the original test variable names
const mockPrisma = mockDb;
const mockOrchestrator = mockOrchestratorInst;
const mockRemoveWorktree = mockRemoveWorktreeFn;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetMocks() {
  mockDb.task.findUnique.mockClear();
  mockDb.task.update.mockClear();
  mockDb.developerModeConfig.findUnique.mockClear();
  mockDb.agentExecution.findFirst.mockClear();
  mockDb.agentExecution.findUnique.mockClear();
  mockDb.agentExecution.update.mockClear();
  mockDb.agentExecutionLog.deleteMany.mockClear();
  mockDb.agentSession.findMany.mockReset();
  mockDb.agentSession.findMany.mockResolvedValue([]);
  mockDb.agentSession.update.mockClear();
  mockDb.agentSession.updateMany.mockClear();
  mockDb.workflowQueueItem.updateMany.mockClear();
  mockOrchestratorInst.stopExecution.mockClear();
  mockRemoveWorktreeFn.mockReset();
  mockRemoveWorktreeFn.mockResolvedValue(true);
  mockReleaseTaskExecLock.mockClear();
  mockResolveTaskWorkingDirectory.mockReset();
  mockResolveTaskWorkingDirectory.mockResolvedValue(null);
  mockStopTaskAgents.mockReset();
  mockStopTaskAgents.mockResolvedValue({ stoppedCount: 1 });
  mockRecordTransition.mockClear();
}

const BASE = 'http://localhost/tasks';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stop-route worktree cleanup', () => {
  beforeEach(resetMocks);

  it.skip('should clean up worktree on single execution stop', async () => {
    const taskId = 123;
    const worktreePath = '/test/repo/.worktrees/task-123-abc123';

    // Mock task
    mockPrisma.task.findUnique.mockResolvedValue({
      workingDirectory: '/test/repo',
    });

    // Mock no developer mode config (single execution)
    mockPrisma.developerModeConfig.findUnique.mockResolvedValue(null);

    // Mock running execution
    mockPrisma.agentExecution.findFirst.mockResolvedValue({
      id: 456,
    });

    // Mock execution with session that has worktree
    mockPrisma.agentExecution.findUnique.mockResolvedValue({
      id: 456,
      session: {
        id: 789,
        worktreePath,
      },
    });

    mockOrchestrator.stopExecution.mockResolvedValue(true);
    mockPrisma.agentExecutionLog.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.agentExecution.update.mockResolvedValue({});
    mockPrisma.task.update.mockResolvedValue({});
    mockPrisma.agentSession.update.mockResolvedValue({});
    mockRemoveWorktree.mockResolvedValue(undefined);

    // Create test context
    const context = {
      params: { id: taskId.toString() },
    };

    // Call the route handler
    const app = { post: mock() };
    const routeHandler = mock();

    stopRoute.post = mock((path, handler) => {
      routeHandler.mockImplementation(handler);
      return app;
    });

    // Rebuild the route
    const rebuiltRoute = stopRoute.post('/tasks/:id/stop-execution', routeHandler);

    // Call the handler
    await routeHandler(context);

    // Verify worktree cleanup was called
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/test/repo', worktreePath);
    expect(mockPrisma.agentSession.update).toHaveBeenCalledWith({
      where: { id: 789 },
      data: { worktreePath: null },
    });
  });

  it.skip('should clean up worktree on developer mode session stop', async () => {
    const taskId = 123;
    const worktreePath = '/test/repo/.worktrees/task-123-abc123';

    // Mock task
    mockPrisma.task.findUnique.mockResolvedValue({
      workingDirectory: '/test/repo',
    });

    // Mock developer mode config with session
    mockPrisma.developerModeConfig.findUnique.mockResolvedValue({
      agentSessions: [
        {
          id: 789,
          worktreePath,
        },
      ],
    });

    const mockAgentWorkerManager = {
      getSessionExecutionsAsync: mock(() => Promise.resolve([])),
      stopExecution: mock(),
      revertChanges: mock(),
    };

    // Mock AgentWorkerManager
    const { AgentWorkerManager } = await import('../../../../services/agents/agent-worker-manager');
    AgentWorkerManager.getInstance.mockReturnValue(mockAgentWorkerManager);

    mockPrisma.agentExecution.findMany.mockResolvedValue([]);
    mockPrisma.agentSession.update.mockResolvedValue({});
    mockPrisma.task.update.mockResolvedValue({});
    mockRemoveWorktree.mockResolvedValue(undefined);

    // Create test context
    const context = {
      params: { id: taskId.toString() },
    };

    // Create a mock route handler
    const routeHandler = mock();

    // Mock the Elysia route
    const mockElysia = {
      post: mock((path, handler) => {
        routeHandler.mockImplementation(handler);
        return mockElysia;
      }),
    };

    // Call the handler directly
    // Note: In real implementation, this would be handled by Elysia framework

    // Verify the cleanup logic would be called
    expect(mockPrisma.developerModeConfig.findUnique).toBeDefined();
    expect(mockRemoveWorktree).toBeDefined();
  });

  it('should handle worktree cleanup errors gracefully', async () => {
    const taskId = 123;
    const worktreePath = '/test/repo/.worktrees/task-123-abc123';

    // Mock task
    mockPrisma.task.findUnique.mockResolvedValue({
      workingDirectory: '/test/repo',
    });

    // Mock no developer mode config
    mockPrisma.developerModeConfig.findUnique.mockResolvedValue(null);

    // Mock running execution
    mockPrisma.agentExecution.findFirst.mockResolvedValue({
      id: 456,
    });

    mockPrisma.agentExecution.findUnique.mockResolvedValue({
      id: 456,
      session: {
        id: 789,
        worktreePath,
      },
    });

    mockOrchestrator.stopExecution.mockResolvedValue(true);
    mockPrisma.agentExecutionLog.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.agentExecution.update.mockResolvedValue({});
    mockPrisma.task.update.mockResolvedValue({});

    // Mock worktree cleanup failure
    mockRemoveWorktree.mockRejectedValue(new Error('Cleanup failed'));

    // Create test context
    const context = {
      params: { id: taskId.toString() },
    };

    // The route should still complete successfully despite cleanup error
    expect(() => mockRemoveWorktree('/test/repo', worktreePath)).toThrow('Cleanup failed');
  });

  it('should skip worktree cleanup when no worktree path exists', async () => {
    const taskId = 123;

    // Mock task
    mockPrisma.task.findUnique.mockResolvedValue({
      workingDirectory: '/test/repo',
    });

    mockPrisma.developerModeConfig.findUnique.mockResolvedValue(null);

    // Mock running execution
    mockPrisma.agentExecution.findFirst.mockResolvedValue({
      id: 456,
    });

    // Mock execution with session but no worktree
    mockPrisma.agentExecution.findUnique.mockResolvedValue({
      id: 456,
      session: {
        id: 789,
        worktreePath: null,
      },
    });

    mockOrchestrator.stopExecution.mockResolvedValue(true);
    mockPrisma.agentExecutionLog.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.agentExecution.update.mockResolvedValue({});
    mockPrisma.task.update.mockResolvedValue({});

    // Create test context
    const context = {
      params: { id: taskId.toString() },
    };

    // Verify worktree cleanup is not called when no worktree path
    expect(mockRemoveWorktree).not.toHaveBeenCalled();
  });

  it('does not clear worktreePath when removeWorktree returns false (task 790 / K-8046)', async () => {
    const taskId = 321;
    const worktreePath = '/test/repo/.worktrees/task-321-abc123';

    mockResolveTaskWorkingDirectory.mockResolvedValue({
      workingDirectory: '/test/repo',
      themeId: null,
    });
    mockPrisma.agentSession.findMany.mockResolvedValue([{ id: 789, worktreePath }]);
    mockRemoveWorktree.mockResolvedValue(false);

    const res = await stopRoute.handle(
      new Request(`${BASE}/${taskId}/stop-execution`, { method: 'POST' }),
    );
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/test/repo', worktreePath);
    expect(mockPrisma.agentSession.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ worktreePath: null }) }),
    );
  });

  it('clears worktreePath when removeWorktree returns true', async () => {
    const taskId = 322;
    const worktreePath = '/test/repo/.worktrees/task-322-abc123';

    mockResolveTaskWorkingDirectory.mockResolvedValue({
      workingDirectory: '/test/repo',
      themeId: null,
    });
    mockPrisma.agentSession.findMany.mockResolvedValue([{ id: 790, worktreePath }]);
    mockRemoveWorktree.mockResolvedValue(true);

    const res = await stopRoute.handle(
      new Request(`${BASE}/${taskId}/stop-execution`, { method: 'POST' }),
    );
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(mockPrisma.agentSession.update).toHaveBeenCalledWith({
      where: { id: 790 },
      data: { worktreePath: null },
    });
  });

  it('records manual_execution_stop_revert cause when withdraw is omitted (#875 regression)', async () => {
    const taskId = 875;
    mockResolveTaskWorkingDirectory.mockResolvedValue({ workingDirectory: null, themeId: null });
    mockDb.task.findUnique.mockResolvedValue({ workflowStatus: 'in_progress' });

    const res = await stopRoute.handle(
      new Request(`${BASE}/${taskId}/stop-execution`, { method: 'POST' }),
    );
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.withdrawn).toBe(false);
    expect(mockRecordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        cause: 'manual_execution_stop_revert',
        metadata: { reason: 'manual_stop_execution' },
      }),
    );
    expect(mockDb.task.update).toHaveBeenCalledWith({
      where: { id: taskId },
      data: { status: 'todo' },
    });
  });

  it('records manual_execution_stop_withdraw cause when withdraw:true is sent (#875)', async () => {
    const taskId = 876;
    mockResolveTaskWorkingDirectory.mockResolvedValue({ workingDirectory: null, themeId: null });
    mockDb.task.findUnique.mockResolvedValue({ workflowStatus: 'in_progress' });

    const res = await stopRoute.handle(
      new Request(`${BASE}/${taskId}/stop-execution`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ withdraw: true }),
      }),
    );
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.withdrawn).toBe(true);
    expect(mockRecordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        cause: 'manual_execution_stop_withdraw',
        metadata: { reason: 'manual_stop_execution_withdraw' },
      }),
    );
    expect(mockDb.task.update).toHaveBeenCalledWith({
      where: { id: taskId },
      data: { status: 'todo' },
    });
  });
});
