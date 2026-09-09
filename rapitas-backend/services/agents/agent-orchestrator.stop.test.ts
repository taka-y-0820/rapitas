/**
 * agent-orchestrator.stop.test
 *
 * Covers stopExecution() branch coverage (missing execution, missing agent,
 * successful stop, agent.stop() throwing) and stopAllForTasks(), the
 * in-memory sweep used by stop-task-agents.ts to catch agents whose DB
 * status row is stale or missing (spawn race / orphaned in-progress row).
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ── Module-level mocks (declared before the dynamic import) ────────────────

mock.module('../../config/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  getBackendLogFilePath: (stamp?: string) => `/mock/backend-${stamp ?? 'today'}.log`,
}));

mock.module('../../utils/common/secret-store', () => ({
  isKeychainSecretRef: () => false,
  saveProviderApiKey: () => '',
  saveAgentApiKey: () => '',
  saveSecret: () => '',
  resolveStoredSecret: () => null,
  deleteStoredSecret: () => {},
  maskStoredSecret: () => null,
}));

const getAgentMock = mock((_id: string) => undefined as { stop: () => Promise<void> } | undefined);
const removeAgentMock = mock((_id: string) => Promise.resolve(true));
mock.module('./agent-factory', () => ({
  AGENT_TYPES: ['claude-code', 'codex', 'gemini', 'custom'],
  isAgentType: (s: unknown) => typeof s === 'string',
  narrowAgentType: (s: string | null | undefined) => s ?? 'claude-code',
  AgentFactory: class {
    static getInstance() {
      return {
        createAgent: () => ({ stop: () => Promise.resolve() }),
        getAgent: getAgentMock,
        removeAgent: removeAgentMock,
      };
    }
  },
  agentFactory: {
    createAgent: () => ({ stop: () => Promise.resolve() }),
    getAgent: getAgentMock,
    removeAgent: removeAgentMock,
    getAllActiveAgents: () => new Map(),
    getRegisteredAgents: () => [],
    getAvailableAgents: () => Promise.resolve([]),
    getAgentsByCapability: () => [],
    createDefaultAgent: () => ({ stop: () => Promise.resolve() }),
  },
}));

mock.module('./orchestrator/git-operations', () => ({
  GitOperations: class {
    getGitDiff = mock(() => Promise.resolve(''));
    getFullGitDiff = mock(() => Promise.resolve(''));
    commitChanges = mock(() => Promise.resolve({ success: true }));
    createPullRequest = mock(() => Promise.resolve({ success: true }));
    mergePullRequest = mock(() => Promise.resolve({ success: true }));
    revertChanges = mock(() => Promise.resolve(true));
    createBranch = mock(() => Promise.resolve(true));
    createWorktree = mock(() => Promise.resolve(''));
    removeWorktree = mock(() => Promise.resolve());
    cleanupStaleWorktrees = mock(() => Promise.resolve(0));
    createCommit = mock(() =>
      Promise.resolve({ hash: '', branch: '', filesChanged: 0, additions: 0, deletions: 0 }),
    );
    getDiff = mock(() => Promise.resolve([]));
  },
  getGitDiff: mock(() => Promise.resolve('')),
  getFullGitDiff: mock(() => Promise.resolve('')),
  commitChanges: mock(() => Promise.resolve({ success: true })),
  getDiff: mock(() => Promise.resolve([])),
  createCommit: mock(() =>
    Promise.resolve({ hash: '', branch: '', filesChanged: 0, additions: 0, deletions: 0 }),
  ),
  createBranch: mock(() => Promise.resolve(true)),
  createPullRequest: mock(() => Promise.resolve({ success: true })),
  mergePullRequest: mock(() => Promise.resolve({ success: true })),
  revertChanges: mock(() => Promise.resolve(true)),
  ensureGitRepository: mock(() => Promise.resolve()),
  validateAndSetupRemote: mock(() => Promise.resolve()),
  createWorktree: mock(() => Promise.resolve('')),
  removeWorktree: mock(() => Promise.resolve()),
  cleanupStaleWorktrees: mock(() => Promise.resolve(0)),
}));

mock.module('./orchestrator/lifecycle-manager', () => ({
  setupSignalHandlers: mock(() => {}),
  gracefulShutdown: mock(() => Promise.resolve()),
  saveAllAgentStates: mock(() => Promise.resolve()),
  saveAgentState: mock(() => Promise.resolve()),
}));

mock.module('./orchestrator/task-executor', () => ({
  executeTask: mock(() => Promise.resolve({ success: true, output: '' })),
  autoCompleteTaskDurable: mock(() => Promise.resolve()),
}));

mock.module('./orchestrator/continuation-executor', () => ({
  executeContinuation: mock(() => Promise.resolve({ success: true, output: '' })),
  executeContinuationWithLock: mock(() => Promise.resolve({ success: true, output: '' })),
  executeContinuationInternal: mock(() => Promise.resolve({ success: true, output: '' })),
  handleQuestionTimeout: mock(() => Promise.resolve()),
}));

mock.module('./orchestrator/recovery-manager', () => ({
  getInterruptedExecutions: mock(() => Promise.resolve([])),
  recoverStaleExecutions: mock(() => Promise.resolve({ recovered: 0, failed: 0 })),
  resumeInterruptedExecution: mock(() => Promise.resolve({ success: true, output: '' })),
  buildResumePrompt: mock(() => ''),
  // NOTE: added in f996dff5 (execution lease) — stale mocks without this export
  // fail ESM named-import validation before any test runs (task 600).
  startExecutionLeaseSweep: mock(() => undefined),
}));

const { AgentOrchestrator } = await import('./agent-orchestrator');

import type { ExecutionState, ActiveAgentInfo, OrchestratorEvent } from './orchestrator/types';

type OrchestratorInternals = {
  activeExecutions: Map<number, ExecutionState>;
  activeAgents: Map<number, ActiveAgentInfo>;
};

function internals(o: InstanceType<typeof AgentOrchestrator>): OrchestratorInternals {
  return o as unknown as OrchestratorInternals;
}

const mockPrisma = {
  agentExecution: { update: mock(() => Promise.resolve({})) },
  userSettings: { findFirst: mock(() => Promise.resolve(null)) },
};

function getOrchestrator() {
  return AgentOrchestrator.getInstance(
    mockPrisma as unknown as Parameters<typeof AgentOrchestrator.getInstance>[0],
  );
}

function makeExecutionState(overrides: Partial<ExecutionState> = {}): ExecutionState {
  return {
    executionId: 1,
    sessionId: 10,
    agentId: 'agent-1',
    taskId: 100,
    status: 'running',
    startedAt: new Date('2026-01-01T00:00:00Z'),
    output: 'partial output',
    ...overrides,
  };
}

function makeActiveAgentInfo(overrides: Partial<ActiveAgentInfo> = {}): ActiveAgentInfo {
  const state = makeExecutionState(overrides as Partial<ExecutionState>);
  return {
    agent: { stop: () => Promise.resolve() } as unknown as ActiveAgentInfo['agent'],
    executionId: state.executionId,
    sessionId: state.sessionId,
    taskId: state.taskId,
    state,
    lastOutput: '',
    lastSavedAt: new Date(),
  };
}

beforeEach(() => {
  const orchestrator = getOrchestrator();
  internals(orchestrator).activeExecutions.clear();
  internals(orchestrator).activeAgents.clear();
  mockPrisma.agentExecution.update.mockClear();
  getAgentMock.mockClear();
  getAgentMock.mockReturnValue(undefined);
  removeAgentMock.mockClear();
});

describe('stopExecution', () => {
  test('returns false and does nothing when no active execution is tracked', async () => {
    const orchestrator = getOrchestrator();

    const result = await orchestrator.stopExecution(999);

    expect(result).toBe(false);
    expect(mockPrisma.agentExecution.update).not.toHaveBeenCalled();
  });

  test('returns false and cleans up in-memory state when no agent is found for a tracked execution', async () => {
    const orchestrator = getOrchestrator();
    const state = makeExecutionState({ executionId: 1, agentId: 'ghost-agent' });
    internals(orchestrator).activeExecutions.set(1, state);
    internals(orchestrator).activeAgents.set(1, makeActiveAgentInfo({ executionId: 1 }));
    getAgentMock.mockReturnValue(undefined);

    const result = await orchestrator.stopExecution(1);

    expect(result).toBe(false);
    // No DB update — the caller (e.g. stop-task-agents) is expected to fall
    // back to the DB-based sweep when the in-memory agent has vanished.
    expect(mockPrisma.agentExecution.update).not.toHaveBeenCalled();
    expect(internals(orchestrator).activeExecutions.has(1)).toBe(false);
    expect(internals(orchestrator).activeAgents.has(1)).toBe(false);
  });

  test('stops the agent, marks the execution cancelled, and emits execution_cancelled', async () => {
    const orchestrator = getOrchestrator();
    const state = makeExecutionState({ executionId: 2, agentId: 'agent-2' });
    internals(orchestrator).activeExecutions.set(2, state);
    internals(orchestrator).activeAgents.set(2, makeActiveAgentInfo({ executionId: 2 }));
    const agentStop = mock(async () => {
      expect(state.status).toBe('cancelled');
    });
    getAgentMock.mockReturnValue({ stop: agentStop });

    const events: OrchestratorEvent[] = [];
    orchestrator.addEventListener((e) => events.push(e));

    const result = await orchestrator.stopExecution(2);

    expect(result).toBe(true);
    expect(agentStop).toHaveBeenCalledTimes(1);
    expect(mockPrisma.agentExecution.update).toHaveBeenCalledWith({
      where: { id: 2 },
      data: {
        status: 'cancelled',
        output: state.output,
        completedAt: expect.any(Date),
        errorMessage: 'Cancelled by user',
      },
    });
    expect(removeAgentMock).toHaveBeenCalledWith('agent-2');
    expect(internals(orchestrator).activeExecutions.has(2)).toBe(false);
    expect(internals(orchestrator).activeAgents.has(2)).toBe(false);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'execution_cancelled',
        executionId: 2,
        sessionId: state.sessionId,
        taskId: state.taskId,
      }),
    ]);
  });

  test('swallows an error from agent.stop() and still completes cleanup', async () => {
    const orchestrator = getOrchestrator();
    const state = makeExecutionState({ executionId: 3, agentId: 'agent-3' });
    internals(orchestrator).activeExecutions.set(3, state);
    internals(orchestrator).activeAgents.set(3, makeActiveAgentInfo({ executionId: 3 }));
    getAgentMock.mockReturnValue({ stop: () => Promise.reject(new Error('stop failed')) });

    const result = await orchestrator.stopExecution(3);

    expect(result).toBe(true);
    expect(mockPrisma.agentExecution.update).toHaveBeenCalledTimes(1);
    expect(internals(orchestrator).activeExecutions.has(3)).toBe(false);
  });

  test('BUG FIX: a DB update failure still cleans up in-memory state instead of leaving a stuck execution', async () => {
    // Regression test for agent-orchestrator.ts:330 — previously the
    // prisma.agentExecution.update() call was not wrapped in try/catch, so a
    // transient DB failure left activeExecutions/activeAgents permanently
    // stale for an execution whose agent process was already stopped.
    const orchestrator = getOrchestrator();
    const state = makeExecutionState({ executionId: 6, agentId: 'agent-6' });
    internals(orchestrator).activeExecutions.set(6, state);
    internals(orchestrator).activeAgents.set(6, makeActiveAgentInfo({ executionId: 6 }));
    const agentStop = mock(async () => {
      expect(state.status).toBe('cancelled');
    });
    getAgentMock.mockReturnValue({ stop: agentStop });
    mockPrisma.agentExecution.update.mockImplementationOnce(() =>
      Promise.reject(new Error('db down')),
    );

    const result = await orchestrator.stopExecution(6);

    expect(result).toBe(true);
    expect(agentStop).toHaveBeenCalledTimes(1);
    expect(internals(orchestrator).activeExecutions.has(6)).toBe(false);
    expect(internals(orchestrator).activeAgents.has(6)).toBe(false);
    expect(removeAgentMock).toHaveBeenCalledWith('agent-6');
  });

  test('cancels the question timeout and releases the continuation lock unconditionally', async () => {
    const orchestrator = getOrchestrator();
    orchestrator.startQuestionTimeout(4, 100);
    orchestrator.tryAcquireContinuationLock(4, 'user_response');

    await orchestrator.stopExecution(4);

    expect(orchestrator.getQuestionTimeoutInfo(4)).toBeNull();
    expect(orchestrator.hasContinuationLock(4)).toBe(false);
  });
});

describe('stopAllForTasks', () => {
  test('stops only executions whose taskId is in the given set', async () => {
    const orchestrator = getOrchestrator();
    internals(orchestrator).activeExecutions.set(
      10,
      makeExecutionState({ executionId: 10, taskId: 1 }),
    );
    internals(orchestrator).activeAgents.set(
      10,
      makeActiveAgentInfo({ executionId: 10, taskId: 1 }),
    );
    internals(orchestrator).activeExecutions.set(
      11,
      makeExecutionState({ executionId: 11, taskId: 2 }),
    );
    internals(orchestrator).activeAgents.set(
      11,
      makeActiveAgentInfo({ executionId: 11, taskId: 2 }),
    );
    getAgentMock.mockReturnValue({ stop: () => Promise.resolve() });

    const stopped = await orchestrator.stopAllForTasks(new Set([1]));

    expect(stopped).toEqual([10]);
    expect(internals(orchestrator).activeAgents.has(10)).toBe(false);
    expect(internals(orchestrator).activeAgents.has(11)).toBe(true);
  });

  test('returns an empty array when no in-memory agent matches the given task IDs', async () => {
    const orchestrator = getOrchestrator();

    const stopped = await orchestrator.stopAllForTasks(new Set([12345]));

    expect(stopped).toEqual([]);
  });

  test('continues sweeping remaining executions even if one stopExecution rejects', async () => {
    const orchestrator = getOrchestrator();
    internals(orchestrator).activeExecutions.set(
      20,
      makeExecutionState({ executionId: 20, taskId: 5 }),
    );
    internals(orchestrator).activeAgents.set(
      20,
      makeActiveAgentInfo({ executionId: 20, taskId: 5 }),
    );
    internals(orchestrator).activeExecutions.set(
      21,
      makeExecutionState({ executionId: 21, taskId: 5 }),
    );
    internals(orchestrator).activeAgents.set(
      21,
      makeActiveAgentInfo({ executionId: 21, taskId: 5 }),
    );
    // Make the DB update reject for the first sweep only, simulating a
    // transient failure while stopping one of two same-task executions.
    mockPrisma.agentExecution.update
      .mockImplementationOnce(() => Promise.reject(new Error('db down')))
      .mockImplementationOnce(() => Promise.resolve({}));
    getAgentMock.mockReturnValue({ stop: () => Promise.resolve() });

    const stopped = await orchestrator.stopAllForTasks(new Set([5]));

    // Both are recorded as "stopped" from stopAllForTasks's perspective —
    // the per-execution failure is caught via `.catch(() => {})` — but both
    // executions must still have been swept from in-memory maps.
    expect(stopped).toEqual([20, 21]);
    expect(internals(orchestrator).activeAgents.size).toBe(0);
  });
});
