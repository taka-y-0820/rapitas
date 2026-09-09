/**
 * workflow-orchestrator-probe-integration.test
 *
 * Integration coverage for the preflight probe stage wired into
 * WorkflowOrchestrator.runAdvanceWorkflow (task 673): a successful probe
 * leaves the existing research-phase dispatch flow unchanged (regression),
 * while a permanent probe failure stops the transition BEFORE
 * guardPlanValidity/buildExecutionContext/executeAgentWithFallback ever run.
 * Exercises the REAL runPreflightProbe — only its leaf dependencies (retry
 * execution and alerting) are mocked, unlike workflow-orchestrator-preflight-
 * probe.test.ts which mocks runPreflightProbe's direct collaborators in
 * isolation.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: 'Test task',
    description: null,
    workflowStatus: 'draft',
    workflowMode: 'standard',
    workflowModeOverride: 'standard',
    status: 'in-progress',
    parentId: null,
    themeId: 1,
    complexityScore: 70,
    autoApprovePlan: false,
    estimatedHours: null,
    priority: null,
    labels: null,
    goals: null,
    constraints: null,
    acceptanceCriteria: null,
    theme: { id: 1, workingDirectory: '/tmp', category: { id: 1 } },
    ...overrides,
  };
}

const taskFindUniqueMock = mock(() => Promise.resolve(makeTask()));
const taskUpdateMock = mock(() => Promise.resolve({}));
const roleConfigFindUniqueMock = mock(() =>
  Promise.resolve({
    role: 'researcher',
    isEnabled: true,
    systemPromptKey: null,
    modelId: null,
    agentConfigId: 1,
    agentConfig: {
      id: 1,
      agentType: 'claude-code',
      name: 'Test Agent',
      modelId: 'claude-haiku-4-5-20251001',
      apiKeyEncrypted: null,
      endpoint: null,
    },
  }),
);

const mockPrisma = {
  task: { findUnique: taskFindUniqueMock, update: taskUpdateMock },
  workflowRoleConfig: { findUnique: roleConfigFindUniqueMock },
  systemPrompt: { findUnique: mock(() => Promise.resolve(null)) },
  workflowTransition: { findFirst: async () => null, count: mock(() => Promise.resolve(0)) },
  workflowFile: { findFirst: mock(() => Promise.resolve(null)) },
};

mock.module('../../config/logger', () => ({
  logger: noopLogger,
  createLogger: () => noopLogger,
}));
mock.module('../../config', () => ({
  prisma: mockPrisma,
  ensureDatabaseConnection: () => Promise.resolve(),
  logger: noopLogger,
  createLogger: () => noopLogger,
  getDbProvider: () => 'postgresql',
  getInsensitiveMode: () => ({}),
  getProjectRoot: () => '/tmp/rapitas-test',
}));
mock.module('../../config/database', () => ({
  prisma: mockPrisma,
  ensureDatabaseConnection: () => Promise.resolve(),
}));
mock.module('./workflow-file-utils', () => ({
  resolveWorkflowDir: mock(() =>
    Promise.resolve({ dir: '/tmp/wf/1', taskId: 1, categoryId: 0, themeId: 1 }),
  ),
  readWorkflowFile: mock(() => Promise.resolve(null)),
  writeWorkflowFile: mock(() => Promise.resolve()),
  archiveWorkflowFile: mock(() => Promise.resolve(false)),
  cleanupRootWorkflowFiles: mock(() => Promise.resolve()),
  extractMarkdownFromOutput: mock(() => null),
}));
const contextMock = mock(() => Promise.resolve('context'));
mock.module('./workflow-context-builder', () => ({
  buildRoleContext: contextMock,
  researchModeDirective: mock(() => ''),
  applyPlanModeDirective: mock((_role: unknown, content: string) => content),
}));
const executeCLIAgentMock = mock(() =>
  Promise.resolve({ success: true, role: 'researcher', status: 'research_done' }),
);
mock.module('./workflow-agent-executor', () => ({
  executeCLIAgent: executeCLIAgentMock,
  executeAPIAgent: mock(() =>
    Promise.resolve({ success: true, role: 'researcher', status: 'research_done' }),
  ),
}));
let lockOwner: symbol | undefined = Symbol();
let cancellationVersion = 0;
const releaseMock = mock((_taskId: number, owner?: symbol) => {
  if (owner === undefined) cancellationVersion++;
  if (owner === undefined || owner === lockOwner) lockOwner = undefined;
});
mock.module('../agents/task-execution-lock', () => ({
  getTaskExecutionCancellationVersion: () => cancellationVersion,
  getTaskExecutionLockOwner: () => lockOwner,
  WORKFLOW_LOCK_TTL_MS: 30 * 60 * 1000,
  acquireTaskExecutionLock: mock(() => true),
  releaseTaskExecutionLock: releaseMock,
  isTaskExecutionLocked: mock(() => true),
}));
mock.module('../../routes/ai/system-prompts/default-prompts', () => ({
  DEFAULT_SYSTEM_PROMPTS: [],
}));
mock.module('./phase-output-validator', () => ({
  looksLogPolluted: mock(() => false),
  isReusableArtifact: mock(() => false),
}));
mock.module('./transition-recorder', () => ({
  recordTransition: mock(() => Promise.resolve()),
}));
mock.module('./workflow-mode-config', () => ({
  getModeSettings: mock(() => Promise.resolve({ includePlan: true, autoVerify: false })),
  buildTransitions: mock(() => ({
    draft: { role: 'researcher', nextStatus: 'research_done', outputFile: 'research' },
  })),
  selectProvisionalMode: mock(() => Promise.resolve('standard')),
}));
mock.module('../intake', () => ({
  ensureIntakeReady: mock(() => Promise.resolve({ status: 'ready' })),
}));
mock.module('./role-provider-resolver', () => ({
  inferProviderFromModelId: mock(() => 'claude'),
  resolveRoleProviderPreferences: mock(() => Promise.resolve({})),
}));
mock.module('../ai/agent-fallback', () => ({
  agentTypeToProvider: mock(() => 'claude'),
  providerToAgentTypes: mock(() => ['claude-code']),
  findAgentConfigForProvider: mock(() => Promise.resolve(null)),
  findFallbackAgentConfig: mock(() => Promise.resolve(null)),
}));

// Probe leaf dependencies only — runPreflightProbe itself runs for real so
// the orchestrator wiring (prep -> probe -> guard) is genuinely exercised.
let probeRetryImpl: () => Promise<{
  outcome: 'success' | 'permanent_failure';
  attempts: number;
  latencyMs: number;
  errorMessage: string | null;
}> = () => Promise.resolve({ outcome: 'success', attempts: 1, latencyMs: 5, errorMessage: null });
const runProbeWithRetryMock = mock(() => probeRetryImpl());
mock.module('./probe/probe-retry', () => ({ runProbeWithRetry: runProbeWithRetryMock }));
mock.module('./probe/probe-cache', () => ({
  getCachedProbeResult: mock(() => null),
  setCachedProbeResult: mock(() => {}),
}));
const alertPermanentProbeFailureMock = mock(() => Promise.resolve());
mock.module('./probe/probe-alert', () => ({
  alertPermanentProbeFailure: alertPermanentProbeFailureMock,
}));
mock.module('../ai/probe-metrics', () => ({ recordProbeAttempt: mock(() => {}) }));

// Import AFTER all mock.module calls.
const { WorkflowOrchestrator } = await import('./workflow-orchestrator');

function resetSingleton() {
  (WorkflowOrchestrator as unknown as { instance: unknown }).instance = undefined;
}

describe('WorkflowOrchestrator — preflight probe integration', () => {
  beforeEach(() => {
    lockOwner = Symbol();
    releaseMock.mockClear();
    contextMock.mockReset().mockResolvedValue('context');
    resetSingleton();
    taskFindUniqueMock.mockClear();
    taskFindUniqueMock.mockImplementation(() => Promise.resolve(makeTask()));
    taskUpdateMock.mockClear();
    executeCLIAgentMock.mockClear();
    runProbeWithRetryMock.mockClear();
    alertPermanentProbeFailureMock.mockClear();
    probeRetryImpl = () =>
      Promise.resolve({ outcome: 'success', attempts: 1, latencyMs: 5, errorMessage: null });
  });

  test('probe success leaves the existing research-phase dispatch flow unchanged', async () => {
    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(true);
    expect(executeCLIAgentMock).toHaveBeenCalledTimes(1);
    expect(alertPermanentProbeFailureMock).not.toHaveBeenCalled();
  });

  test('a deferred next phase is revoked by a stop after normal completion', async () => {
    await WorkflowOrchestrator.getInstance().advanceWorkflow(1);
    const args = executeCLIAgentMock.mock.calls[0] as unknown as unknown[];
    const continuePhase = args[7] as (id: number, language: 'ja' | 'en') => Promise<unknown>;
    expect(typeof continuePhase).toBe('function');
    releaseMock(1);
    await expect(continuePhase(1, 'ja')).rejects.toThrow('continuation cancelled');
    expect(executeCLIAgentMock).toHaveBeenCalledTimes(1);
  });

  test('stop and restart during preflight preparation cannot dispatch the stale phase or unlock its successor', async () => {
    let entered!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    probeRetryImpl = async () => {
      entered();
      await gate;
      return { outcome: 'success', attempts: 1, latencyMs: 5, errorMessage: null };
    };
    const oldOwner = lockOwner;
    const pending = WorkflowOrchestrator.getInstance().advanceWorkflow(1);
    const settled = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.race([
      preparing,
      pending.then(() => {
        throw new Error('phase finished before preparation pause');
      }),
    ]);
    releaseMock(1);
    const replacement = Symbol();
    lockOwner = replacement;
    probeRetryImpl = () =>
      Promise.resolve({ outcome: 'success', attempts: 1, latencyMs: 5, errorMessage: null });
    finish();
    expect(await settled).toBeInstanceOf(Error);
    expect(String(await settled)).toContain('ownership was revoked');
    expect(executeCLIAgentMock).not.toHaveBeenCalled();
    expect(releaseMock).toHaveBeenLastCalledWith(1, oldOwner);
    expect(lockOwner).toBe(replacement);
  });

  test('permanent probe failure stops BEFORE guardPlanValidity/context/execute run', async () => {
    probeRetryImpl = () =>
      Promise.resolve({
        outcome: 'permanent_failure',
        attempts: 3,
        latencyMs: 40,
        errorMessage: 'ECONNREFUSED',
      });

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(false);
    expect(result.status).toBe('draft'); // unchanged — workflowStatus never advanced
    expect(executeCLIAgentMock).not.toHaveBeenCalled();
    expect(alertPermanentProbeFailureMock).toHaveBeenCalledTimes(1);
  });
});
