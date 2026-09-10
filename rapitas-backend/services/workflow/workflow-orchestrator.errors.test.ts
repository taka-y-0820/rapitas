/**
 * workflow-orchestrator.errors.test
 *
 * Covers the single-retry provider-fallback wrapper around agent execution
 * (workflow-orchestrator.ts's outer try/catch, `tryProviderFallback`, and
 * `hasProviderErrorInOutput`): a clean success returns directly, a "success but
 * the output secretly contains a provider quota/rate-limit error" (Codex exits 0
 * even after printing an error) triggers a fallback, a `model_unavailable`
 * classification retries the SAME provider without --model, and both the
 * resolved-failure and thrown-error paths fall through to a plain error result
 * when no fallback is possible.
 *
 * Shutdown-error handling (re-throw, no fallback attempted) already has
 * dedicated coverage in workflow-orchestrator-shutdown.test.ts; this file adds
 * the non-shutdown thrown-error-with-successful-fallback case that file doesn't
 * exercise.
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

const roleConfig = {
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
};

const taskFindUniqueMock = mock(() => Promise.resolve(makeTask()));
const mockPrisma = {
  task: {
    findUnique: taskFindUniqueMock,
    update: mock(() => Promise.resolve({})),
    updateMany: mock(() => Promise.resolve({ count: 1 })),
  },
  workflowRoleConfig: { findUnique: mock(() => Promise.resolve(roleConfig)) },
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

type AgentResult = {
  success: boolean;
  role: string;
  status: string;
  output?: string;
  error?: string;
};
let executeCLIAgentImpl: () => Promise<AgentResult> | never = () =>
  Promise.resolve({ success: true, role: 'planner', status: 'plan_created' });
const executeCLIAgentMock = mock((..._args: unknown[]) => executeCLIAgentImpl());
mock.module('./workflow-agent-executor', () => ({
  executeCLIAgent: executeCLIAgentMock,
  executeAPIAgent: mock(() =>
    Promise.resolve({ success: true, role: 'planner', status: 'plan_created' }),
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

type Classified = {
  provider: string;
  reason: 'quota' | 'rate_limit' | 'auth' | 'transient' | 'model_unavailable';
  retryWithFallback: boolean;
  resetAt: number | null;
  rawMessage: string;
} | null;
let classifyStrictResult: Classified = null;
let classifyLooseResult: Classified = null;
const classifyAgentErrorMock = mock((blob: string, opts?: { strict?: boolean }) =>
  opts?.strict ? classifyStrictResult : classifyLooseResult,
);
mock.module('../ai/agent-error-classifier', () => ({
  classifyAgentError: classifyAgentErrorMock,
  __internal: { parseTryAgainAt: () => null, HOUR_MS: 3600000 },
}));

const markProviderCooldownMock = mock(() => {});
mock.module('../ai/provider-cooldown', () => ({
  markProviderCooldown: markProviderCooldownMock,
  isProviderInCooldown: mock(() => false),
  listActiveCooldowns: mock(() => []),
  clearCooldown: mock(() => {}),
  // NOTE: bun mock.module replaces the whole module — new exports must be
  // mirrored here or importers see undefined at runtime.
  recordProviderSuccess: mock(() => {}),
  listFailureStreaks: mock(() => []),
  inferProviderFromModelName: mock(() => null),
  __resetCooldowns: mock(() => {}),
}));

let getSmartRouteImpl: () => Promise<{ recommendedModel: string }> = () =>
  Promise.resolve({ recommendedModel: 'gpt-5-fallback' });
mock.module('../ai/smart-model-router', () => ({
  estimateCost: mock(() => Promise.resolve({})),
  getSmartRoute: mock(() => getSmartRouteImpl()),
  getBudgetStatus: mock(() => Promise.resolve({})),
}));

let inferProviderImpl: (modelId: string) => string | null = (modelId) =>
  modelId.startsWith('gpt') ? 'openai' : 'claude';
mock.module('./role-provider-resolver', () => ({
  inferProviderFromModelId: mock((modelId: string) => inferProviderImpl(modelId)),
  resolveRoleProviderPreferences: mock(() => Promise.resolve({})),
}));

let findAgentConfigForProviderImpl: () => Promise<{
  id: number;
  agentType: string;
  name: string;
  apiKeyEncrypted: string | null;
  endpoint: string | null;
} | null> = () => Promise.resolve(null);
mock.module('../ai/agent-fallback', () => ({
  agentTypeToProvider: mock(() => 'claude'),
  providerToAgentTypes: mock(() => ['claude-code']),
  findAgentConfigForProvider: mock(() => findAgentConfigForProviderImpl()),
  findFallbackAgentConfig: mock(() => Promise.resolve(null)),
}));

mock.module('../ai/model-route-stability', () => ({
  getStableSmartRoute: mock(() =>
    Promise.resolve({ recommendedModel: 'claude-haiku-4-5-20251001' }),
  ),
  invalidateStableRoute: mock(() => {}),
  _resetStableRouteCache: mock(() => {}),
}));

// Decision-audit spy: tryProviderFallback records the re-route (kind=api_call)
// via a dynamic import of this barrel.
// HACK(agent): bun の mock.module はプロセスグローバルなため、バレルの全エクスポートを
// ミラーしないと他 import が "export not found" をスローする。
const recordDecisionMock = mock(() => Promise.resolve());
mock.module('../observability/decision-trace', () => ({
  recordDecision: recordDecisionMock,
  getDecisionDag: mock(() => Promise.resolve({ nodes: [], edges: [] })),
  runConsistencyCheckBatch: mock(() => Promise.resolve({ checked: 0, updated: 0 })),
  judgeConsistency: mock(() => ({ consistency: 'skipped', note: '' })),
  maskSensitive: mock((v: unknown) => ({ masked: v, maskedFieldCount: 0 })),
  maskStringValue: mock((v: string) => ({ masked: v, count: 0 })),
}));

// Probe stage (task 673) always succeeds here — these tests exercise
// provider-fallback error handling, not probe behavior.
mock.module('./workflow-orchestrator-preflight-probe', () => ({
  runPreflightProbe: mock(() => Promise.resolve({ done: false })),
}));

// Import AFTER all mock.module calls.
const { WorkflowOrchestrator } = await import('./workflow-orchestrator');

function resetSingleton() {
  (WorkflowOrchestrator as unknown as { instance: unknown }).instance = undefined;
}

describe('WorkflowOrchestrator — provider fallback on success-with-implicit-error', () => {
  beforeEach(() => {
    resetSingleton();
    taskFindUniqueMock.mockClear();
    executeCLIAgentMock.mockClear();
    markProviderCooldownMock.mockClear();
    recordDecisionMock.mockClear();
    classifyStrictResult = null;
    classifyLooseResult = null;
    executeCLIAgentImpl = () =>
      Promise.resolve({ success: true, role: 'planner', status: 'plan_created' });
    getSmartRouteImpl = () => Promise.resolve({ recommendedModel: 'gpt-5-fallback' });
    findAgentConfigForProviderImpl = () => Promise.resolve(null);
    inferProviderImpl = (modelId) => (modelId.startsWith('gpt') ? 'openai' : 'claude');
  });

  test('a clean success is returned directly without invoking the classifier', async () => {
    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(true);
    expect(executeCLIAgentMock).toHaveBeenCalledTimes(1);
    expect(classifyAgentErrorMock).not.toHaveBeenCalled();
  });

  test('output secretly containing a provider error triggers a successful fallback', async () => {
    let call = 0;
    executeCLIAgentImpl = () => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          success: true,
          role: 'planner',
          status: 'plan_created',
          output: "ERROR: You've hit your usage limit for this billing period",
        });
      }
      return Promise.resolve({ success: true, role: 'planner', status: 'plan_created' });
    };
    classifyStrictResult = {
      provider: 'openai',
      reason: 'quota',
      retryWithFallback: true,
      resetAt: null,
      rawMessage: 'usage limit',
    };
    classifyLooseResult = classifyStrictResult;
    findAgentConfigForProviderImpl = () =>
      Promise.resolve({
        id: 2,
        agentType: 'codex',
        name: 'Codex Fallback',
        apiKeyEncrypted: null,
        endpoint: null,
      });

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(true);
    expect(executeCLIAgentMock).toHaveBeenCalledTimes(2);
    expect(markProviderCooldownMock).toHaveBeenCalledTimes(1);
    const secondCallCfg = executeCLIAgentMock.mock.calls[1]?.[2] as { agentType: string };
    expect(secondCallCfg.agentType).toBe('codex');

    // The fire-and-forget audit record settles on a later tick — give it one.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recordDecisionMock).toHaveBeenCalledTimes(1);
    const audit = (recordDecisionMock.mock.calls[0] as unknown[])[0] as {
      kind: string;
      adoptedId: string;
      nodeKey: string;
    };
    expect(audit.kind).toBe('api_call');
    expect(audit.adoptedId).toBe('gpt-5-fallback');
    expect(audit.nodeKey).toContain('provider-fallback');
  });

  test('model_unavailable retries the same provider without a --model override', async () => {
    let call = 0;
    executeCLIAgentImpl = () => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          success: false,
          role: 'planner',
          status: 'research_done',
          error: 'model not found: claude-haiku-4-5-20251001',
        });
      }
      return Promise.resolve({ success: true, role: 'planner', status: 'plan_created' });
    };
    classifyLooseResult = {
      provider: 'claude',
      reason: 'model_unavailable',
      retryWithFallback: true,
      resetAt: null,
      rawMessage: 'model not found',
    };

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(true);
    expect(executeCLIAgentMock).toHaveBeenCalledTimes(2);
    // Skips cooldown entirely for a single-model outage.
    expect(markProviderCooldownMock).not.toHaveBeenCalled();
    const secondCallCfg = executeCLIAgentMock.mock.calls[1]?.[2] as { modelId: string | null };
    expect(secondCallCfg.modelId).toBeNull();
  });
});

describe('WorkflowOrchestrator — resolved-failure fallback', () => {
  beforeEach(() => {
    resetSingleton();
    executeCLIAgentMock.mockClear();
    classifyStrictResult = null;
    classifyLooseResult = null;
  });

  test('an ordinary failure with no provider-error pattern passes through unchanged', async () => {
    executeCLIAgentImpl = () =>
      Promise.resolve({
        success: false,
        role: 'planner',
        status: 'research_done',
        error: 'Unexpected token in plan.md',
      });

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Unexpected token in plan.md');
    expect(executeCLIAgentMock).toHaveBeenCalledTimes(1);
  });

  test('a failure with an implicit provider error and no viable fallback gets the generic override', async () => {
    executeCLIAgentImpl = () =>
      Promise.resolve({
        success: false,
        role: 'planner',
        status: 'research_done',
        error: '',
        output: 'rate limit exceeded, please retry later',
      });
    classifyStrictResult = {
      provider: 'openai',
      reason: 'rate_limit',
      retryWithFallback: true,
      resetAt: null,
      rawMessage: 'rate limit exceeded',
    };
    classifyLooseResult = null; // tryProviderFallback itself finds no fallback

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Provider failure detected and no fallback completed successfully');
  });

  test('a failure with a real error message keeps it even when marked as an implicit provider error', async () => {
    executeCLIAgentImpl = () =>
      Promise.resolve({
        success: false,
        role: 'planner',
        status: 'research_done',
        error: 'quota exceeded for this account',
      });
    classifyStrictResult = {
      provider: 'openai',
      reason: 'quota',
      retryWithFallback: true,
      resetAt: null,
      rawMessage: 'quota exceeded',
    };
    classifyLooseResult = null;

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(false);
    expect(result.error).toBe('quota exceeded for this account');
  });
});

describe('WorkflowOrchestrator — thrown-error fallback', () => {
  beforeEach(() => {
    resetSingleton();
    executeCLIAgentMock.mockClear();
    classifyStrictResult = null;
    classifyLooseResult = null;
    getSmartRouteImpl = () => Promise.resolve({ recommendedModel: 'gpt-5-fallback' });
    findAgentConfigForProviderImpl = () => Promise.resolve(null);
    inferProviderImpl = (modelId) => (modelId.startsWith('gpt') ? 'openai' : 'claude');
  });

  test('a thrown non-shutdown error recovers via a successful fallback', async () => {
    let call = 0;
    executeCLIAgentImpl = () => {
      call += 1;
      if (call === 1) throw new Error('ECONNRESET: connection reset by peer');
      return Promise.resolve({ success: true, role: 'planner', status: 'plan_created' });
    };
    classifyLooseResult = {
      provider: 'claude',
      reason: 'transient',
      retryWithFallback: true,
      resetAt: null,
      rawMessage: 'ECONNRESET',
    };
    findAgentConfigForProviderImpl = () =>
      Promise.resolve({
        id: 3,
        agentType: 'gemini',
        name: 'Gemini Fallback',
        apiKeyEncrypted: null,
        endpoint: null,
      });
    inferProviderImpl = () => 'gemini';

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(true);
    expect(executeCLIAgentMock).toHaveBeenCalledTimes(2);
  });

  test('a thrown non-shutdown error with no viable fallback resolves to a wrapped failure', async () => {
    executeCLIAgentImpl = () => {
      throw new Error('Database connection refused');
    };
    classifyLooseResult = null;

    const orchestrator = WorkflowOrchestrator.getInstance();
    const result = await orchestrator.advanceWorkflow(1);

    expect(result.success).toBe(false);
    expect(result.error).toContain('実行エラー');
    expect(result.error).toContain('Database connection refused');
  });
});
