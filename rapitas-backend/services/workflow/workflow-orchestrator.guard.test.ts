/**
 * workflow-orchestrator.guard.test
 *
 * Covers the early-exit guards in WorkflowOrchestrator.runAdvanceWorkflow that
 * run BEFORE any agent is spawned: the per-task execution lock (advanceWorkflow
 * wrapper), task-not-found, blocked-task skip, "no transition for this status",
 * disabled-role, and the three-tier agent-resolution fallback (role config →
 * capability recommender → built-in default) all failing. Also covers the
 * small exported resolveSystemPromptContent helper, which shares this file's
 * prisma/DEFAULT_SYSTEM_PROMPTS mocks.
 *
 * None of the tests in this file reach model routing or agent execution, so
 * Smart Router / fallback-provider modules are intentionally left unmocked —
 * see workflow-orchestrator.smart-router.test.ts and
 * workflow-orchestrator.errors.test.ts for those branches.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: 'Test task',
    description: null,
    workflowStatus: 'research_done',
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
    role: 'planner',
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
const roleConfigFindUniqueMock = mock(() => Promise.resolve(makeRoleConfig()));
const systemPromptFindUniqueMock = mock(() => Promise.resolve(null as { content: string } | null));
const workflowTransitionCountMock = mock(() => Promise.resolve(0));
const workflowFileFindFirstMock = mock(() => Promise.resolve(null as { id: number } | null));

const mockPrisma = {
  task: { findUnique: taskFindUniqueMock, update: taskUpdateMock },
  workflowRoleConfig: { findUnique: roleConfigFindUniqueMock },
  systemPrompt: { findUnique: systemPromptFindUniqueMock },
  workflowTransition: { findFirst: async () => null, count: workflowTransitionCountMock },
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

let resolveWorkflowDirImpl = () =>
  Promise.resolve({ dir: '/tmp/wf/1', taskId: 1, categoryId: 0, themeId: 1 } as {
    dir: string;
    taskId: number;
    categoryId: number;
    themeId: number;
  } | null);
mock.module('./workflow-file-utils', () => ({
  resolveWorkflowDir: mock(() => resolveWorkflowDirImpl()),
  deleteWorkflowDir: mock(() => Promise.resolve(true)),
  readWorkflowFile: mock(() => Promise.resolve(null)),
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
mock.module('./workflow-agent-executor', () => ({
  executeCLIAgent: mock(() =>
    Promise.resolve({ success: true, role: 'planner', status: 'plan_created' }),
  ),
  executeAPIAgent: mock(() =>
    Promise.resolve({ success: true, role: 'planner', status: 'plan_created' }),
  ),
}));
mock.module('../agents/task-execution-lock', () => ({
  DEFAULT_LOCK_TTL_MS: 30 * 60 * 1000,
  WORKFLOW_LOCK_TTL_MS: 30 * 60 * 1000,
  acquireTaskExecutionLock: mock(() => lockAcquireResult),
  releaseTaskExecutionLock: mock(() => {}),
  isTaskExecutionLocked: mock(() => true),
}));
const defaultPromptsArr: { key: string; content: string }[] = [];
mock.module('../../routes/ai/system-prompts/default-prompts', () => ({
  CORE_DEFAULT_PROMPTS: [],
  WORKFLOW_DEFAULT_PROMPTS: [],
  DEFAULT_SYSTEM_PROMPTS: defaultPromptsArr,
}));
mock.module('./phase-output-validator', () => ({
  looksLogPolluted: mock(() => false),
  validateResearch: mock(() => ({ ok: true })),
  validatePlan: mock(() => ({ ok: true })),
  validateVerify: mock(() => ({ ok: true })),
  isReusableArtifact: mock(() => false),
}));
mock.module('./transition-recorder', () => ({
  recordTransition: mock(() => Promise.resolve()),
}));

let transitionsTable: Record<string, unknown> = {
  research_done: { role: 'planner', nextStatus: 'plan_created', outputFile: 'plan' },
};
mock.module('./workflow-mode-config', () => ({
  getModeSettings: mock(() =>
    Promise.resolve({ hasPlanPhase: true, hasReviewPhase: false, hasAutoVerify: false }),
  ),
  buildTransitions: mock(() => transitionsTable),
  selectProvisionalMode: mock(() => Promise.resolve('standard')),
}));
const recommendAgentForRoleMock = mock(() =>
  Promise.resolve(null as { agentConfigId: number } | null),
);
mock.module('./role-recommender', () => ({
  recommendAgentForRole: recommendAgentForRoleMock,
}));
const getDefaultAgentMock = mock(() =>
  Promise.resolve(
    null as {
      id: number;
      agentType: string;
      name: string;
      modelId: string | null;
      apiKeyEncrypted: string | null;
      endpoint: string | null;
    } | null,
  ),
);
mock.module('../agent-config/defaults', () => ({
  getDefaultAgent: getDefaultAgentMock,
}));

let lockAcquireResult = true;

// Probe stage (task 673) always succeeds here — these tests exercise the
// EARLIER lock/status guards, not probe behavior (see
// workflow-orchestrator-preflight-probe.test.ts for that).
mock.module('./workflow-orchestrator-preflight-probe', () => ({
  runPreflightProbe: mock(() => Promise.resolve({ done: false })),
}));

// Import AFTER all mock.module calls.
const { WorkflowOrchestrator, resolveSystemPromptContent } =
  await import('./workflow-orchestrator');

function resetSingleton() {
  (WorkflowOrchestrator as unknown as { instance: unknown }).instance = undefined;
}

describe('WorkflowOrchestrator.advanceWorkflow — per-task lock', () => {
  beforeEach(() => {
    resetSingleton();
    lockAcquireResult = true;
    taskFindUniqueMock.mockClear();
    taskFindUniqueMock.mockImplementation(() => Promise.resolve(makeTask()));
    roleConfigFindUniqueMock.mockClear();
    workflowTransitionCountMock.mockClear();
  });

  test('lock already held returns skipped:true without touching role config', async () => {
    lockAcquireResult = false;
    taskFindUniqueMock.mockImplementation(() =>
      Promise.resolve({ workflowStatus: 'plan_created' }),
    );

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(42);

    expect(result).toMatchObject({
      success: true,
      skipped: true,
      role: 'researcher',
      status: 'plan_created',
    });
    expect(result.output).toContain('skipped');
    // Never got far enough to look up role config — proves the lock short-circuited.
    expect(roleConfigFindUniqueMock).not.toHaveBeenCalled();
  });

  test('lock already held + unreadable task status falls back to draft', async () => {
    lockAcquireResult = false;
    taskFindUniqueMock.mockImplementation(() => Promise.reject(new Error('db down')));

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(42);

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.status).toBe('draft');
  });
});

describe('WorkflowOrchestrator.runAdvanceWorkflow — entry guards', () => {
  beforeEach(() => {
    resetSingleton();
    lockAcquireResult = true;
    transitionsTable = {
      research_done: { role: 'planner', nextStatus: 'plan_created', outputFile: 'plan' },
    };
    resolveWorkflowDirImpl = () =>
      Promise.resolve({ dir: '/tmp/wf/1', taskId: 1, categoryId: 0, themeId: 1 });
    taskFindUniqueMock.mockClear();
    taskFindUniqueMock.mockImplementation(() => Promise.resolve(makeTask()));
    taskUpdateMock.mockClear();
    roleConfigFindUniqueMock.mockClear();
    roleConfigFindUniqueMock.mockImplementation(() => Promise.resolve(makeRoleConfig()));
    recommendAgentForRoleMock.mockClear();
    recommendAgentForRoleMock.mockImplementation(() => Promise.resolve(null));
    getDefaultAgentMock.mockClear();
    getDefaultAgentMock.mockImplementation(() => Promise.resolve(null));
  });

  test('task not found returns TASK_NOT_FOUND', async () => {
    taskFindUniqueMock.mockImplementation(() => Promise.resolve(null));

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(999);

    expect(result.success).toBe(false);
    expect(result.status).toBe('draft');
    expect(result.error).toBe('タスクが見つかりません');
    expect(roleConfigFindUniqueMock).not.toHaveBeenCalled();
  });

  test('blocked task is skipped without building the transition table', async () => {
    taskFindUniqueMock.mockImplementation(() => Promise.resolve(makeTask({ status: 'blocked' })));

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ブロック中');
    expect(roleConfigFindUniqueMock).not.toHaveBeenCalled();
  });

  test('workflow-disabled task is skipped without building the transition table', async () => {
    taskFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeTask({ workflowDisabled: true })),
    );

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ワークフロー無効モード');
    expect(roleConfigFindUniqueMock).not.toHaveBeenCalled();
  });

  test('no transition defined for the current status', async () => {
    taskFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeTask({ workflowStatus: 'completed' })),
    );
    // The mocked transition table only has 'research_done', so 'completed' misses.

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(false);
    expect(result.status).toBe('completed');
    expect(result.error).toContain('completed');
    expect(roleConfigFindUniqueMock).not.toHaveBeenCalled();
  });

  test('disabled role stops before any agent resolution', async () => {
    roleConfigFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeRoleConfig({ isEnabled: false })),
    );

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(false);
    expect(result.role).toBe('planner');
    expect(result.error).toContain('無効化されています');
    expect(recommendAgentForRoleMock).not.toHaveBeenCalled();
  });

  test('falls back to capability recommender when no agent is assigned to the role', async () => {
    roleConfigFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeRoleConfig({ agentConfigId: null, agentConfig: null })),
    );
    recommendAgentForRoleMock.mockImplementation(() => Promise.resolve({ agentConfigId: 7 }));
    // recommended agent id 7 is looked up via prisma.aIAgentConfig.findUnique — add it to
    // the shared mockPrisma object for just this test.
    (
      mockPrisma as unknown as { aIAgentConfig: { findUnique: () => Promise<unknown> } }
    ).aIAgentConfig = {
      findUnique: mock(() =>
        Promise.resolve({
          id: 7,
          agentType: 'claude-code',
          name: 'Recommended Agent',
          modelId: 'claude-haiku-4-5-20251001',
          apiKeyEncrypted: null,
          endpoint: null,
        }),
      ),
    };
    resolveWorkflowDirImpl = () => Promise.resolve(null);

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    // Reaches the workflow-dir-resolution guard (further down), proving an agent was resolved.
    expect(result.success).toBe(false);
    expect(result.error).toBe('パス解決に失敗しました');
  });

  test('no agent assigned/recommended/default -> explicit configuration error', async () => {
    roleConfigFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeRoleConfig({ agentConfigId: null, agentConfig: null })),
    );
    recommendAgentForRoleMock.mockImplementation(() => Promise.resolve(null));
    getDefaultAgentMock.mockImplementation(() => Promise.resolve(null));

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(false);
    expect(result.error).toContain('エージェントが割り当てられていません');
  });

  test('workflow directory resolution failure surfaces a dedicated error', async () => {
    resolveWorkflowDirImpl = () => Promise.resolve(null);

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(false);
    expect(result.error).toBe('パス解決に失敗しました');
  });
});

describe('resolveSystemPromptContent', () => {
  beforeEach(() => {
    systemPromptFindUniqueMock.mockClear();
    systemPromptFindUniqueMock.mockImplementation(() => Promise.resolve(null));
    defaultPromptsArr.length = 0;
  });

  test('B-2: DB hit returns the DB content even when empty string', async () => {
    systemPromptFindUniqueMock.mockImplementation(() => Promise.resolve({ content: '' }));
    defaultPromptsArr.push({ key: 'k', content: 'default content' });

    const result = await resolveSystemPromptContent('k');

    // DB record existing (even empty) must win over the compiled default.
    expect(result).toBe('');
  });

  test('B-1: DB null + default entry present returns the default content', async () => {
    systemPromptFindUniqueMock.mockImplementation(() => Promise.resolve(null));
    defaultPromptsArr.push({ key: 'researcher', content: 'You are a researcher.' });

    const result = await resolveSystemPromptContent('researcher');

    expect(result).toBe('You are a researcher.');
  });

  test("B-1': DB null + no default entry returns ''", async () => {
    systemPromptFindUniqueMock.mockImplementation(() => Promise.resolve(null));

    const result = await resolveSystemPromptContent('unknown-key');

    expect(result).toBe('');
  });
});
