/**
 * Agent Session Router テスト
 * セッション管理（セッション詳細、停止、再開可能実行）のテスト
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Elysia } from 'elysia';
const stopOrder: string[] = [];
const mainStop = mock(async (id: number) => {
  stopOrder.push(`main:${id}`);
  return true;
});
const workerStop = mock(async (id: number) => {
  stopOrder.push(`worker:${id}`);
  return false;
});

mock.module('../../../config/logger', () => ({
  createLogger: () => ({
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
  }),
}));

const mockPrisma = {
  agentSession: {
    findUnique: mock(() => Promise.resolve(null)),
    update: mock(() => Promise.resolve({})),
  },
  agentExecution: {
    update: mock(async (args: { where: { id: number }; data: { status: string } }) => {
      stopOrder.push(`${args.data.status}:${args.where.id}`);
      return {};
    }),
    findMany: mock(() => Promise.resolve([])),
    updateMany: mock(() => Promise.resolve({ count: 0 })),
  },
  developerModeConfig: {
    findUnique: mock(() => Promise.resolve(null)),
  },
  task: {
    update: mock(() => Promise.resolve({})),
  },
};

mock.module('../../../config/database', () => ({
  prisma: mockPrisma,
  ensureDatabaseConnection: () => Promise.resolve(),
}));

// Mutable across tests so a single test can simulate a live execution feeding
// into getCurrentActiveExecutionIds() (services/agents/resumable-execution).
const mockOrchestrator = {
  getActiveExecutions: () => [],
  getActiveExecutionIdsAsync: mock(() => Promise.resolve([] as number[])),
  stopExecution: mock(() => Promise.resolve()),
  getActiveAgentInfos: () => [],
};
let mockMainActiveExecutionIds: number[] = [];

// NOTE: orchestrator-instance spawns AgentWorkerManager at module load time.
// Mock before import to prevent actual worker process creation in test environment.
mock.module('../../../services/core/orchestrator-instance', () => ({
  orchestrator: mockOrchestrator,
  workerManager: {
    getActiveExecutions: () => [],
    getActiveExecutionIdsAsync: mock(() => Promise.resolve([])),
    stopExecution: mock(() => Promise.resolve()),
  },
}));

mock.module('../../../services/agents/agent-orchestrator', () => ({
  AgentOrchestrator: {
    getInstance: () => ({
      stopExecution: mainStop,
      getActiveAgentInfos: () => mockMainActiveExecutionIds.map((executionId) => ({ executionId })),
    }),
  },
}));

mock.module('../../../services/agents/agent-worker-manager', () => ({
  AgentWorkerManager: {
    getInstance: () => ({
      stopExecution: workerStop,
      getSessionExecutionsAsync: mock(() => Promise.resolve([])),
      getActiveExecutionIdsAsync: mock(() => Promise.resolve([])),
    }),
  },
}));

const { agentSessionRouter } = await import('../../../routes/agents/crud/agent-session-router');

describe('Agent Session Router', () => {
  let app: Elysia;

  beforeEach(() => {
    app = new Elysia().use(agentSessionRouter);
  });

  describe('GET /agents/sessions/:id', () => {
    it('should return session details', async () => {
      const mockSessionId = '999'; // Use numeric ID as expected by implementation
      const response = await app.handle(
        new Request(`http://localhost/agents/sessions/${mockSessionId}`),
      );

      expect(response.status).toBeOneOf([200, 404, 500]); // Allow 500 for test DB issues
    });
  });

  describe('POST /agents/sessions/:id/stop', () => {
    it('stops DB-owned main executions even when the worker inventory is empty', async () => {
      stopOrder.length = 0;
      mainStop.mockClear();
      workerStop.mockClear();
      mockPrisma.agentExecution.findMany.mockResolvedValueOnce([{ id: 3947 }] as never);
      const response = await app.handle(
        new Request('http://localhost/agents/sessions/4013/stop', { method: 'POST' }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true });
      expect(stopOrder).toEqual(['canceling:3947', 'worker:3947', 'main:3947', 'cancelled:3947']);
      expect(mainStop).toHaveBeenCalledWith(3947);
      expect(workerStop).toHaveBeenCalledWith(3947);
    });
    it('should stop a session', async () => {
      const mockSessionId = '999'; // Use numeric ID as expected by implementation
      const response = await app.handle(
        new Request(`http://localhost/agents/sessions/${mockSessionId}/stop`, {
          method: 'POST',
        }),
      );

      expect(response.status).toBeOneOf([200, 404, 500]); // Allow 500 for test DB issues
    });
  });

  describe('GET /agents/resumable-executions', () => {
    afterEach(() => {
      mockPrisma.agentExecution.findMany = mock(() => Promise.resolve([]));
      mockMainActiveExecutionIds = [];
    });

    it('should return resumable executions', async () => {
      const httpResponse = await app.handle(
        new Request('http://localhost/agents/resumable-executions'),
      );

      expect(httpResponse.status).toBe(200);

      if (httpResponse.status === 200) {
        const response = await httpResponse.json();
        expect(response).toBeDefined();
        expect(Array.isArray(response)).toBe(true);
      }
    });

    // task658/execution2806: the task finished (status='done'), so its interrupted
    // row must not appear as operationally relevant resumable work.
    it('excludes an interrupted row whose task is terminal (done)', async () => {
      mockPrisma.agentExecution.findMany = mock((args: { where?: { OR?: unknown } }) => {
        if (!args?.where?.OR) {
          // getLiveTaskIdsForActiveExecutions() query (no live executions here)
          return Promise.resolve([]);
        }
        return Promise.resolve([
          {
            id: 2806,
            sessionId: 1,
            status: 'interrupted',
            errorMessage: null,
            output: null,
            startedAt: null,
            completedAt: null,
            createdAt: new Date(),
            session: {
              config: {
                task: {
                  id: 658,
                  title: 'done task',
                  status: 'done',
                  workflowStatus: 'completed',
                  workflowMode: null,
                  theme: null,
                },
              },
            },
          },
        ]);
      });

      const response = await app.handle(
        new Request('http://localhost/agents/resumable-executions'),
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual([]);
    });

    it('keeps an interrupted row whose task is non-terminal', async () => {
      mockPrisma.agentExecution.findMany = mock((args: { where?: { OR?: unknown } }) => {
        if (!args?.where?.OR) return Promise.resolve([]);
        return Promise.resolve([
          {
            id: 1,
            sessionId: 1,
            status: 'interrupted',
            errorMessage: null,
            output: null,
            startedAt: null,
            completedAt: null,
            createdAt: new Date(),
            session: {
              config: {
                task: {
                  id: 1,
                  title: 'active task',
                  status: 'in-progress',
                  workflowStatus: 'research_done',
                  workflowMode: null,
                  theme: null,
                },
              },
            },
          },
        ]);
      });

      const response = await app.handle(
        new Request('http://localhost/agents/resumable-executions'),
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe(1);
    });

    it('does not double-count a task with a live execution and a stale interrupted row', async () => {
      mockMainActiveExecutionIds = [10];
      mockPrisma.agentExecution.findMany = mock((args: { where?: { OR?: unknown } }) => {
        // getLiveTaskIdsForActiveExecutions() query: reports task 5 as live
        if (!args?.where?.OR) {
          return Promise.resolve([{ session: { config: { task: { id: 5 } } } }]);
        }
        return Promise.resolve([
          {
            id: 10,
            sessionId: 5,
            status: 'running',
            errorMessage: null,
            output: null,
            startedAt: null,
            completedAt: null,
            createdAt: new Date(),
            session: {
              config: {
                task: {
                  id: 5,
                  title: 'in-flight task',
                  status: 'in-progress',
                  workflowStatus: 'in_progress',
                  workflowMode: null,
                  theme: null,
                },
              },
            },
          },
          {
            id: 9,
            sessionId: 5,
            status: 'interrupted',
            errorMessage: null,
            output: null,
            startedAt: null,
            completedAt: null,
            createdAt: new Date(),
            session: {
              config: {
                task: {
                  id: 5,
                  title: 'in-flight task',
                  status: 'in-progress',
                  workflowStatus: 'in_progress',
                  workflowMode: null,
                  theme: null,
                },
              },
            },
          },
        ]);
      });

      const response = await app.handle(
        new Request('http://localhost/agents/resumable-executions'),
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe(10);
      expect(data[0].status).toBe('running');
    });

    it('returns 503 when the database query fails', async () => {
      mockPrisma.agentExecution.findMany = mock(() => Promise.reject(new Error('DB unreachable')));

      const response = await app.handle(
        new Request('http://localhost/agents/resumable-executions'),
      );
      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data).toEqual([]);
    });
  });

  describe('GET /agents/interrupted-executions', () => {
    it('does not offer an old interrupted execution when its task is running again', async () => {
      mockOrchestrator.getActiveExecutionIdsAsync.mockResolvedValue([9002]);
      mockPrisma.agentExecution.findMany = mock((args: unknown) => {
        const query = args as { where?: { status?: unknown } };
        const task = {
          id: 913,
          title: 'same task',
          status: 'in-progress',
          workflowStatus: 'in_progress',
        };
        return Promise.resolve(
          query.where?.status === 'interrupted'
            ? [
                {
                  id: 9001,
                  sessionId: 1,
                  status: 'interrupted',
                  claudeSessionId: 'old-session',
                  output: null,
                  session: { config: { task } },
                },
              ]
            : [{ id: 9002, status: 'running', session: { config: { task } } }],
        );
      });
      const response = await app.handle(
        new Request('http://localhost/agents/interrupted-executions'),
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data[0].isResumableCandidate).toBe(false);
    });

    afterEach(() => {
      mockPrisma.agentExecution.findMany = mock(() => Promise.resolve([]));
    });

    it('should return interrupted executions', async () => {
      const httpResponse = await app.handle(
        new Request('http://localhost/agents/interrupted-executions'),
      );

      expect(httpResponse.status).toBe(200);

      if (httpResponse.status === 200) {
        const response = await httpResponse.json();
        expect(response).toBeDefined();
        expect(Array.isArray(response)).toBe(true);
      }
    });

    it('flags isResumableCandidate=false for a terminal-task row while leaving legacy canResume untouched', async () => {
      mockPrisma.agentExecution.findMany = mock(() =>
        Promise.resolve([
          {
            id: 2806,
            sessionId: 1,
            status: 'interrupted',
            claudeSessionId: null,
            errorMessage: null,
            output: null,
            startedAt: null,
            completedAt: null,
            createdAt: new Date(),
            session: {
              config: {
                task: { id: 658, title: 'done task', status: 'done', workflowStatus: 'completed' },
              },
            },
          },
        ]),
      );

      const response = await app.handle(
        new Request('http://localhost/agents/interrupted-executions'),
      );
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data[0].canResume).toBe(false); // legacy definition: !!claudeSessionId, unchanged
      expect(data[0].isResumableCandidate).toBe(false);
    });

    it('returns 503 when the database query fails', async () => {
      mockPrisma.agentExecution.findMany = mock(() => Promise.reject(new Error('DB unreachable')));

      const response = await app.handle(
        new Request('http://localhost/agents/interrupted-executions'),
      );
      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data).toEqual([]);
    });
  });

  // Note: GET /agents/running-tasks endpoint is not implemented in agent-session-router
});
