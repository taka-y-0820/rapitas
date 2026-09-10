import { describe, it, expect, mock } from 'bun:test';

const mockPrisma = {
  agentExecution: {
    findMany: mock(() => Promise.resolve([])),
  },
};

const mockOrchestrator = {
  getActiveExecutionIdsAsync: mock(() => Promise.resolve([1, 2])),
  getActiveExecutions: mock(() => []),
};

mock.module('../../../config/database', () => ({ prisma: mockPrisma }));
mock.module('../../core/orchestrator-instance', () => ({ orchestrator: mockOrchestrator }));
mock.module('../agent-orchestrator', () => ({
  AgentOrchestrator: {
    getInstance: () => ({
      getActiveAgentInfos: () => [{ executionId: 2 }, { executionId: 3 }],
    }),
  },
}));

const { getCurrentActiveExecutionIds, getLiveTaskIdsForActiveExecutions } =
  await import('./current-active-task-ids');

describe('getCurrentActiveExecutionIds', () => {
  it('unions worker and main-orchestrator active execution IDs without duplicates', async () => {
    const ids = await getCurrentActiveExecutionIds();
    expect(new Set(ids)).toEqual(new Set([1, 2, 3]));
  });
});

describe('getLiveTaskIdsForActiveExecutions', () => {
  it('returns an empty set without querying the DB when given no active IDs', async () => {
    mockPrisma.agentExecution.findMany.mockClear();
    const result = await getLiveTaskIdsForActiveExecutions([]);
    expect(result).toEqual(new Set());
    expect(mockPrisma.agentExecution.findMany).not.toHaveBeenCalled();
  });

  it('queries running/waiting_for_input executions restricted to the given IDs', async () => {
    mockPrisma.agentExecution.findMany.mockClear();
    mockPrisma.agentExecution.findMany = mock(() =>
      Promise.resolve([
        { session: { config: { task: { id: 42 } } } },
        { session: { config: { task: { id: 42 } } } },
      ]),
    );
    const result = await getLiveTaskIdsForActiveExecutions([10, 11]);
    expect(result).toEqual(new Set([42]));
    const callArgs = mockPrisma.agentExecution.findMany.mock.calls[0][0];
    expect(callArgs.where.id.in).toEqual([10, 11]);
    expect(callArgs.where.status.in).toEqual(['running', 'waiting_for_input']);
  });

  it('ignores rows whose task ID cannot be resolved', async () => {
    mockPrisma.agentExecution.findMany = mock(() =>
      Promise.resolve([{ session: { config: { task: null } } }]),
    );
    const result = await getLiveTaskIdsForActiveExecutions([99]);
    expect(result).toEqual(new Set());
  });
});
