/**
 * workflow-orchestrator.transitions.test
 *
 * Covers the status/artifact bookkeeping in WorkflowOrchestrator.runAdvanceWorkflow
 * that runs around agent dispatch:
 *   - draft-status reconciliation from existing research.md/plan.md rows (a
 *     re-dispatched task must not restart at 'draft' when artifacts already exist)
 *   - flipping a resumed 'todo' task to 'in-progress' without touching workflowStatus
 *   - the research/plan artifact-reuse skip-regeneration path
 *   - verify.md is NEVER reused, even when isReusableArtifact would say yes
 *
 * Model routing is kept out of scope: every agentConfig below has a concrete
 * modelId, so the Smart Router branch (`effectiveModelId is null/'auto'`) never
 * fires. See workflow-orchestrator.smart-router.test.ts for that path.
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

function makeRoleConfig(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

const taskFindUniqueMock = mock(() => Promise.resolve(makeTask()));
const taskUpdateMock = mock(() => Promise.resolve({}));
// NOTE: the non-draft branch of reconcileTaskStatusBeforeRun switched from an
// unconditional prisma.task.update to a conditional prisma.task.updateMany
// (task 658 fix, see workflow-orchestrator-context.ts) — without this mock
// every non-draft advanceWorkflow() call throws 'updateMany is not a function'.
const taskUpdateManyMock = mock(() => Promise.resolve({ count: 1 }));
const roleConfigFindUniqueMock = mock(() => Promise.resolve(makeRoleConfig()));

// Backs the LATE, DB-existence-only reconciliation backstop near the end of
// runAdvanceWorkflow (distinct from reconcileStatusFromExistingArtifacts,
// which runs earlier and validates actual file CONTENT quality via
// artifactContent/isReusableArtifactImpl below).
let planFileExists = false;
let researchFileExists = false;
const workflowFileFindFirstMock = mock(
  (args: { where: { fileType: string } }): Promise<{ id: number } | null> => {
    if (args.where.fileType === 'plan') return Promise.resolve(planFileExists ? { id: 1 } : null);
    if (args.where.fileType === 'research')
      return Promise.resolve(researchFileExists ? { id: 2 } : null);
    return Promise.resolve(null);
  },
);

const mockPrisma = {
  task: { findUnique: taskFindUniqueMock, update: taskUpdateMock, updateMany: taskUpdateManyMock },
  workflowRoleConfig: { findUnique: roleConfigFindUniqueMock },
  systemPrompt: { findUnique: mock(() => Promise.resolve(null)) },
  workflowTransition: { findFirst: async () => null, count: mock(() => Promise.resolve(0)) },
  workflowFile: { findFirst: workflowFileFindFirstMock },
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

// NOTE: keyed by fileType ('research' | 'plan' | 'verify' | 'question') so a
// test can simulate ONE artifact existing without accidentally also making
// every OTHER file type look present — a single shared value previously let
// the artifact-reuse-reconciler's plan.md check silently reuse the SAME
// string set for research.md, masking bugs in tests that only intended to
// set up one file (see git history for the incident this caused).
let artifactContent: Record<string, string | null> = {};
let isReusableArtifactImpl: (outputFile: string) => boolean = () => false;
const readWorkflowFileMock = mock((_dir: string, fileType: string) =>
  Promise.resolve(artifactContent[fileType] ?? null),
);
mock.module('./workflow-file-utils', () => ({
  resolveWorkflowDir: mock(() =>
    Promise.resolve({ dir: '/tmp/wf/1', taskId: 1, categoryId: 0, themeId: 1 }),
  ),
  deleteWorkflowDir: mock(() => Promise.resolve(true)),
  readWorkflowFile: readWorkflowFileMock,
  writeWorkflowFile: mock(() => Promise.resolve()),
  archiveWorkflowFile: mock(() => Promise.resolve(false)),
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
  Promise.resolve({ success: true, role: 'researcher', status: 'research_done' }),
);
mock.module('./workflow-agent-executor', () => ({
  executeCLIAgent: executeCLIAgentMock,
  executeAPIAgent: mock(() =>
    Promise.resolve({ success: true, role: 'researcher', status: 'research_done' }),
  ),
}));
mock.module('../agents/task-execution-lock', () => ({
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
mock.module('./phase-output-validator', () => ({
  looksLogPolluted: mock(() => false),
  validateResearch: mock(() => ({ ok: true })),
  validatePlan: mock(() => ({ ok: true })),
  validateVerify: mock(() => ({ ok: true })),
  isReusableArtifact: mock((outputFile: string) => isReusableArtifactImpl(outputFile)),
}));
mock.module('./transition-recorder', () => ({
  recordTransition: mock(() => Promise.resolve()),
}));
mock.module('./workflow-mode-config', () => ({
  getModeSettings: mock(() => Promise.resolve({ includePlan: true, autoVerify: false })),
  buildTransitions: mock(() => ({
    draft: { role: 'researcher', nextStatus: 'research_done', outputFile: 'research' },
    research_done: { role: 'planner', nextStatus: 'plan_created', outputFile: 'plan' },
    plan_approved: { role: 'implementer', nextStatus: 'verify_done', outputFile: 'verify' },
  })),
  selectProvisionalMode: mock(() => Promise.resolve('standard')),
}));
mock.module('../intake', () => ({
  ensureIntakeReady: mock(() => Promise.resolve({ status: 'ready' })),
  checkSpecQuality: mock(() => ({ thin: false })),
  parseSpecArray: mock(() => []),
  mergeSpecField: mock((v: unknown) => v),
  resolveIntakePolicy: mock(() => Promise.resolve({})),
  decideIntake: mock(() => ({ proceed: true })),
  buildIntakeQuestion: mock(() => ''),
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
// Probe stage (task 673) always succeeds here — these tests exercise status/
// artifact bookkeeping around agent dispatch, not probe behavior (see
// workflow-orchestrator-preflight-probe.test.ts and
// workflow-orchestrator-probe-integration.test.ts for that).
mock.module('./workflow-orchestrator-preflight-probe', () => ({
  runPreflightProbe: mock(() => Promise.resolve({ done: false })),
}));

// Import AFTER all mock.module calls.
const { WorkflowOrchestrator } = await import('./workflow-orchestrator');

function resetSingleton() {
  (WorkflowOrchestrator as unknown as { instance: unknown }).instance = undefined;
}

describe('WorkflowOrchestrator — draft status reconciliation', () => {
  beforeEach(() => {
    resetSingleton();
    taskFindUniqueMock.mockClear();
    taskFindUniqueMock.mockImplementation(() => Promise.resolve(makeTask()));
    taskUpdateMock.mockClear();
    taskUpdateManyMock.mockClear();
    roleConfigFindUniqueMock.mockImplementation(() => Promise.resolve(makeRoleConfig()));
    executeCLIAgentMock.mockClear();
    isReusableArtifactImpl = () => false;
    artifactContent = {};
    planFileExists = false;
    researchFileExists = false;
  });

  test('plan.md already exists -> reconciles straight to plan_created (never auto-skips approval)', async () => {
    planFileExists = true;
    researchFileExists = true;

    const orchestrator = WorkflowOrchestrator.getInstance();
    await orchestrator.advanceWorkflow(1);

    const reconcileCall = taskUpdateMock.mock.calls.find(
      (c) => (c[0] as { data: { workflowStatus?: string } }).data.workflowStatus,
    );
    expect(reconcileCall).toBeDefined();
    const data = (reconcileCall?.[0] as { data: { workflowStatus: string; status: string } }).data;
    expect(data.workflowStatus).toBe('plan_created');
    expect(data.status).toBe('in-progress');
  });

  test('only research.md exists -> reconciles to research_done', async () => {
    planFileExists = false;
    researchFileExists = true;

    const orchestrator = WorkflowOrchestrator.getInstance();
    await orchestrator.advanceWorkflow(1);

    const reconcileCall = taskUpdateMock.mock.calls.find(
      (c) => (c[0] as { data: { workflowStatus?: string } }).data.workflowStatus,
    );
    const data = (reconcileCall?.[0] as { data: { workflowStatus: string } }).data;
    expect(data.workflowStatus).toBe('research_done');
  });

  test('no artifacts on disk -> stays at draft', async () => {
    planFileExists = false;
    researchFileExists = false;

    const orchestrator = WorkflowOrchestrator.getInstance();
    await orchestrator.advanceWorkflow(1);

    const reconcileCall = taskUpdateMock.mock.calls.find(
      (c) => (c[0] as { data: { workflowStatus?: string } }).data.workflowStatus,
    );
    const data = (reconcileCall?.[0] as { data: { workflowStatus: string } }).data;
    expect(data.workflowStatus).toBe('draft');
  });
});

describe('WorkflowOrchestrator — resumed todo task', () => {
  beforeEach(() => {
    resetSingleton();
    taskFindUniqueMock.mockClear();
    taskUpdateMock.mockClear();
    taskUpdateManyMock.mockClear();
    roleConfigFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeRoleConfig({ role: 'planner' })),
    );
    executeCLIAgentMock.mockClear();
    isReusableArtifactImpl = () => false;
    artifactContent = {};
  });

  // NOTE: reconcileTaskStatusBeforeRun's non-draft branch now flips 'todo'
  // via prisma.task.updateMany({ where: { id, status: 'todo' }, ... }) instead
  // of an unconditional prisma.task.update (task 658 fix). The conditional
  // WHERE clause — not application-level branching on task.status — is what
  // decides whether the write actually lands, so both tests below assert
  // against taskUpdateManyMock and confirm taskUpdateMock is never touched.
  test("status='todo' at a non-draft phase issues a conditional updateMany without touching workflowStatus", async () => {
    taskFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeTask({ workflowStatus: 'research_done', status: 'todo' })),
    );

    const orchestrator = WorkflowOrchestrator.getInstance();
    await orchestrator.advanceWorkflow(1);

    const statusOnlyCall = taskUpdateManyMock.mock.calls.find((c) => {
      const args = c[0] as { where: Record<string, unknown>; data: Record<string, unknown> };
      return (
        args.where.status === 'todo' &&
        args.data.status === 'in-progress' &&
        !('workflowStatus' in args.data)
      );
    });
    expect(statusOnlyCall).toBeDefined();
    expect(taskUpdateMock).not.toHaveBeenCalled();
  });

  test("status already 'in-progress' — the conditional WHERE (not JS logic) is what prevents a redundant write", async () => {
    taskFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeTask({ workflowStatus: 'research_done', status: 'in-progress' })),
    );
    // Simulates the DB row already being 'in-progress': the WHERE { status:
    // 'todo' } matches nothing, so the (still-issued) updateMany is a no-op.
    taskUpdateManyMock.mockImplementationOnce(() => Promise.resolve({ count: 0 }));

    const orchestrator = WorkflowOrchestrator.getInstance();
    await orchestrator.advanceWorkflow(1);

    const statusOnlyCall = taskUpdateManyMock.mock.calls.find((c) => {
      const args = c[0] as { where: Record<string, unknown>; data: Record<string, unknown> };
      return args.where.status === 'todo' && args.data.status === 'in-progress';
    });
    expect(statusOnlyCall).toBeDefined();
    expect(taskUpdateMock).not.toHaveBeenCalled();
  });
});

describe('WorkflowOrchestrator — artifact reuse', () => {
  beforeEach(() => {
    resetSingleton();
    taskFindUniqueMock.mockClear();
    taskUpdateMock.mockClear();
    taskUpdateManyMock.mockClear();
    executeCLIAgentMock.mockClear();
    artifactContent = {};
    isReusableArtifactImpl = () => false;
  });

  test('a valid existing research.md skips research and dispatches the planner in the same call', async () => {
    taskFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeTask({ workflowStatus: 'draft' })),
    );
    roleConfigFindUniqueMock.mockImplementation((args: unknown) =>
      Promise.resolve(makeRoleConfig({ role: (args as { where: { role: string } }).where.role })),
    );
    artifactContent.research = '# Research\n\nSubstantive content.';
    isReusableArtifactImpl = (outputFile) => outputFile === 'research';

    const orchestrator = WorkflowOrchestrator.getInstance();
    await orchestrator.advanceWorkflow(1);

    // reconcileStatusFromExistingArtifacts (runs before role/model resolution)
    // fast-forwards draft -> research_done since research.md is reusable; with
    // no plan.md yet, the planner is dispatched immediately in this SAME call
    // instead of requiring a second poll to notice research_done.
    expect(executeCLIAgentMock).toHaveBeenCalledTimes(1);
    const [, , , , , dispatchedTransition] = executeCLIAgentMock.mock.calls[0];
    expect((dispatchedTransition as { role: string }).role).toBe('planner');
  });

  test('a log-polluted research.md is NOT reused — the researcher still runs', async () => {
    taskFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeTask({ workflowStatus: 'draft' })),
    );
    roleConfigFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeRoleConfig({ role: 'researcher' })),
    );
    artifactContent.research = '[System: thinking_tokens]';
    isReusableArtifactImpl = () => false;

    const orchestrator = WorkflowOrchestrator.getInstance();
    await orchestrator.advanceWorkflow(1);

    expect(executeCLIAgentMock).toHaveBeenCalledTimes(1);
    const [, , , , , dispatchedTransition] = executeCLIAgentMock.mock.calls[0];
    expect((dispatchedTransition as { role: string }).role).toBe('researcher');
  });

  test('verify.md is never reused even when isReusableArtifact would approve it', async () => {
    taskFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeTask({ workflowStatus: 'plan_approved' })),
    );
    roleConfigFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeRoleConfig({ role: 'implementer' })),
    );
    // plan.md must look valid too, or the implementer plan-validity guard would fire first.
    artifactContent.plan = '# Plan\n\nvalid plan';
    artifactContent.verify = '# Verify\n\nlooks valid';
    isReusableArtifactImpl = () => true;

    const orchestrator = WorkflowOrchestrator.getInstance();
    await orchestrator.advanceWorkflow(1);

    // The reuse-skip branch is only for outputFile !== 'verify' — the agent must run.
    expect(executeCLIAgentMock).toHaveBeenCalledTimes(1);
  });
});
