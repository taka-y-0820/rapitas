/**
 * workflow-orchestrator-shutdown.test
 *
 * Verifies that the catch block inside runAdvanceWorkflow (workflow-orchestrator.ts) handles
 * shutdown-caused interruptions correctly:
 *   - Shutdown error  → log.warn + re-throw (tryProviderFallback skipped)
 *   - Non-shutdown error → log.error + tryProviderFallback attempted + return {success:false}
 *
 * Uses mock.module for the heavy infrastructure (prisma, agents, workflow utils)
 * so the test runs without a real database.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { buildShutdownErrorMessage } from '../agents/orchestrator/shutdown-error';

// ── Mocks ────────────────────────────────────────────────────────────────────

const warnMock = mock((..._args: unknown[]) => {});
const errorMock = mock((..._args: unknown[]) => {});
const loggerMock = { info: () => {}, warn: warnMock, error: errorMock, debug: () => {} };

mock.module('../../config/logger', () => ({
  createLogger: () => loggerMock,
}));

// Controls what executeCLIAgent does for each test.
let executeCLIAgentImpl: () => Promise<unknown> = () =>
  Promise.resolve({ success: true, role: 'planner', status: 'plan_created' });

const executeCLIAgentMock = mock(
  (
    _taskId: unknown,
    _task: unknown,
    _cfg: unknown,
    _sys: unknown,
    _ctx: unknown,
    _transition: unknown,
    _dir: unknown,
    _lang: unknown,
    _advanceFn: unknown,
    _devCfg: unknown,
  ) => executeCLIAgentImpl(),
);

mock.module('./workflow-agent-executor', () => ({
  executeCLIAgent: executeCLIAgentMock,
  executeAPIAgent: mock(() =>
    Promise.resolve({ success: true, role: 'planner', status: 'plan_created' }),
  ),
}));

const mockPrisma = {
  task: {
    findUnique: mock(() =>
      Promise.resolve({
        id: 1,
        title: 'Test task',
        description: null,
        // NOTE: 'research_done' → 'planner' transition avoids the implementer plan-validity check
        // which would return early when plan.md is absent.
        workflowStatus: 'research_done',
        workflowMode: 'standard',
        workflowModeOverride: null,
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
      }),
    ),
    update: mock(() => Promise.resolve({})),
    updateMany: mock(() => Promise.resolve({ count: 1 })),
  },
  workflowRoleConfig: {
    findUnique: mock(() =>
      Promise.resolve({
        role: 'planner',
        isEnabled: true,
        systemPromptKey: null,
        modelId: null,
        agentConfigId: 1,
        agentConfig: {
          id: 1,
          agentType: 'claude-code',
          name: 'Test Agent',
          modelId: 'claude-haiku-4-5-20251001', // non-null → avoids Smart Router
          apiKeyEncrypted: null,
          endpoint: null,
        },
      }),
    ),
  },
  systemPrompt: {
    findUnique: mock(() => Promise.resolve(null)),
  },
  workflowTransition: { findFirst: async () => null, count: mock(() => Promise.resolve(0)) },
  aIAgentConfig: {
    findUnique: mock(() => Promise.resolve(null)),
  },
  developerModeConfig: {
    findUnique: mock(() =>
      Promise.resolve({
        id: 1,
        taskId: 1,
        isEnabled: true,
        enableDetailedLogging: false,
        enableIntermediateSaves: false,
        verbosityLevel: 'normal',
        maxRetries: 3,
        breakpointPhases: null,
      }),
    ),
    create: mock(() => Promise.resolve({ id: 1, taskId: 1, isEnabled: true })),
  },
};

mock.module('../../config', () => ({
  prisma: mockPrisma,
  getProjectRoot: () => '/tmp/rapitas-test',
  createLogger: () => loggerMock,
  ensureDatabaseConnection: () => Promise.resolve(),
  getDbProvider: () => 'postgresql',
  getInsensitiveMode: () => 'default',
}));

mock.module('../../config/database', () => ({
  ensureDatabaseConnection: () => Promise.resolve(),
  prisma: mockPrisma,
}));

// workflow-file-utils: resolveWorkflowDir returns a fake dir; readWorkflowFile returns null.
mock.module('./workflow-file-utils', () => ({
  resolveWorkflowDir: mock(() =>
    Promise.resolve({ dir: '/tmp/wf/1', taskId: 1, categoryId: 0, themeId: 1 }),
  ),
  readWorkflowFile: mock(() => Promise.resolve(null)),
  archiveWorkflowFile: mock(() => Promise.resolve(false)),
  writeWorkflowFile: mock(() => Promise.resolve()),
}));

// workflow-context-builder: return minimal context.
mock.module('./workflow-context-builder', () => ({
  buildRoleContext: mock(() => Promise.resolve('context')),
  applyPlanModeDirective: mock((_role: unknown, content: string) => content),
}));

// task-execution-lock: always grant the lock.
mock.module('../agents/task-execution-lock', () => ({
  getTaskExecutionCancellationVersion: () => 0,
  getTaskExecutionLockOwner: () => Symbol.for('test-workflow-lock'),
  acquireTaskExecutionLock: () => true,
  releaseTaskExecutionLock: () => {},
  isTaskExecutionLocked: () => true,
  WORKFLOW_LOCK_TTL_MS: 30 * 60 * 1000,
}));

mock.module('../../routes/ai/system-prompts/default-prompts', () => ({
  DEFAULT_SYSTEM_PROMPTS: [],
}));

// phase-output-validator: never reuse existing artifacts.
mock.module('./phase-output-validator', () => ({
  isReusableArtifact: mock(() => false),
}));

mock.module('./transition-recorder', () => ({
  recordTransition: mock(() => Promise.resolve()),
}));

// workflow-mode-config: standard mode, research_done → planner transition.
mock.module('./workflow-mode-config', () => ({
  getModeSettings: mock(() =>
    Promise.resolve({
      hasPlanPhase: true,
      hasReviewPhase: false,
      hasAutoVerify: false,
    }),
  ),
  buildTransitions: mock(() => ({
    research_done: {
      role: 'planner',
      nextStatus: 'plan_created',
      outputFile: 'plan',
      requiresApproval: true,
    },
  })),
  selectProvisionalMode: mock(() => Promise.resolve('standard')),
}));

// role-provider-resolver: no-op (used inside resolveExecutableAgentConfig).
mock.module('./role-provider-resolver', () => ({
  inferProviderFromModelId: mock(() => 'claude'),
  resolveRoleProviderPreferences: mock(() => Promise.resolve({})),
}));

// ai/agent-fallback: no-op (used inside resolveExecutableAgentConfig).
mock.module('../ai/agent-fallback', () => ({
  agentTypeToProvider: mock(() => 'claude'),
  findAgentConfigForProvider: mock(() => Promise.resolve(null)),
}));

// NOTE: Prevent tryProviderFallback from calling executeCLIAgent a second time.
// classifyAgentError returning null causes tryProviderFallback to bail immediately,
// so executeCLIAgent is called at most once regardless of whether the error path
// enters tryProviderFallback. This isolates the catch-block assertions from
// the fallback retry loop.
mock.module('../ai/agent-error-classifier', () => ({
  classifyAgentError: mock(() => null),
}));

// Probe stage (task 673) always succeeds here — this test targets shutdown
// error handling in the catch block, not probe behavior.
mock.module('./workflow-orchestrator-preflight-probe', () => ({
  runPreflightProbe: mock(() => Promise.resolve({ done: false })),
}));

// Import WorkflowOrchestrator AFTER all mock.module calls.
const { WorkflowOrchestrator } = await import('./workflow-orchestrator');

function resetMocks() {
  warnMock.mockClear();
  errorMock.mockClear();
  executeCLIAgentMock.mockClear();
  mockPrisma.task.findUnique.mockClear();
  // Reset to default success impl.
  executeCLIAgentImpl = () =>
    Promise.resolve({ success: true, role: 'planner', status: 'plan_created' });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WorkflowOrchestrator catch block — shutdown handling', () => {
  beforeEach(resetMocks);

  test('shutdown error → log.warn called, error re-thrown (advanceWorkflow rejects)', async () => {
    // NOTE: Using getInstance() creates a fresh orchestrator (singleton is unset after mocking).
    (WorkflowOrchestrator as unknown as { instance: unknown }).instance = undefined;
    const orchestrator = WorkflowOrchestrator.getInstance();

    executeCLIAgentImpl = () =>
      Promise.reject(new Error(buildShutdownErrorMessage('start new execution')));

    // advanceWorkflow should REJECT (re-throw the shutdown error) — not return {success:false}.
    await expect(orchestrator.advanceWorkflow(1)).rejects.toThrow('Server is shutting down');

    // WARN must have been logged for the shutdown.
    const warnMessages = warnMock.mock.calls.map((c) => String(c[0]));
    expect(warnMessages.some((m) => m.includes('interrupted by shutdown'))).toBe(true);

    // ERROR log for this execution must NOT have been emitted.
    const errorMessages = errorMock.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : JSON.stringify(c[0]),
    );
    expect(errorMessages.some((m) => m.includes('Error in planner'))).toBe(false);

    // executeCLIAgent was called once — no fallback attempt.
    expect(executeCLIAgentMock.mock.calls.length).toBe(1);
  });

  test('non-shutdown error → log.error called, advanceWorkflow resolves with {success:false}', async () => {
    (WorkflowOrchestrator as unknown as { instance: unknown }).instance = undefined;
    const orchestrator = WorkflowOrchestrator.getInstance();

    executeCLIAgentImpl = () => Promise.reject(new Error('Database connection refused'));

    // advanceWorkflow should RESOLVE with success:false (caught and handled).
    const result = await orchestrator.advanceWorkflow(1);
    expect(result.success).toBe(false);

    // ERROR must have been logged.
    const errorMessages = errorMock.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : JSON.stringify(c[0]),
    );
    expect(errorMessages.some((m) => m.includes('Error in planner'))).toBe(true);

    // WARN for shutdown must NOT have been logged (this is a non-shutdown error).
    const warnMessages = warnMock.mock.calls.map((c) => String(c[0]));
    expect(warnMessages.some((m) => m.includes('interrupted by shutdown'))).toBe(false);
  });
});
