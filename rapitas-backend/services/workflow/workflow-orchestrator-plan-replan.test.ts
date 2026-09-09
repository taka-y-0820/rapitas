/**
 * workflow-orchestrator-plan-replan.test
 *
 * Fault-injection test for the plan-invalid-replan loop guard
 * (workflow-orchestrator.ts's `priorReplans` counter, ~line 455). A prior bug
 * used a bare `.catch(() => 0)` on this budget counter: when the DB count
 * query failed, `priorReplans` silently read as 0 — always BELOW
 * MAX_PLAN_REPLANS — so the guard could never trip and the task kept
 * archiving plan.md and rolling back to 'draft' forever. This test asserts
 * the fixed fail-closed behavior: a rejecting count makes the task BLOCK
 * (loop stops) instead of looping.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const mockPrisma = {
  task: {
    findUnique: mock(() =>
      Promise.resolve({
        id: 1,
        title: 'Test task',
        description: null,
        // 'plan_approved' + role 'implementer' is the ONLY transition that runs
        // the plan-validity/replan guard under test.
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
      }),
    ),
    update: mock(() => Promise.resolve({})),
  },
  workflowRoleConfig: {
    findUnique: mock(() =>
      Promise.resolve({
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
      }),
    ),
  },
  // The counter under test — REJECTS to simulate a DB hiccup.
  workflowTransition: {
    findFirst: async () => null,
    count: mock(() => Promise.reject(new Error('connection reset'))),
  },
};

const createNotification = mock(() => Promise.resolve({}));
const recordTransition = mock(() => Promise.resolve());
const archiveWorkflowFile = mock(() => Promise.resolve(false));

mock.module('../../config/logger', () => ({ createLogger: () => noopLogger }));
mock.module('../../config', () => ({
  prisma: mockPrisma,
  getProjectRoot: () => '/tmp/rapitas-test',
  createLogger: () => noopLogger,
  ensureDatabaseConnection: () => Promise.resolve(),
  getDbProvider: () => 'postgresql',
  getInsensitiveMode: () => 'default',
}));
mock.module('../../config/database', () => ({
  ensureDatabaseConnection: () => Promise.resolve(),
  prisma: mockPrisma,
}));
mock.module('./workflow-file-utils', () => ({
  resolveWorkflowDir: mock(() =>
    Promise.resolve({ dir: '/tmp/wf/1', taskId: 1, categoryId: 0, themeId: 1 }),
  ),
  // No plan.md on disk — forces the invalid-plan branch every time.
  readWorkflowFile: mock(() => Promise.resolve(null)),
  archiveWorkflowFile,
  writeWorkflowFile: mock(() => Promise.resolve()),
  cleanupRootWorkflowFiles: mock(() => Promise.resolve()),
  extractMarkdownFromOutput: mock(() => null),
}));
// Prevent the real executor chain (workflow-cli-executor / workflow-api-executor)
// from ever loading — this test's target branch returns before either would be
// called, and their transitive imports (child_process, GitHub CLI helpers, the
// REAL notification-service) are unnecessary weight and side effects here.
mock.module('./workflow-agent-executor', () => ({
  executeCLIAgent: mock(() =>
    Promise.resolve({ success: true, role: 'implementer', status: 'verify_done' }),
  ),
  executeAPIAgent: mock(() =>
    Promise.resolve({ success: true, role: 'implementer', status: 'verify_done' }),
  ),
}));
mock.module('./workflow-context-builder', () => ({
  buildRoleContext: mock(() => Promise.resolve('context')),
  applyPlanModeDirective: mock((_role: unknown, content: string) => content),
}));
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
mock.module('./phase-output-validator', () => ({
  isReusableArtifact: mock(() => false),
}));
mock.module('./transition-recorder', () => ({ recordTransition }));
mock.module('./workflow-mode-config', () => ({
  getModeSettings: mock(() =>
    Promise.resolve({ hasPlanPhase: true, hasReviewPhase: false, hasAutoVerify: false }),
  ),
  buildTransitions: mock(() => ({
    plan_approved: {
      role: 'implementer',
      nextStatus: 'verify_done',
      outputFile: 'verify',
      requiresApproval: false,
    },
  })),
  selectProvisionalMode: mock(() => Promise.resolve('standard')),
}));
mock.module('../communication/notification-service', () => ({ createNotification }));
// Probe stage (task 673) always succeeds here — this test targets the
// plan-replan DB-failure guard, not probe behavior.
mock.module('./workflow-orchestrator-preflight-probe', () => ({
  runPreflightProbe: mock(() => Promise.resolve({ done: false })),
}));

// Import AFTER all mock.module calls.
const { WorkflowOrchestrator } = await import('./workflow-orchestrator');

describe('WorkflowOrchestrator — plan-replan counter fails CLOSED on DB error', () => {
  beforeEach(() => {
    mockPrisma.task.update.mockClear();
    mockPrisma.workflowTransition.count.mockClear();
    recordTransition.mockClear();
    createNotification.mockClear();
    archiveWorkflowFile.mockClear();
    (WorkflowOrchestrator as unknown as { instance: unknown }).instance = undefined;
  });

  test('a rejecting count() BLOCKS the task instead of rolling back to draft (loop stops)', async () => {
    const orchestrator = WorkflowOrchestrator.getInstance();

    const result = await orchestrator.advanceWorkflow(1);

    // The exhausted-block branch was taken, NOT the rollback-to-draft branch.
    expect(result.success).toBe(false);
    expect(result.status).toBe('plan_approved');

    // The durable blocked-status write actually ran.
    const blockCall = mockPrisma.task.update.mock.calls.find(
      (c) => (c[0] as { data: { status?: string } }).data.status === 'blocked',
    );
    expect(blockCall).toBeDefined();

    // Never rolled back to 'draft' — that would mean the counter fail-OPENED
    // (read as 0) and let the loop re-enter instead of stopping.
    const draftCall = mockPrisma.task.update.mock.calls.find(
      (c) => (c[0] as { data: { workflowStatus?: string } }).data.workflowStatus === 'draft',
    );
    expect(draftCall).toBeUndefined();
    expect(archiveWorkflowFile).not.toHaveBeenCalled();

    // The recorded transition carries the FAIL-CLOSED count (the configured
    // cap, MAX_PLAN_REPLANS=3) — never the fail-open 0.
    const exhaustedTransition = recordTransition.mock.calls.find(
      (c) => (c[0] as { cause: string }).cause === 'plan_invalid_replan_exhausted',
    );
    expect(exhaustedTransition).toBeDefined();
    const metadata = (exhaustedTransition?.[0] as { metadata: { priorReplans: number } }).metadata;
    expect(metadata.priorReplans).toBe(3);
    expect(metadata.priorReplans).not.toBe(0);
  });
});
