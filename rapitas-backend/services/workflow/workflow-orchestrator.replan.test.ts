/**
 * workflow-orchestrator.replan.test
 *
 * Covers the implementer plan-validity guard (workflow-orchestrator.ts, the
 * `transition.role === 'implementer' && workflowMode !== 'lightweight'` block):
 *   - lightweight mode has no plan phase, so the guard must be skipped entirely
 *   - a valid plan.md lets the implementer proceed normally
 *   - an invalid/missing plan.md below the replan cap rolls back to 'draft'
 *   - exhausting the cap blocks the task instead of looping (draft→…→rollback forever)
 *
 * A DB-failure variant of the exhausted path (fail-closed count) already lives in
 * workflow-orchestrator-plan-replan.test.ts — this file adds the "clean" (non-error)
 * counter paths so both the below-cap and at-cap branches are covered without
 * relying on a rejected count() query.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: 'Test task',
    description: null,
    workflowStatus: 'plan_approved',
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

const roleConfig = {
  role: 'implementer',
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
};

const taskFindUniqueMock = mock(() => Promise.resolve(makeTask()));
const taskUpdateMock = mock(() => Promise.resolve({}));
const workflowTransitionCountMock = mock(() => Promise.resolve(0));

const mockPrisma = {
  task: {
    findUnique: taskFindUniqueMock,
    update: taskUpdateMock,
    updateMany: mock(() => Promise.resolve({ count: 1 })),
  },
  workflowRoleConfig: { findUnique: mock(() => Promise.resolve(roleConfig)) },
  systemPrompt: { findUnique: mock(() => Promise.resolve(null)) },
  workflowTransition: { findFirst: async () => null, count: workflowTransitionCountMock },
};

mock.module('../../config/logger', () => ({
  getBackendLogFilePath: () => '/tmp/backend.log',
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

let planFileContent: string | null = null;
const archiveWorkflowFileMock = mock(() => Promise.resolve(false));
mock.module('./workflow-file-utils', () => ({
  resolveWorkflowDir: mock(() =>
    Promise.resolve({ dir: '/tmp/wf/1', taskId: 1, categoryId: 0, themeId: 1 }),
  ),
  deleteWorkflowDir: mock(() => Promise.resolve(true)),
  readWorkflowFile: mock(() => Promise.resolve(planFileContent)),
  writeWorkflowFile: mock(() => Promise.resolve()),
  archiveWorkflowFile: archiveWorkflowFileMock,
  cleanupRootWorkflowFiles: mock(() => Promise.resolve()),
  looksLikeAgentLog: mock(() => false),
  sliceFromReportHeading: mock((text: string) => text),
  extractMarkdownFromOutput: mock(() => null),
}));
mock.module('./workflow-context-builder', () => ({
  buildRoleContext: mock(() => Promise.resolve('context')),
  researchModeDirective: mock(() => ''),
  applyPlanModeDirective: mock((_role: unknown, content: string) => content),
}));
const executeCLIAgentMock = mock(() =>
  Promise.resolve({ success: true, role: 'implementer', status: 'verify_done' }),
);
mock.module('./workflow-agent-executor', () => ({
  executeCLIAgent: executeCLIAgentMock,
  executeAPIAgent: mock(() =>
    Promise.resolve({ success: true, role: 'implementer', status: 'verify_done' }),
  ),
}));
mock.module('../agents/task-execution-lock', () => ({
  getTaskExecutionCancellationVersion: () => 0,
  getTaskExecutionLockOwner: () => Symbol.for('test-workflow-lock'),
  DEFAULT_LOCK_TTL_MS: 30 * 60 * 1000,
  WORKFLOW_LOCK_TTL_MS: 30 * 60 * 1000,
  acquireTaskExecutionLock: mock(() => true),
  releaseTaskExecutionLock: mock(() => {}),
  isTaskExecutionLocked: mock(() => true),
}));
mock.module('../../routes/ai/system-prompts/default-prompts', () => ({
  CORE_DEFAULT_PROMPTS: [],
  WORKFLOW_DEFAULT_PROMPTS: [],
  DEFAULT_SYSTEM_PROMPTS: [],
}));
let isPlanReusable = false;
mock.module('./phase-output-validator', () => ({
  looksLogPolluted: mock(() => false),
  validateResearch: mock(() => ({ ok: true })),
  validatePlan: mock(() => ({ ok: true })),
  validateVerify: mock(() => ({ ok: true })),
  isReusableArtifact: mock(() => isPlanReusable),
}));
const recordTransitionMock = mock(() => Promise.resolve());
mock.module('./transition-recorder', () => ({
  recordTransition: recordTransitionMock,
}));
let workflowModeForTest = 'standard';
mock.module('./workflow-mode-config', () => ({
  getModeSettings: mock(() =>
    Promise.resolve({ hasPlanPhase: true, hasReviewPhase: false, hasAutoVerify: false }),
  ),
  buildTransitions: mock(() => ({
    plan_approved: { role: 'implementer', nextStatus: 'verify_done', outputFile: 'verify' },
  })),
  selectProvisionalMode: mock(() => Promise.resolve(workflowModeForTest)),
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
const createNotificationMock = mock(() => Promise.resolve({}));
mock.module('../communication/notification-service', () => ({
  createNotification: createNotificationMock,
}));
const scheduleWorkflowRedispatchMock = mock(() => {});
mock.module('./workflow-redispatch', () => ({
  REDISPATCH_DELAY_MS: 1000,
  scheduleWorkflowRedispatch: scheduleWorkflowRedispatchMock,
}));

// Probe stage (task 673) always succeeds here — these tests exercise the
// implementer plan-validity guard, not probe behavior.
mock.module('./workflow-orchestrator-preflight-probe', () => ({
  runPreflightProbe: mock(() => Promise.resolve({ done: false })),
}));

// Controllable overlap-hold guard (task 802): default not-held so existing
// tests are unaffected; two tests below flip this to prove guardPlanValidity
// now runs BEFORE guardImplementOverlap in workflow-orchestrator.ts.
let overlapHeld = false;
const guardImplementOverlapMock = mock(() =>
  Promise.resolve(
    overlapHeld
      ? {
          done: true as const,
          result: {
            success: true,
            role: 'implementer',
            status: 'plan_approved',
            skipped: true,
            held: 'open auto-PR still changes test.ts',
          },
        }
      : { done: false as const },
  ),
);
mock.module('./workflow-orchestrator-overlap-guard', () => ({
  guardImplementOverlap: guardImplementOverlapMock,
  isImplementOverlapHoldEnabled: () => true,
  isOverlapHeld: () => false,
  resetOverlapGuardState: () => {},
}));

// Import AFTER all mock.module calls.
const { WorkflowOrchestrator } = await import('./workflow-orchestrator');

function resetSingleton() {
  (WorkflowOrchestrator as unknown as { instance: unknown }).instance = undefined;
}

describe('WorkflowOrchestrator — implementer plan-validity guard', () => {
  beforeEach(() => {
    resetSingleton();
    taskFindUniqueMock.mockClear();
    taskUpdateMock.mockClear();
    workflowTransitionCountMock.mockClear();
    workflowTransitionCountMock.mockImplementation(() => Promise.resolve(0));
    executeCLIAgentMock.mockClear();
    archiveWorkflowFileMock.mockClear();
    recordTransitionMock.mockClear();
    createNotificationMock.mockClear();
    scheduleWorkflowRedispatchMock.mockClear();
    planFileContent = null;
    isPlanReusable = false;
    overlapHeld = false;
    guardImplementOverlapMock.mockClear();
  });

  test('lightweight mode has no plan phase — the guard is skipped even with no plan.md', async () => {
    taskFindUniqueMock.mockImplementation(() =>
      Promise.resolve(
        makeTask({ workflowMode: 'lightweight', workflowModeOverride: 'lightweight' }),
      ),
    );
    planFileContent = null;
    isPlanReusable = false;

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(executeCLIAgentMock).toHaveBeenCalledTimes(1);
    expect(archiveWorkflowFileMock).not.toHaveBeenCalled();
    expect(result.status).toBe('verify_done');
  });

  test('a valid plan.md lets the implementer proceed without rolling back', async () => {
    taskFindUniqueMock.mockImplementation(() => Promise.resolve(makeTask()));
    planFileContent = '# Plan\n\nA fully fleshed out implementation plan.';
    isPlanReusable = true;

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(executeCLIAgentMock).toHaveBeenCalledTimes(1);
    expect(archiveWorkflowFileMock).not.toHaveBeenCalled();
    expect(result.status).toBe('verify_done');
  });

  test('missing plan.md below the replan cap archives it and rolls back to draft', async () => {
    taskFindUniqueMock.mockImplementation(() => Promise.resolve(makeTask()));
    planFileContent = null;
    isPlanReusable = false;
    workflowTransitionCountMock.mockImplementation(() => Promise.resolve(1));

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(true);
    expect(result.status).toBe('draft');
    expect(archiveWorkflowFileMock).toHaveBeenCalledTimes(1);
    expect(executeCLIAgentMock).not.toHaveBeenCalled();

    const draftUpdate = taskUpdateMock.mock.calls.find(
      (c) => (c[0] as { data: { workflowStatus?: string } }).data.workflowStatus === 'draft',
    );
    expect(draftUpdate).toBeDefined();

    const replanTransition = recordTransitionMock.mock.calls.find(
      (c) => (c[0] as { cause: string }).cause === 'plan_invalid_replan',
    );
    expect(replanTransition).toBeDefined();
  });

  test('missing plan.md below the replan cap schedules a redispatch to re-run the researcher', async () => {
    taskFindUniqueMock.mockImplementation(() => Promise.resolve(makeTask()));
    planFileContent = null;
    isPlanReusable = false;
    workflowTransitionCountMock.mockImplementation(() => Promise.resolve(1));

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.status).toBe('draft');
    expect(scheduleWorkflowRedispatchMock).toHaveBeenCalledTimes(1);
    expect(scheduleWorkflowRedispatchMock).toHaveBeenCalledWith(1, 'plan_invalid_replan', 'ja');
  });

  test('a log-polluted plan.md (present but not reusable) also rolls back to draft', async () => {
    taskFindUniqueMock.mockImplementation(() => Promise.resolve(makeTask()));
    planFileContent = '[System: thinking_tokens]';
    isPlanReusable = false;
    workflowTransitionCountMock.mockImplementation(() => Promise.resolve(0));

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.status).toBe('draft');
    expect(archiveWorkflowFileMock).toHaveBeenCalledTimes(1);
  });

  test('reaching the replan cap blocks the task instead of rolling back again', async () => {
    taskFindUniqueMock.mockImplementation(() => Promise.resolve(makeTask()));
    planFileContent = null;
    isPlanReusable = false;
    // MAX_PLAN_REPLANS is 3 — a clean count already at the cap trips the exhausted branch.
    workflowTransitionCountMock.mockImplementation(() => Promise.resolve(3));

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(false);
    expect(result.status).toBe('plan_approved');
    expect(result.error).toContain('打ち切り');
    expect(archiveWorkflowFileMock).not.toHaveBeenCalled();
    expect(executeCLIAgentMock).not.toHaveBeenCalled();

    const blockUpdate = taskUpdateMock.mock.calls.find(
      (c) => (c[0] as { data: { status?: string } }).data.status === 'blocked',
    );
    expect(blockUpdate).toBeDefined();

    const exhaustedTransition = recordTransitionMock.mock.calls.find(
      (c) => (c[0] as { cause: string }).cause === 'plan_invalid_replan_exhausted',
    );
    expect(exhaustedTransition).toBeDefined();

    // Notification is fired via a fire-and-forget dynamic import — flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createNotificationMock).toHaveBeenCalled();

    // Acceptance criterion 2: at the cap the task stays blocked — no redispatch.
    expect(scheduleWorkflowRedispatchMock).not.toHaveBeenCalled();
  });

  test('an overlap-held task with an invalid plan.md rolls back immediately, without waiting on the hold (task 802 guard order)', async () => {
    taskFindUniqueMock.mockImplementation(() => Promise.resolve(makeTask()));
    planFileContent = null;
    isPlanReusable = false;
    workflowTransitionCountMock.mockImplementation(() => Promise.resolve(1));
    overlapHeld = true;

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.status).toBe('draft');
    const replanTransition = recordTransitionMock.mock.calls.find(
      (c) => (c[0] as { cause: string }).cause === 'plan_invalid_replan',
    );
    expect(replanTransition).toBeDefined();
    // guardPlanValidity short-circuited before the overlap guard ever ran.
    expect(guardImplementOverlapMock).not.toHaveBeenCalled();
  });

  test('an overlap-held task with a valid plan.md is still held (skipped) as before', async () => {
    taskFindUniqueMock.mockImplementation(() => Promise.resolve(makeTask()));
    planFileContent = '# Plan\n\nA fully fleshed out implementation plan.';
    isPlanReusable = true;
    overlapHeld = true;

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(guardImplementOverlapMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'plan_approved', skipped: true });
    expect(executeCLIAgentMock).not.toHaveBeenCalled();
  });
});
