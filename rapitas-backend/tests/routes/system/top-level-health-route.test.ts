/**
 * Top-level health route テスト
 *
 * index.ts から抽出した handleTopLevelHealthCheck() の単体テスト。
 * prisma.$queryRaw と getAgentSystemSnapshot をモックし、成功時の全フィールド構成と
 * DB例外時の503応答を検証する。
 */
import { describe, it, expect, mock } from 'bun:test';

const mockQueryRaw = mock(() => Promise.resolve([1]));

const mockSnapshot = {
  status: 'healthy',
  isShuttingDown: false,
  activeExecutions: 0,
  runningExecutions: 0,
  interruptedExecutions: 0,
  interruptedExecutionsHistoryCount: 0,
  interruptedExecutionsDegraded: false,
  queueDepth: 0,
  activePreviewCount: 0,
  serverTime: new Date().toISOString(),
};

const mockGetAgentSystemSnapshot = mock(() => Promise.resolve(mockSnapshot));

mock.module('../../../config', () => ({
  prisma: { $queryRaw: mockQueryRaw },
}));
mock.module('../../../routes/agents/system/agent-system-router', () => ({
  getAgentSystemSnapshot: mockGetAgentSystemSnapshot,
}));

const { handleTopLevelHealthCheck } = await import('../../../routes/system/top-level-health-route');

describe('handleTopLevelHealthCheck', () => {
  it('returns the full field set when DB and snapshot succeed', async () => {
    const result = (await handleTopLevelHealthCheck()) as Record<string, unknown>;

    expect(result.status).toBe('healthy');
    expect(result.database).toBe('connected');
    expect(typeof result.uptimeSeconds).toBe('number');
    expect(result.activeExecutions).toBe(0);
    expect(result.runningExecutions).toBe(0);
    expect(result.interruptedExecutions).toBe(0);
    expect(result.interruptedExecutionsHistoryCount).toBe(0);
    expect(result.interruptedExecutionsDegraded).toBe(false);
    expect(result.queueDepth).toBe(0);
    expect(result.activePreviewCount).toBe(0);
    expect(typeof result.checkMs).toBe('number');
    expect(typeof result.timestamp).toBe('string');
  });

  it('maps snapshot status busy to healthy for the top-level aggregate', async () => {
    mockGetAgentSystemSnapshot.mockImplementationOnce(() =>
      Promise.resolve({ ...mockSnapshot, status: 'busy', activeExecutions: 1 }),
    );

    const result = (await handleTopLevelHealthCheck()) as Record<string, unknown>;

    expect(result.status).toBe('healthy');
  });

  it('passes through a non-healthy/busy snapshot status verbatim', async () => {
    mockGetAgentSystemSnapshot.mockImplementationOnce(() =>
      Promise.resolve({
        ...mockSnapshot,
        status: 'interrupted_executions_unknown',
        interruptedExecutionsDegraded: true,
      }),
    );

    const result = (await handleTopLevelHealthCheck()) as Record<string, unknown>;

    expect(result.status).toBe('interrupted_executions_unknown');
    expect(result.interruptedExecutionsDegraded).toBe(true);
  });

  it('returns a 503 Response when the DB query fails', async () => {
    mockQueryRaw.mockImplementationOnce(() => Promise.reject(new Error('connection refused')));

    const result = await handleTopLevelHealthCheck();

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe('unhealthy');
    expect(body.database).toBe('disconnected');
    expect(body.error).toBe('connection refused');
  });
});
