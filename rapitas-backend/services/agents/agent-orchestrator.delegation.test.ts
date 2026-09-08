/**
 * agent-orchestrator.delegation.test
 *
 * Covers the facade's pass-through methods (execution, continuation,
 * recovery, git operations) — verifying each forwards to the correct
 * sub-module with a correctly-shaped OrchestratorContext, and returns/
 * propagates its result — plus buildAgentConfigFromDb(), the one method
 * with real logic left in the facade (API key decryption + the
 * skipAgentPermissionPrompts default-true fallback).
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// ── Module-level mocks (declared before the dynamic import) ────────────────

mock.module('../../config/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  getBackendLogFilePath: (stamp?: string) => `/mock/backend-${stamp ?? 'today'}.log`,
}));

const resolveStoredSecretMock = mock((v: string | null | undefined) =>
  v ? `decrypted:${v}` : null,
);
mock.module('../../utils/common/secret-store', () => ({
  isKeychainSecretRef: () => false,
  saveProviderApiKey: () => '',
  saveAgentApiKey: () => '',
  saveSecret: () => '',
  resolveStoredSecret: resolveStoredSecretMock,
  deleteStoredSecret: () => {},
  maskStoredSecret: () => null,
}));

const narrowAgentTypeMock = mock((s: string | null | undefined) => s ?? 'claude-code');
mock.module('./agent-factory', () => ({
  AGENT_TYPES: ['claude-code', 'codex', 'gemini', 'custom'],
  isAgentType: (s: unknown) => typeof s === 'string',
  narrowAgentType: narrowAgentTypeMock,
  AgentFactory: class {
    static getInstance() {
      return {
        createAgent: () => ({ stop: () => Promise.resolve() }),
        getAgent: () => undefined,
        removeAgent: () => Promise.resolve(true),
      };
    }
  },
  agentFactory: {
    createAgent: () => ({ stop: () => Promise.resolve() }),
    getAgent: () => undefined,
    removeAgent: () => Promise.resolve(true),
    getAllActiveAgents: () => new Map(),
    getRegisteredAgents: () => [],
    getAvailableAgents: () => Promise.resolve([]),
    getAgentsByCapability: () => [],
    createDefaultAgent: () => ({ stop: () => Promise.resolve() }),
  },
}));

const gitOpsMocks = {
  getGitDiff: mock((_wd: string) => Promise.resolve('diff-result')),
  getFullGitDiff: mock((_wd: string) => Promise.resolve('full-diff-result')),
  commitChanges: mock((_wd: string, _msg: string, _title?: string) =>
    Promise.resolve({ success: true, commitHash: 'abc123' }),
  ),
  createPullRequest: mock((_wd: string, _title: string, _body: string, _base?: string) =>
    Promise.resolve({ success: true, prUrl: 'https://pr' }),
  ),
  mergePullRequest: mock((_wd: string, _pr: number, _threshold?: number, _base?: string) =>
    Promise.resolve({ success: true, mergeStrategy: 'squash' as const }),
  ),
  revertChanges: mock((_wd: string) => Promise.resolve(true)),
  createBranch: mock((_wd: string, _name: string) => Promise.resolve(true)),
  createWorktree: mock((..._args: unknown[]) => Promise.resolve('/tmp/worktree')),
  removeWorktree: mock((..._args: unknown[]) => Promise.resolve(true)),
  cleanupStaleWorktrees: mock((..._args: unknown[]) => Promise.resolve(3)),
  createCommit: mock((..._args: unknown[]) =>
    Promise.resolve({ hash: 'h1', branch: 'main', filesChanged: 2, additions: 5, deletions: 1 }),
  ),
  getDiff: mock((..._args: unknown[]) =>
    Promise.resolve([{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0 }]),
  ),
};

mock.module('./orchestrator/git-operations', () => ({
  GitOperations: class {
    getGitDiff = gitOpsMocks.getGitDiff;
    getFullGitDiff = gitOpsMocks.getFullGitDiff;
    commitChanges = gitOpsMocks.commitChanges;
    createPullRequest = gitOpsMocks.createPullRequest;
    mergePullRequest = gitOpsMocks.mergePullRequest;
    revertChanges = gitOpsMocks.revertChanges;
    createBranch = gitOpsMocks.createBranch;
    createWorktree = gitOpsMocks.createWorktree;
    removeWorktree = gitOpsMocks.removeWorktree;
    cleanupStaleWorktrees = gitOpsMocks.cleanupStaleWorktrees;
    createCommit = gitOpsMocks.createCommit;
    getDiff = gitOpsMocks.getDiff;
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
  removeWorktree: mock(() => Promise.resolve(true)),
  cleanupStaleWorktrees: mock(() => Promise.resolve(0)),
}));

mock.module('./orchestrator/lifecycle-manager', () => ({
  setupSignalHandlers: mock(() => {}),
  gracefulShutdown: mock(() => Promise.resolve()),
  saveAllAgentStates: mock(() => Promise.resolve()),
  saveAgentState: mock(() => Promise.resolve()),
}));

const FAKE_RESULT = {
  success: true,
  output: 'ok',
  artifacts: [],
  commits: [],
  executionTimeMs: 1,
  waitingForInput: false,
};

const executeTaskMock = mock((..._args: unknown[]) => Promise.resolve(FAKE_RESULT));
mock.module('./orchestrator/task-executor', () => ({
  executeTask: executeTaskMock,
  autoCompleteTaskDurable: mock(() => Promise.resolve()),
}));

const executeContinuationMock = mock((..._args: unknown[]) => Promise.resolve(FAKE_RESULT));
const executeContinuationWithLockMock = mock((..._args: unknown[]) => Promise.resolve(FAKE_RESULT));
mock.module('./orchestrator/continuation-executor', () => ({
  executeContinuation: executeContinuationMock,
  executeContinuationWithLock: executeContinuationWithLockMock,
  executeContinuationInternal: mock(() => Promise.resolve(FAKE_RESULT)),
  handleQuestionTimeout: mock(() => Promise.resolve()),
}));

const getInterruptedExecutionsMock = mock((_prisma: unknown) => Promise.resolve([{ id: 1 }]));
const recoverStaleExecutionsMock = mock((_ctx: unknown) =>
  Promise.resolve({ recovered: 2, failed: 0 }),
);
const resumeInterruptedExecutionMock = mock((..._args: unknown[]) => Promise.resolve(FAKE_RESULT));
mock.module('./orchestrator/recovery-manager', () => ({
  getInterruptedExecutions: getInterruptedExecutionsMock,
  recoverStaleExecutions: recoverStaleExecutionsMock,
  resumeInterruptedExecution: resumeInterruptedExecutionMock,
  buildResumePrompt: mock(() => ''),
  // NOTE: execution-lease exports added by f996dff5 — bun mock.module replaces
  // the WHOLE module, so omitting them breaks agent-orchestrator's import
  // (task 600).
  startExecutionLeaseSweep: mock(() => {}),
  sweepDeadLeaseExecutions: mock(() => Promise.resolve({ recovered: 0 })),
}));

const { AgentOrchestrator } = await import('./agent-orchestrator');

import type { AgentTask } from './base-agent';
import type { ExecutionOptions, OrchestratorContext } from './orchestrator/types';

const mockPrisma = {
  agentExecution: { update: mock(() => Promise.resolve({})) },
  userSettings: {
    findFirst: mock(() => Promise.resolve(null as { skipAgentPermissionPrompts: boolean } | null)),
  },
};

function getOrchestrator() {
  return AgentOrchestrator.getInstance(
    mockPrisma as unknown as Parameters<typeof AgentOrchestrator.getInstance>[0],
  );
}

const MINIMAL_TASK: AgentTask = { id: 1, title: 'test task' };
const MINIMAL_OPTS: ExecutionOptions = { taskId: 1, sessionId: 1 };

beforeEach(() => {
  executeTaskMock.mockClear();
  executeContinuationMock.mockClear();
  executeContinuationWithLockMock.mockClear();
  getInterruptedExecutionsMock.mockClear();
  recoverStaleExecutionsMock.mockClear();
  resumeInterruptedExecutionMock.mockClear();
  resolveStoredSecretMock.mockClear();
  mockPrisma.userSettings.findFirst.mockClear();
  mockPrisma.userSettings.findFirst.mockResolvedValue(null);
  Object.values(gitOpsMocks).forEach((m) => m.mockClear());
});

describe('executeTask', () => {
  test('forwards task/options and returns the sub-module result', async () => {
    const orchestrator = getOrchestrator();

    const result = await orchestrator.executeTask(MINIMAL_TASK, MINIMAL_OPTS);

    expect(result).toBe(FAKE_RESULT);
    expect(executeTaskMock).toHaveBeenCalledTimes(1);
    const [ctx, task, options] = executeTaskMock.mock.calls[0] as unknown as [
      OrchestratorContext,
      AgentTask,
      ExecutionOptions,
    ];
    expect(task).toBe(MINIMAL_TASK);
    expect(options).toBe(MINIMAL_OPTS);
    expect(ctx.prisma).toBe(mockPrisma);
    expect(ctx.isShuttingDown).toBe(false);
  });

  test('the context reflects isShuttingDown=true once the latch is set', async () => {
    const orchestrator = getOrchestrator();
    const state = orchestrator as unknown as {
      _isShuttingDown: boolean;
      _shuttingDownSince: number | null;
    };
    state._isShuttingDown = true;
    state._shuttingDownSince = Date.now();

    await orchestrator.executeTask(MINIMAL_TASK, MINIMAL_OPTS);

    const [ctx] = executeTaskMock.mock.calls.at(-1) as unknown as [OrchestratorContext];
    expect(ctx.isShuttingDown).toBe(true);

    (orchestrator as unknown as { _isShuttingDown: boolean })._isShuttingDown = false;
    (orchestrator as unknown as { _shuttingDownSince: number | null })._shuttingDownSince = null;
  });
});

describe('executeContinuation / executeContinuationWithLock', () => {
  test('executeContinuation forwards executionId/response/options', async () => {
    const orchestrator = getOrchestrator();

    const result = await orchestrator.executeContinuation(7, 'my response', { timeout: 100 });

    expect(result).toBe(FAKE_RESULT);
    expect(executeContinuationMock).toHaveBeenCalledWith(expect.anything(), 7, 'my response', {
      timeout: 100,
    });
  });

  test('executeContinuationWithLock forwards executionId/response/options', async () => {
    const orchestrator = getOrchestrator();

    const result = await orchestrator.executeContinuationWithLock(8, 'locked response');

    expect(result).toBe(FAKE_RESULT);
    expect(executeContinuationWithLockMock).toHaveBeenCalledWith(
      expect.anything(),
      8,
      'locked response',
      {},
    );
  });
});

describe('recovery delegation', () => {
  test('getInterruptedExecutions forwards prisma directly (not the full context)', async () => {
    const orchestrator = getOrchestrator();

    const result = await orchestrator.getInterruptedExecutions();

    expect(result).toEqual([{ id: 1 }]);
    expect(getInterruptedExecutionsMock).toHaveBeenCalledWith(mockPrisma);
  });

  test('recoverStaleExecutions forwards the built context', async () => {
    const orchestrator = getOrchestrator();

    const result = await orchestrator.recoverStaleExecutions();

    expect(result).toEqual({ recovered: 2, failed: 0 });
    expect(recoverStaleExecutionsMock).toHaveBeenCalledTimes(1);
  });

  test('resumeInterruptedExecution forwards executionId and options', async () => {
    const orchestrator = getOrchestrator();

    const result = await orchestrator.resumeInterruptedExecution(9, { timeout: 50 });

    expect(result).toBe(FAKE_RESULT);
    expect(resumeInterruptedExecutionMock).toHaveBeenCalledWith(expect.anything(), 9, {
      timeout: 50,
    });
  });
});

describe('git operations delegation', () => {
  test('getGitDiff / getFullGitDiff delegate to GitOperations with the working directory', async () => {
    const orchestrator = getOrchestrator();

    await expect(orchestrator.getGitDiff('/repo')).resolves.toBe('diff-result');
    await expect(orchestrator.getFullGitDiff('/repo')).resolves.toBe('full-diff-result');
    expect(gitOpsMocks.getGitDiff).toHaveBeenCalledWith('/repo');
    expect(gitOpsMocks.getFullGitDiff).toHaveBeenCalledWith('/repo');
  });

  test('commitChanges delegates with message and optional task title', async () => {
    const orchestrator = getOrchestrator();

    const result = await orchestrator.commitChanges('/repo', 'fix: bug', 'Task 42');

    expect(result).toEqual({ success: true, commitHash: 'abc123' });
    expect(gitOpsMocks.commitChanges).toHaveBeenCalledWith('/repo', 'fix: bug', 'Task 42');
  });

  test('createPullRequest and mergePullRequest delegate with all arguments', async () => {
    const orchestrator = getOrchestrator();

    await orchestrator.createPullRequest('/repo', 'title', 'body', 'develop');
    await orchestrator.mergePullRequest('/repo', 42, 3, 'develop');

    // NOTE: headBranch (5th arg, task 597) and draft (6th arg, task 874) are
    // undefined when the caller does not pin them (legacy 4-arg call sites).
    expect(gitOpsMocks.createPullRequest).toHaveBeenCalledWith(
      '/repo',
      'title',
      'body',
      'develop',
      undefined,
      undefined,
    );
    expect(gitOpsMocks.mergePullRequest).toHaveBeenCalledWith('/repo', 42, 3, 'develop');
  });

  test('mergePullRequest applies its default commitThreshold and baseBranch', async () => {
    const orchestrator = getOrchestrator();

    await orchestrator.mergePullRequest('/repo', 42);

    expect(gitOpsMocks.mergePullRequest).toHaveBeenCalledWith('/repo', 42, 5, 'master');
  });

  test('revertChanges, createBranch, createCommit, getDiff delegate correctly', async () => {
    const orchestrator = getOrchestrator();

    await expect(orchestrator.revertChanges('/repo')).resolves.toBe(true);
    await expect(orchestrator.createBranch('/repo', 'feature/x')).resolves.toBe(true);
    await expect(orchestrator.createCommit('/repo', 'msg')).resolves.toEqual({
      hash: 'h1',
      branch: 'main',
      filesChanged: 2,
      additions: 5,
      deletions: 1,
    });
    await expect(orchestrator.getDiff('/repo')).resolves.toEqual([
      { filename: 'a.ts', status: 'modified', additions: 1, deletions: 0 },
    ]);
  });

  test('worktree lifecycle methods delegate with all arguments', async () => {
    const orchestrator = getOrchestrator();

    await orchestrator.createWorktree('/base', 'branch', 42, 'https://repo.git', 'develop');
    await expect(orchestrator.removeWorktree('/base', '/base/wt-42')).resolves.toBe(true);
    await expect(orchestrator.cleanupStaleWorktrees('/base')).resolves.toBe(3);

    expect(gitOpsMocks.createWorktree).toHaveBeenCalledWith(
      '/base',
      'branch',
      42,
      'https://repo.git',
      'develop',
    );
    expect(gitOpsMocks.removeWorktree).toHaveBeenCalledWith('/base', '/base/wt-42');
    // NOTE: keepPaths (2nd arg, default []) added by ddb4bd89 (worktree keep-list
    // protection) — the delegation always forwards it (task 600).
    expect(gitOpsMocks.cleanupStaleWorktrees).toHaveBeenCalledWith('/base', []);
  });

  test('removeWorktree returns false when the underlying git operation refuses/fails', async () => {
    const orchestrator = getOrchestrator();
    gitOpsMocks.removeWorktree.mockResolvedValueOnce(false);

    await expect(orchestrator.removeWorktree('/base', '/base/wt-42')).resolves.toBe(false);
  });
});

describe('buildAgentConfigFromDb (captured via executeTask context)', () => {
  async function captureBuildAgentConfig() {
    const orchestrator = getOrchestrator();
    await orchestrator.executeTask(MINIMAL_TASK, MINIMAL_OPTS);
    const [ctx] = executeTaskMock.mock.calls.at(-1) as unknown as [OrchestratorContext];
    return ctx.buildAgentConfigFromDb;
  }

  const DB_CONFIG = {
    id: 1,
    agentType: 'claude-code',
    name: 'My Agent',
    apiKeyEncrypted: null as string | null,
    endpoint: null as string | null,
    modelId: null as string | null,
  };

  test('decrypts an encrypted API key via resolveStoredSecret', async () => {
    const build = await captureBuildAgentConfig();

    const config = await build({ ...DB_CONFIG, apiKeyEncrypted: 'cipher-text' }, {});

    expect(resolveStoredSecretMock).toHaveBeenCalledWith('cipher-text');
    expect(config.apiKey).toBe('decrypted:cipher-text');
  });

  test('leaves apiKey undefined when apiKeyEncrypted is null', async () => {
    const build = await captureBuildAgentConfig();

    const config = await build(DB_CONFIG, {});

    expect(resolveStoredSecretMock).not.toHaveBeenCalled();
    expect(config.apiKey).toBeUndefined();
  });

  test('swallows a decryption failure and leaves apiKey undefined', async () => {
    const build = await captureBuildAgentConfig();
    resolveStoredSecretMock.mockImplementationOnce(() => {
      throw new Error('decrypt failed');
    });

    const config = await build({ ...DB_CONFIG, apiKeyEncrypted: 'bad-cipher' }, {});

    expect(config.apiKey).toBeUndefined();
  });

  test('defaults skipAgentPermissionPrompts (dangerouslySkipPermissions/yoloMode) to true when the settings row is missing', async () => {
    mockPrisma.userSettings.findFirst.mockResolvedValueOnce(null);
    const build = await captureBuildAgentConfig();

    const config = await build(DB_CONFIG, {});

    expect(config.dangerouslySkipPermissions).toBe(true);
    expect(config.yoloMode).toBe(true);
  });

  test('honors an explicit skipAgentPermissionPrompts=false from user settings', async () => {
    mockPrisma.userSettings.findFirst.mockResolvedValueOnce({ skipAgentPermissionPrompts: false });
    const build = await captureBuildAgentConfig();

    const config = await build(DB_CONFIG, {});

    expect(config.dangerouslySkipPermissions).toBe(false);
    expect(config.yoloMode).toBe(false);
  });

  test('forwards workingDirectory/timeout options and narrows the agent type', async () => {
    narrowAgentTypeMock.mockClear();
    const build = await captureBuildAgentConfig();

    const config = await build(
      { ...DB_CONFIG, agentType: 'gemini', endpoint: 'https://ep', modelId: 'model-x' },
      { workingDirectory: '/wd', timeout: 5000 },
    );

    expect(narrowAgentTypeMock).toHaveBeenCalledWith('gemini');
    expect(config.workingDirectory).toBe('/wd');
    expect(config.timeout).toBe(5000);
    expect(config.endpoint).toBe('https://ep');
    expect(config.modelId).toBe('model-x');
    expect(config.name).toBe('My Agent');
  });
});
