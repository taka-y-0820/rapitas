/**
 * workflow-orchestrator.smart-router.test
 *
 * Covers two related model-selection branches in
 * WorkflowOrchestrator.runAdvanceWorkflow:
 *   - the Smart Router auto-select block, entered when the resolved
 *     modelId is unset/'auto' (success routes to the recommended model;
 *     failure falls back to the evergreen sonnet alias)
 *   - resolveExecutableAgentConfig, which runs on EVERY phase (auto-selected
 *     or not) to keep the agent type consistent with whatever model ends up
 *     selected — same-provider passthrough, cross-provider agent swap, and
 *     the two "drop the override" cases (no compatible agent; unrecognised
 *     model family)
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

function makeRoleConfig(
  overrides: {
    modelId?: string | null;
    agentConfig?: Record<string, unknown>;
  } = {},
) {
  return {
    role: 'planner',
    isEnabled: true,
    systemPromptKey: null,
    modelId: overrides.modelId ?? null,
    agentConfigId: 1,
    agentConfig: {
      id: 1,
      agentType: 'claude-code',
      name: 'Test Agent',
      modelId: 'claude-haiku-4-5-20251001',
      apiKeyEncrypted: null,
      endpoint: null,
      ...overrides.agentConfig,
    },
  };
}

const taskFindUniqueMock = mock(() => Promise.resolve(makeTask()));
const roleConfigFindUniqueMock = mock(() => Promise.resolve(makeRoleConfig()));
const mockPrisma = {
  task: {
    findUnique: taskFindUniqueMock,
    update: mock(() => Promise.resolve({})),
    updateMany: mock(() => Promise.resolve({ count: 1 })),
  },
  workflowRoleConfig: { findUnique: roleConfigFindUniqueMock },
  systemPrompt: { findUnique: mock(() => Promise.resolve(null)) },
  workflowTransition: { findFirst: async () => null, count: mock(() => Promise.resolve(0)) },
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
mock.module('./workflow-file-utils', () => ({
  resolveWorkflowDir: mock(() =>
    Promise.resolve({ dir: '/tmp/wf/1', taskId: 1, categoryId: 0, themeId: 1 }),
  ),
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
const executeCLIAgentMock = mock(() =>
  Promise.resolve({ success: true, role: 'planner', status: 'plan_created' }),
);
const executeAPIAgentMock = mock(() =>
  Promise.resolve({ success: true, role: 'planner', status: 'plan_created' }),
);
mock.module('./workflow-agent-executor', () => ({
  executeCLIAgent: executeCLIAgentMock,
  executeAPIAgent: executeAPIAgentMock,
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
mock.module('./workflow-mode-config', () => ({
  getModeSettings: mock(() =>
    Promise.resolve({ hasPlanPhase: true, hasReviewPhase: false, hasAutoVerify: false }),
  ),
  buildTransitions: mock(() => ({
    research_done: { role: 'planner', nextStatus: 'plan_created', outputFile: 'plan' },
  })),
  selectProvisionalMode: mock(() => Promise.resolve('standard')),
}));

let getStableSmartRouteImpl: () => Promise<{
  recommendedModel: string;
  recommendedTier: string;
}> = () =>
  Promise.resolve({ recommendedModel: 'claude-sonnet-4-5-20250101', recommendedTier: 'standard' });
mock.module('../ai/model-route-stability', () => ({
  getStableSmartRoute: mock(() => getStableSmartRouteImpl()),
  invalidateStableRoute: mock(() => {}),
  _resetStableRouteCache: mock(() => {}),
}));
mock.module('./routing-policy', () => ({
  highestTier: mock(() => undefined),
  isCapabilityRole: mock(() => false),
  computeMinTier: mock(() => undefined),
  computeMinTierWithReason: mock(() => ({ tier: undefined, reason: undefined })),
  isCapabilityAttributableFailure: mock(() => true),
}));
mock.module('./risk-detection', () => ({
  detectHighRisk: mock(() => ({ high: false })),
  stripRuledOutLines: mock((text: string) => text),
}));
mock.module('./workflow-queue', () => ({
  WorkflowQueueService: {
    getInstance: () => ({ findByTaskId: mock(() => Promise.resolve(null)) }),
  },
}));
mock.module('./outcome-telemetry', () => ({
  recordTaskOutcome: mock(() => Promise.resolve()),
  recentThemeEscalation: mock(() => Promise.resolve(0)),
}));

let inferProviderImpl: (modelId: string) => string | null = (modelId) => {
  if (modelId.startsWith('claude')) return 'claude';
  if (modelId.startsWith('gpt') || modelId.startsWith('openai')) return 'openai';
  return null;
};
mock.module('./role-provider-resolver', () => ({
  inferProviderFromModelId: mock((modelId: string) => inferProviderImpl(modelId)),
  resolveRoleProviderPreferences: mock(() => Promise.resolve({})),
}));
let agentTypeToProviderImpl: (agentType: string) => string | null = () => 'claude';
let findAgentConfigForProviderImpl: () => Promise<{
  id: number;
  agentType: string;
  name: string;
  apiKeyEncrypted: string | null;
  endpoint: string | null;
} | null> = () => Promise.resolve(null);
mock.module('../ai/agent-fallback', () => ({
  agentTypeToProvider: mock((agentType: string) => agentTypeToProviderImpl(agentType)),
  providerToAgentTypes: mock(() => ['claude-code']),
  findAgentConfigForProvider: mock(() => findAgentConfigForProviderImpl()),
  findFallbackAgentConfig: mock(() => Promise.resolve(null)),
}));

// Probe stage (task 673) always succeeds here — these tests exercise Smart
// Router model auto-selection, not probe behavior.
mock.module('./workflow-orchestrator-preflight-probe', () => ({
  runPreflightProbe: mock(() => Promise.resolve({ done: false })),
}));

// Import AFTER all mock.module calls.
const { WorkflowOrchestrator } = await import('./workflow-orchestrator');

function resetSingleton() {
  (WorkflowOrchestrator as unknown as { instance: unknown }).instance = undefined;
}

describe('WorkflowOrchestrator — Smart Router auto-select', () => {
  beforeEach(() => {
    resetSingleton();
    taskFindUniqueMock.mockClear();
    roleConfigFindUniqueMock.mockClear();
    executeCLIAgentMock.mockClear();
    agentTypeToProviderImpl = () => 'claude';
    inferProviderImpl = (modelId) => {
      if (modelId.startsWith('claude')) return 'claude';
      if (modelId.startsWith('gpt') || modelId.startsWith('openai')) return 'openai';
      return null;
    };
  });

  test("modelId='auto' routes to the Smart Router's recommended model", async () => {
    roleConfigFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeRoleConfig({ modelId: 'auto' })),
    );
    getStableSmartRouteImpl = () =>
      Promise.resolve({
        recommendedModel: 'claude-sonnet-4-5-20250101',
        recommendedTier: 'standard',
      });

    const orchestrator = WorkflowOrchestrator.getInstance();
    await orchestrator.advanceWorkflow(1);

    const cfg = executeCLIAgentMock.mock.calls[0]?.[2] as { modelId: string };
    expect(cfg.modelId).toBe('claude-sonnet-4-5-20250101');
  });

  test('Smart Router failure falls back to the evergreen sonnet alias', async () => {
    roleConfigFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeRoleConfig({ agentConfig: { modelId: 'auto' } })),
    );
    getStableSmartRouteImpl = () => Promise.reject(new Error('router unavailable'));

    const orchestrator = WorkflowOrchestrator.getInstance();
    await orchestrator.advanceWorkflow(1);

    const cfg = executeCLIAgentMock.mock.calls[0]?.[2] as { modelId: string };
    // Alias fallback: the CLI resolves 'sonnet' to the current release, so
    // the fallback cannot go stale (the old pinned date-suffixed Haiku could).
    expect(cfg.modelId).toBe('sonnet');
  });
});

describe('WorkflowOrchestrator — resolveExecutableAgentConfig (cross-provider reconciliation)', () => {
  beforeEach(() => {
    resetSingleton();
    taskFindUniqueMock.mockClear();
    roleConfigFindUniqueMock.mockClear();
    executeCLIAgentMock.mockClear();
    executeAPIAgentMock.mockClear();
    findAgentConfigForProviderImpl = () => Promise.resolve(null);
  });

  test('same-provider model just overrides modelId on the existing agent', async () => {
    roleConfigFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeRoleConfig({ modelId: 'claude-opus-4-5-20250101' })),
    );

    const orchestrator = WorkflowOrchestrator.getInstance();
    await orchestrator.advanceWorkflow(1);

    const cfg = executeCLIAgentMock.mock.calls[0]?.[2] as { id: number; modelId: string };
    expect(cfg.id).toBe(1);
    expect(cfg.modelId).toBe('claude-opus-4-5-20250101');
  });

  test('cross-provider model with a compatible agent switches agent config entirely', async () => {
    roleConfigFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeRoleConfig({ modelId: 'gpt-5-turbo' })),
    );
    agentTypeToProviderImpl = () => 'claude';
    findAgentConfigForProviderImpl = () =>
      Promise.resolve({
        id: 9,
        agentType: 'openai-agent',
        name: 'OpenAI Agent',
        apiKeyEncrypted: null,
        endpoint: null,
      });

    const orchestrator = WorkflowOrchestrator.getInstance();
    await orchestrator.advanceWorkflow(1);

    // 'openai-agent' is not a CLI_AGENT_TYPES member, so it must route through executeAPIAgent.
    expect(executeAPIAgentMock).toHaveBeenCalledTimes(1);
    expect(executeCLIAgentMock).not.toHaveBeenCalled();
    const cfg = executeAPIAgentMock.mock.calls[0]?.[2] as {
      id: number;
      agentType: string;
      modelId: string;
    };
    expect(cfg.id).toBe(9);
    expect(cfg.agentType).toBe('openai-agent');
    expect(cfg.modelId).toBe('gpt-5-turbo');
  });

  test('cross-provider model with no compatible agent drops the override entirely', async () => {
    roleConfigFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeRoleConfig({ modelId: 'gpt-5-turbo' })),
    );
    agentTypeToProviderImpl = () => 'claude';
    findAgentConfigForProviderImpl = () => Promise.resolve(null);

    const orchestrator = WorkflowOrchestrator.getInstance();
    await orchestrator.advanceWorkflow(1);

    expect(executeCLIAgentMock).toHaveBeenCalledTimes(1);
    const cfg = executeCLIAgentMock.mock.calls[0]?.[2] as { id: number; modelId: string };
    // Falls back to the agent's OWN default modelId, not the unusable cross-provider one.
    expect(cfg.id).toBe(1);
    expect(cfg.modelId).toBe('claude-haiku-4-5-20251001');
  });

  test('an unrecognised model family that does not match the current agent is also dropped', async () => {
    roleConfigFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeRoleConfig({ modelId: 'mystery-model-42' })),
    );
    // inferProviderImpl's default branch returns null for anything not claude/gpt/openai-prefixed.

    const orchestrator = WorkflowOrchestrator.getInstance();
    await orchestrator.advanceWorkflow(1);

    expect(executeCLIAgentMock).toHaveBeenCalledTimes(1);
    const cfg = executeCLIAgentMock.mock.calls[0]?.[2] as { modelId: string };
    expect(cfg.modelId).toBe('claude-haiku-4-5-20251001');
  });

  test('an unrecognised family that DOES match the current agent keeps the override', async () => {
    roleConfigFindUniqueMock.mockImplementation(() =>
      Promise.resolve(makeRoleConfig({ modelId: 'claude-3-opus-vNext' })),
    );
    inferProviderImpl = () => null;

    const orchestrator = WorkflowOrchestrator.getInstance();
    await orchestrator.advanceWorkflow(1);

    const cfg = executeCLIAgentMock.mock.calls[0]?.[2] as { modelId: string };
    expect(cfg.modelId).toBe('claude-3-opus-vNext');
  });
});
