/**
 * Agent System Router テスト
 * システム・診断機能（暗号化、診断、シャットダウン、再起動）のテスト
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Elysia } from 'elysia';

const mockPrisma = {
  aIAgentConfig: {
    findFirst: mock(() => Promise.resolve(null)),
  },
  agentExecution: {
    count: mock(() => Promise.resolve(0)),
    findMany: mock(() => Promise.resolve([])),
  },
  // getAgentSystemSnapshot() (agent-system-router.ts) queries the auto-run
  // backlog depth via workflowQueueItem.count — must be mocked or /system-status
  // and /health 500 (undefined.count is not a function).
  workflowQueueItem: {
    count: mock(() => Promise.resolve(0)),
  },
  $queryRaw: mock(() => Promise.resolve([1])),
};

const mockOrchestrator = {
  shutdown: mock(() => Promise.resolve()),
  restart: mock(() => Promise.resolve()),
  getActiveExecutionCount: mock(() => 0),
  getActiveExecutionCountAsync: mock(() => Promise.resolve(0)),
  isInShutdown: mock(() => false),
  // Consumed by services/agents/resumable-execution/current-active-task-ids.ts
  // (getAgentSystemSnapshot()'s resumable-interrupted computation).
  getActiveExecutionIdsAsync: mock(() => Promise.resolve([])),
  getActiveExecutions: mock(() => []),
};

const mockRealtimeService = {
  broadcast: mock(() => {}),
  getConnectedClients: mock(() => 0),
};

// Mock modules
mock.module('../../../config', () => ({
  prisma: mockPrisma,
  getProjectRoot: () => '/tmp/rapitas-test',
  createLogger: mock(() => ({
    info: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
    debug: mock(() => {}),
  })),
}));
mock.module('../../../config/database', () => ({
  ensureDatabaseConnection: () => Promise.resolve(),
  prisma: mockPrisma,
}));
mock.module('../../../services/core/orchestrator-instance', () => ({
  orchestrator: mockOrchestrator,
  stopServer: mock(() => Promise.resolve()),
}));
mock.module('../../../routes/agents/approvals', () => ({ orchestrator: mockOrchestrator }));
mock.module('../../../services/agents/agent-orchestrator', () => ({
  AgentOrchestrator: {
    getInstance: () => ({ getActiveAgentInfos: () => [] }),
  },
}));
mock.module('../../../utils/common/encryption', () => ({
  isEncryptionKeyConfigured: mock(() => true),
}));
mock.module('../../../utils/agent-config-schema', () => ({
  getAllAgentConfigSchemas: mock(() => ({})),
}));
mock.module('../../../services/communication/realtime-service', () => ({
  realtimeService: mockRealtimeService,
}));
mock.module('../../../config/logger', () => ({
  createLogger: mock(() => ({
    info: mock(() => {}),
    error: mock(() => {}),
    warn: mock(() => {}),
    debug: mock(() => {}),
  })),
}));

// Mock child_process for diagnose endpoint
mock.module('child_process', () => ({
  spawn: mock(() => ({
    stdout: { on: mock(() => {}) },
    stderr: { on: mock(() => {}) },
    kill: mock(() => {}),
    on: mock((event, callback) => {
      if (event === 'close') setTimeout(() => callback(0), 100);
    }),
  })),
  execSync: mock(() => Buffer.from('')),
}));
mock.module('node:child_process', () => ({
  spawn: mock(() => ({
    stdout: { on: mock(() => {}) },
    stderr: { on: mock(() => {}) },
    kill: mock(() => {}),
    on: mock((event, callback) => {
      if (event === 'close') setTimeout(() => callback(0), 100);
    }),
  })),
  execSync: mock(() => Buffer.from('')),
}));

const { agentSystemRouter } = await import('../../../routes/agents/system/agent-system-router');

interface EncryptionStatusResponse {
  isConfigured: boolean;
  [key: string]: unknown;
}

interface SystemStatusResponse {
  status: string;
  [key: string]: unknown;
}

interface ValidateConfigResponse {
  isValid: boolean;
  [key: string]: unknown;
}

describe('Agent System Router', () => {
  let app: Elysia;
  const originalExit = process.exit;
  const originalSetTimeout = global.setTimeout;

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    // Mock process.exit to prevent shutdown/restart endpoints from killing the test runner
    const mockExit = mock(() => {});
    process.exit = mockExit as unknown as typeof process.exit;

    // Mock setTimeout to prevent delayed process.exit calls
    global.setTimeout = mock((callback: () => void, delay: number, ...args: unknown[]) => {
      // Check if the callback contains process.exit, if so don't execute it
      const callbackStr = callback.toString();
      if (callbackStr.includes('process.exit')) {
        return 0; // Return a dummy timer ID
      }
      // For non-process.exit callbacks, execute immediately for faster tests
      return originalSetTimeout(callback, 0, ...args);
    }) as unknown as typeof setTimeout;

    app = new Elysia().use(agentSystemRouter);
  });

  afterEach(() => {
    process.exit = originalExit;
    global.setTimeout = originalSetTimeout;
  });

  describe('GET /agents/encryption-status', () => {
    it('should return encryption status', async () => {
      const response = (await app
        .handle(new Request('http://localhost/agents/encryption-status'))
        .then((res: Response) => res.json())) as EncryptionStatusResponse;

      expect(response).toBeDefined();
      expect(typeof response.isConfigured).toBe('boolean');
    });
  });

  describe('GET /agents/diagnose', () => {
    it('should return system diagnosis', async () => {
      const response = await app.handle(new Request('http://localhost/agents/diagnose'));

      expect(response.status).toBe(200);
      const data = (await response.json()) as Record<string, unknown>;
      expect(data).toBeDefined();
      expect(typeof data).toBe('object');
    });
  });

  describe('GET /agents/system-status', () => {
    it('should return system status', async () => {
      const response = await app.handle(new Request('http://localhost/agents/system-status'));

      expect(response.status).toBe(200);
      const data = (await response.json()) as SystemStatusResponse;
      expect(data).toBeDefined();
      expect(typeof data.status).toBe('string');
    });

    // getAgentSystemSnapshot() is the shared source for /agents/system-status AND the
    // top-level /health aggregate (index.ts) — both must report the same fields, so
    // pinning this shape here catches drift for both call sites without booting index.ts
    // (which binds the real port).
    it('should return the full snapshot shape with correct field types', async () => {
      const response = await app.handle(new Request('http://localhost/agents/system-status'));
      const data = (await response.json()) as Record<string, unknown>;

      expect(Object.keys(data).sort()).toEqual(
        [
          'activeExecutions',
          'activePreviewCount',
          'interruptedExecutions',
          'interruptedExecutionsHistoryCount',
          'interruptedExecutionsDegraded',
          'isShuttingDown',
          'queueDepth',
          'runningExecutions',
          'serverTime',
          'status',
        ].sort(),
      );
      expect(typeof data.status).toBe('string');
      expect(typeof data.isShuttingDown).toBe('boolean');
      expect(typeof data.activeExecutions).toBe('number');
      expect(typeof data.runningExecutions).toBe('number');
      expect(typeof data.interruptedExecutions).toBe('number');
      expect(typeof data.interruptedExecutionsHistoryCount).toBe('number');
      expect(typeof data.interruptedExecutionsDegraded).toBe('boolean');
      expect(typeof data.queueDepth).toBe('number');
      expect(typeof data.activePreviewCount).toBe('number');
      expect(typeof data.serverTime).toBe('string');
      expect(Number.isNaN(Date.parse(data.serverTime as string))).toBe(false);
    });

    describe('status derivation', () => {
      // Each test overrides one signal and restores the shared mocks afterward —
      // this file mounts a single module-level mockOrchestrator/mockPrisma shared
      // across every describe block, so leaking an override would corrupt later tests.
      afterEach(() => {
        mockOrchestrator.isInShutdown = mock(() => false);
        mockOrchestrator.getActiveExecutionCountAsync = mock(() => Promise.resolve(0));
        mockPrisma.agentExecution.count = mock(() => Promise.resolve(0));
        mockPrisma.agentExecution.findMany = mock(() => Promise.resolve([]));
        mockPrisma.workflowQueueItem.count = mock(() => Promise.resolve(0));
      });

      it("reports 'healthy' when nothing is running, shutting down, or interrupted", async () => {
        const response = await app.handle(new Request('http://localhost/agents/system-status'));
        const data = (await response.json()) as SystemStatusResponse;
        expect(data.status).toBe('healthy');
      });

      it("reports 'shutting_down' regardless of other signals (highest priority)", async () => {
        mockOrchestrator.isInShutdown = mock(() => true);
        mockOrchestrator.getActiveExecutionCountAsync = mock(() => Promise.resolve(3));

        const response = await app.handle(new Request('http://localhost/agents/system-status'));
        const data = (await response.json()) as SystemStatusResponse;
        expect(data.status).toBe('shutting_down');
      });

      it("reports 'busy' when there are active executions", async () => {
        mockOrchestrator.getActiveExecutionCountAsync = mock(() => Promise.resolve(2));

        const response = await app.handle(new Request('http://localhost/agents/system-status'));
        const data = (await response.json()) as SystemStatusResponse;
        expect(data.status).toBe('busy');
        expect(data.activeExecutions).toBe(2);
      });

      it("reports 'interrupted_executions' when idle and a resumable row is stranded under a non-terminal task", async () => {
        mockPrisma.agentExecution.count = mock(() => Promise.resolve(1));
        mockPrisma.agentExecution.findMany = mock(() =>
          Promise.resolve([
            { session: { config: { task: { id: 1, status: 'todo', workflowStatus: null } } } },
          ]),
        );

        const response = await app.handle(new Request('http://localhost/agents/system-status'));
        const data = (await response.json()) as SystemStatusResponse;
        expect(data.status).toBe('interrupted_executions');
        expect(data.interruptedExecutions).toBe(1);
        expect(data.interruptedExecutionsHistoryCount).toBe(1);
        expect(data.interruptedExecutionsDegraded).toBe(false);
      });

      // task658/execution2806: the task finished (status='done') so its interrupted
      // row is a stale leftover, not operationally relevant work. Regression for the
      // bug this task fixes — the raw count alone would have reported 'interrupted_executions'.
      it("reports 'healthy' when the only interrupted row belongs to a terminal (done) task", async () => {
        mockPrisma.agentExecution.count = mock(() => Promise.resolve(1));
        mockPrisma.agentExecution.findMany = mock(() =>
          Promise.resolve([
            {
              session: {
                config: { task: { id: 658, status: 'done', workflowStatus: 'completed' } },
              },
            },
          ]),
        );

        const response = await app.handle(new Request('http://localhost/agents/system-status'));
        const data = (await response.json()) as SystemStatusResponse;
        expect(data.status).toBe('healthy');
        expect(data.interruptedExecutions).toBe(0);
        expect(data.interruptedExecutionsHistoryCount).toBe(1);
        expect(data.interruptedExecutionsDegraded).toBe(false);
      });

      // Counter-example flagged in supervisor review: a failed resumable-interrupted
      // computation must never read as 'healthy', even when the raw-count fallback
      // is 0. Regression for that exact scenario.
      it("reports 'interrupted_executions_unknown' (never 'healthy') when the resumable computation fails, even if the raw count is 0", async () => {
        mockPrisma.agentExecution.count = mock(() => Promise.resolve(0));
        mockPrisma.agentExecution.findMany = mock(() =>
          Promise.reject(new Error('DB unreachable')),
        );

        const response = await app.handle(new Request('http://localhost/agents/system-status'));
        expect(response.status).toBe(200);
        const data = (await response.json()) as SystemStatusResponse;
        expect(data.status).toBe('interrupted_executions_unknown');
        expect(data.status).not.toBe('healthy');
        expect(data.interruptedExecutionsDegraded).toBe(true);
        expect(data.interruptedExecutions).toBe(0);
        expect(data.interruptedExecutionsHistoryCount).toBe(0);
      });

      it('reflects the auto-run backlog depth via queueDepth', async () => {
        mockPrisma.workflowQueueItem.count = mock(() => Promise.resolve(7));

        const response = await app.handle(new Request('http://localhost/agents/system-status'));
        const data = (await response.json()) as SystemStatusResponse;
        expect(data.queueDepth).toBe(7);
      });

      // Regression: right after every restart, the worker subprocess isn't
      // ready yet — sendIPCRequest throws 'Worker not ready' for the first
      // few seconds. This endpoint is polled by the frontend on a timer, so
      // it always lands in that window at least once per restart. Without a
      // fallback, that expected transient condition propagated as an
      // "Unhandled error" logged at ERROR level on every single restart.
      it('falls back to the cached sync count (200, not 500) when the worker is not ready yet', async () => {
        mockOrchestrator.getActiveExecutionCountAsync = mock(() =>
          Promise.reject(new Error('Worker not ready')),
        );
        mockOrchestrator.getActiveExecutionCount = mock(() => 0);

        const response = await app.handle(new Request('http://localhost/agents/system-status'));
        expect(response.status).toBe(200);
        const data = (await response.json()) as SystemStatusResponse;
        expect(data.activeExecutions).toBe(0);
        expect(data.status).toBe('healthy');
      });
    });
  });

  describe('POST /agents/shutdown', () => {
    it('should handle shutdown request', async () => {
      const response = await app.handle(
        new Request('http://localhost/agents/shutdown', {
          method: 'POST',
        }),
      );

      expect(response.status).toBeOneOf([200, 202]);
    });
  });

  describe('POST /agents/restart', () => {
    it('should handle restart request', async () => {
      const response = await app.handle(
        new Request('http://localhost/agents/restart', {
          method: 'POST',
        }),
      );

      expect(response.status).toBeOneOf([200, 202]);
    });
  });

  describe('GET /agents/validate-config', () => {
    it('should validate agent configuration', async () => {
      const response = (await app
        .handle(new Request('http://localhost/agents/validate-config'))
        .then((res: Response) => res.json())) as ValidateConfigResponse;

      expect(response).toBeDefined();
      expect(typeof response.isValid).toBe('boolean');
    });
  });

  describe('GET /agents/health', () => {
    it('should return health status', async () => {
      const response = await app.handle(new Request('http://localhost/agents/health'));

      expect(response.status).toBe(200);
    });
  });
});
