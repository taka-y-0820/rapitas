/**
 * workflow-api-executor.test
 *
 * Covers executeAPIAgent: local-LLM routing + paid-API fallback, per-agentType
 * dispatch, the theme-workdir directive (implementer-only), output persistence
 * + truncation, the verify.md honesty/self-repair gate, error propagation, and
 * the implementer -> verifier auto-advance.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { RoleTransition } from './workflow-types';
import { ExecutionCancelledError } from '../agents/execution-cancelled-error';

const mockSessionCreate = mock(() => Promise.resolve({ id: 1 }));
const mockSessionUpdate = mock(() => Promise.resolve({}));
const mockExecutionCreate = mock(() => Promise.resolve({ id: 10 }));
const mockExecutionUpdate = mock(() => Promise.resolve({}));
const mockTaskUpdate = mock(() => Promise.resolve({}));
// The verify honesty gate reads the task's LIVE workflowStatus for its CAS
// snapshot (workflow-api-executor.ts) — while the verifier runs, that is still
// 'in_progress'; verify_done is only written after the gate passes.
const mockTaskFindUnique = mock(() => Promise.resolve({ workflowStatus: 'in_progress' }));

mock.module('../../config', () => ({
  prisma: {
    agentSession: { create: mockSessionCreate, update: mockSessionUpdate },
    agentExecution: { create: mockExecutionCreate, update: mockExecutionUpdate },
    task: { update: mockTaskUpdate, findUnique: mockTaskFindUnique },
  },
  ensureDatabaseConnection: () => Promise.resolve(),
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  getDbProvider: () => 'postgresql',
  getInsensitiveMode: () => 'default',
  getProjectRoot: () => '/tmp/rapitas-test',
}));

const noopLog = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
};
mock.module('../../config/logger', () => ({
  createLogger: () => noopLog,
}));

const mockWriteWorkflowFile = mock(
  async (_taskId: number, _type: string, content: string) => content,
);
const mockExtractMarkdown = mock((output: string, _fileType: string) => output);
mock.module('./workflow-file-utils', () => ({
  writeWorkflowFile: mockWriteWorkflowFile,
  extractMarkdownFromOutput: mockExtractMarkdown,
  resolveWorkflowDir: mock(() =>
    Promise.resolve({ dir: '/tmp/wf/1', taskId: 1, categoryId: 0, themeId: 1 }),
  ),
  deleteWorkflowDir: mock(() => Promise.resolve(true)),
  readWorkflowFile: mock(() => Promise.resolve(null)),
  archiveWorkflowFile: mock(() => Promise.resolve(false)),
  cleanupRootWorkflowFiles: mock(() => Promise.resolve()),
  looksLikeAgentLog: mock(() => false),
  sliceFromReportHeading: mock((text: string) => text),
}));

const mockCallAnthropicAPI = mock(() => Promise.resolve('anthropic output'));
const mockCallOpenAIAPI = mock(() => Promise.resolve('openai output'));
const mockDecryptApiKey = mock((encrypted: string) => Promise.resolve(encrypted));
mock.module('./workflow-api-callers', () => ({
  callAnthropicAPI: mockCallAnthropicAPI,
  callOpenAIAPI: mockCallOpenAIAPI,
  decryptApiKey: mockDecryptApiKey,
}));

const mockResolveTaskWithTheme = mock(() =>
  Promise.resolve<{ theme: { workingDirectory: string | null } } | null>(null),
);
mock.module('../task/task-resolver', () => ({
  resolveTaskWithTheme: mockResolveTaskWithTheme,
}));

const mockAssessComplexity = mock(() => ({
  level: 'high' as const,
  score: 80,
  reasons: [] as string[],
  canUseLocalLLM: false,
}));
mock.module('../local-llm/complexity-assessor', () => ({
  assessComplexity: mockAssessComplexity,
}));

const mockSendAIMessage = mock(() =>
  Promise.resolve({ content: 'local llm output', tokensUsed: 0 }),
);
mock.module('../../utils/ai-client', () => ({
  sendAIMessage: mockSendAIMessage,
}));

const mockWriteBlockedStatusDurable = mock(() => Promise.resolve(true));
mock.module('./durable-blocked-write', () => ({
  writeBlockedStatusDurable: mockWriteBlockedStatusDurable,
}));

const mockValidateVerify = mock(() => ({
  ok: true,
  missingSections: [] as string[],
  severity: 0,
  summary: '',
}));
mock.module('./phase-output-validator', () => ({
  validateVerify: mockValidateVerify,
}));

const mockAttemptVerifyRepair = mock(() =>
  Promise.resolve<{ bounced: boolean; newStatus?: string; attempt?: number }>({ bounced: false }),
);
mock.module('./verify-self-repair', () => ({
  attemptVerifyRepair: mockAttemptVerifyRepair,
}));

// NOTE: The guard hits the real DB module (config/database) which this test
// does not mock — without this the dynamic import issues a real prisma query
// and the test hangs until timeout.
const mockCriticRejectedSince = mock(() => Promise.resolve(false));
mock.module('./phase-critic/critic-rejection-guard', () => ({
  criticRejectedSince: mockCriticRejectedSince,
}));

const { executeAPIAgent } = await import('./workflow-api-executor');

const baseTask = { title: 'Test task', description: 'A description' };
const baseAgentConfig = {
  id: 1,
  agentType: 'anthropic-api',
  name: 'Test Agent',
  modelId: null as string | null,
  apiKeyEncrypted: null as string | null,
  endpoint: null as string | null,
};

function makeTransition(overrides: Partial<RoleTransition> = {}): RoleTransition {
  return { role: 'researcher', outputFile: 'research', nextStatus: 'research_done', ...overrides };
}

const mockAdvanceWorkflow = mock(() =>
  Promise.resolve({ success: true, role: 'verifier' as const, status: 'verify_done' as const }),
);
const mockGetOrCreateDevConfig = mock(() => Promise.resolve({ id: 1 }));

function resetMocks() {
  mockSessionCreate.mockReset();
  mockSessionCreate.mockResolvedValue({ id: 1 });
  mockSessionUpdate.mockReset();
  mockSessionUpdate.mockResolvedValue({});
  mockExecutionCreate.mockReset();
  mockExecutionCreate.mockResolvedValue({ id: 10 });
  mockExecutionUpdate.mockReset();
  mockExecutionUpdate.mockResolvedValue({});
  mockTaskUpdate.mockReset();
  mockTaskUpdate.mockResolvedValue({});
  mockTaskFindUnique.mockReset();
  mockTaskFindUnique.mockResolvedValue({ workflowStatus: 'in_progress' });
  mockWriteWorkflowFile.mockReset();
  mockWriteWorkflowFile.mockImplementation(
    async (_taskId: number, _type: string, content: string) => content,
  );
  mockExtractMarkdown.mockReset();
  mockExtractMarkdown.mockImplementation((output: string) => output);
  mockCallAnthropicAPI.mockReset();
  mockCallAnthropicAPI.mockResolvedValue('anthropic output');
  mockCallOpenAIAPI.mockReset();
  mockCallOpenAIAPI.mockResolvedValue('openai output');
  mockDecryptApiKey.mockReset();
  mockDecryptApiKey.mockImplementation((encrypted: string) => Promise.resolve(encrypted));
  mockResolveTaskWithTheme.mockReset();
  mockResolveTaskWithTheme.mockResolvedValue(null);
  mockAssessComplexity.mockReset();
  mockAssessComplexity.mockReturnValue({
    level: 'high',
    score: 80,
    reasons: [],
    canUseLocalLLM: false,
  });
  mockSendAIMessage.mockReset();
  mockSendAIMessage.mockResolvedValue({ content: 'local llm output', tokensUsed: 0 });
  mockWriteBlockedStatusDurable.mockReset();
  mockWriteBlockedStatusDurable.mockResolvedValue(true);
  mockValidateVerify.mockReset();
  mockValidateVerify.mockReturnValue({ ok: true, missingSections: [], severity: 0, summary: '' });
  mockAttemptVerifyRepair.mockReset();
  mockAttemptVerifyRepair.mockResolvedValue({ bounced: false });
  mockCriticRejectedSince.mockReset();
  mockCriticRejectedSince.mockResolvedValue(false);
  mockAdvanceWorkflow.mockClear();
  mockGetOrCreateDevConfig.mockClear();
  noopLog.info.mockClear();
  noopLog.error.mockClear();
}

async function run(
  overrides: {
    transition?: Partial<RoleTransition>;
    agentConfig?: Partial<typeof baseAgentConfig>;
    context?: string;
    assertOwnership?: () => void;
  } = {},
) {
  return executeAPIAgent(
    1,
    baseTask,
    { ...baseAgentConfig, ...overrides.agentConfig },
    'system prompt',
    overrides.context ?? 'context',
    makeTransition(overrides.transition),
    'ja',
    mockAdvanceWorkflow,
    mockGetOrCreateDevConfig,
    overrides.assertOwnership,
  );
}

describe('executeAPIAgent — stopped preparation', () => {
  beforeEach(resetMocks);

  test('stop during theme lookup prevents the provider call', async () => {
    let stopped = false;
    mockResolveTaskWithTheme.mockImplementation(async () => {
      stopped = true;
      return null;
    });
    await expect(
      run({
        assertOwnership: () => {
          if (stopped) throw new ExecutionCancelledError('ownership revoked');
        },
      }),
    ).rejects.toThrow('ownership revoked');
    expect(mockCallAnthropicAPI).not.toHaveBeenCalled();
    expect(mockSendAIMessage).not.toHaveBeenCalled();
    expect(mockWriteWorkflowFile).not.toHaveBeenCalled();
    expect(mockTaskUpdate).not.toHaveBeenCalled();
  });

  test('stop while awaiting provider output prevents saving or advancing', async () => {
    let stopped = false;
    mockCallAnthropicAPI.mockImplementation(async () => {
      stopped = true;
      return 'late output';
    });
    await expect(
      run({
        assertOwnership: () => {
          if (stopped) throw new ExecutionCancelledError('ownership revoked');
        },
      }),
    ).rejects.toThrow('ownership revoked');
    expect(mockWriteWorkflowFile).not.toHaveBeenCalled();
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockAdvanceWorkflow).not.toHaveBeenCalled();
  });
});

describe('executeAPIAgent — critic-rejection guard', () => {
  beforeEach(resetMocks);

  test('critic 差し戻し後は保存もステータス前進もせず失敗として返す', async () => {
    mockCriticRejectedSince.mockResolvedValue(true);
    const result = await run();

    expect(mockWriteWorkflowFile).not.toHaveBeenCalled();
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.executionId).toBe(10);
    // Session/execution rows are still closed so nothing is left dangling.
    expect(mockSessionUpdate).toHaveBeenCalled();
    expect(mockExecutionUpdate).toHaveBeenCalled();
  });
});

describe('executeAPIAgent — happy path dispatch', () => {
  beforeEach(resetMocks);

  test('calls the anthropic API by default and persists research.md', async () => {
    const result = await run();

    expect(mockCallAnthropicAPI).toHaveBeenCalledTimes(1);
    expect(mockCallOpenAIAPI).not.toHaveBeenCalled();
    expect(mockWriteWorkflowFile).toHaveBeenCalledWith(1, 'research', 'anthropic output');
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { workflowStatus: 'research_done' },
    });
    expect(result.success).toBe(true);
    expect(result.status).toBe('research_done');
    expect(result.executionId).toBe(10);
  });

  test('defaults the anthropic model when agentConfig.modelId is null', async () => {
    await run();
    const [, model] = mockCallAnthropicAPI.mock.calls[0] as [string, string, string, string];
    expect(model).toBe('claude-sonnet-4-20250514');
  });

  test('dispatches to the openai caller for agentType openai (no endpoint)', async () => {
    await run({ agentConfig: { agentType: 'openai', modelId: 'gpt-4o-mini' } });
    expect(mockCallOpenAIAPI).toHaveBeenCalledWith(
      '',
      'gpt-4o-mini',
      expect.any(String),
      'context',
    );
  });

  test('dispatches to the openai caller with a custom endpoint for azure-openai', async () => {
    await run({
      agentConfig: { agentType: 'azure-openai', endpoint: 'https://my-azure.example.com' },
    });
    expect(mockCallOpenAIAPI).toHaveBeenCalledWith(
      '',
      'gpt-4o',
      expect.any(String),
      'context',
      'https://my-azure.example.com',
    );
  });

  test('throws for an unsupported agentType, recording the execution as failed', async () => {
    await expect(run({ agentConfig: { agentType: 'unknown-type' } })).rejects.toThrow(
      '未対応のAPIエージェントタイプ: unknown-type',
    );
    expect(mockExecutionUpdate).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { status: 'failed', output: expect.stringContaining('未対応のAPIエージェントタイプ') },
    });
    expect(mockSessionUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { status: 'completed', completedAt: expect.any(Date) },
    });
  });

  test('decrypts the API key when one is configured', async () => {
    await run({ agentConfig: { apiKeyEncrypted: 'enc:abc' } });
    expect(mockDecryptApiKey).toHaveBeenCalledWith('enc:abc');
  });
});

describe('executeAPIAgent — local LLM routing', () => {
  beforeEach(resetMocks);

  test('uses the local LLM output and skips the paid API when complexity allows it', async () => {
    mockAssessComplexity.mockReturnValue({
      level: 'low',
      score: 10,
      reasons: ['short'],
      canUseLocalLLM: true,
    });

    const result = await run({
      transition: { role: 'verifier', outputFile: 'verify', nextStatus: 'verify_done' },
    });

    expect(mockSendAIMessage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'ollama', enableRAG: true }),
    );
    expect(mockCallAnthropicAPI).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  test('falls back to the paid API when the local LLM call fails', async () => {
    mockAssessComplexity.mockReturnValue({
      level: 'low',
      score: 10,
      reasons: [],
      canUseLocalLLM: true,
    });
    mockSendAIMessage.mockRejectedValue(new Error('ollama unreachable'));

    const result = await run();

    expect(mockCallAnthropicAPI).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });
});

describe('executeAPIAgent — theme working-directory directive', () => {
  beforeEach(resetMocks);

  test('injects the working-directory directive for the implementer role', async () => {
    mockResolveTaskWithTheme.mockResolvedValue({ theme: { workingDirectory: '/work/project' } });

    await run({ transition: { role: 'implementer', outputFile: null, nextStatus: 'verify_done' } });

    const [, , prompt] = mockCallAnthropicAPI.mock.calls[0] as [string, string, string, string];
    expect(prompt).toContain('/work/project');
  });

  test('does not inject the directive for a non-implementer role', async () => {
    mockResolveTaskWithTheme.mockResolvedValue({ theme: { workingDirectory: '/work/project' } });

    await run({
      transition: { role: 'researcher', outputFile: 'research', nextStatus: 'research_done' },
    });

    const [, , prompt] = mockCallAnthropicAPI.mock.calls[0] as [string, string, string, string];
    expect(prompt).not.toContain('/work/project');
  });
});

describe('executeAPIAgent — output persistence edge cases', () => {
  beforeEach(resetMocks);

  test('throws when outputFile is required but the agent produced blank output', async () => {
    mockCallAnthropicAPI.mockResolvedValue('   ');

    await expect(run()).rejects.toThrow('research.md was not generated');
    expect(mockWriteWorkflowFile).not.toHaveBeenCalled();
  });

  test('advances directly to nextStatus when the transition has no outputFile (implementer)', async () => {
    const result = await run({
      transition: { role: 'implementer', outputFile: null, nextStatus: 'verify_done' },
    });
    expect(mockWriteWorkflowFile).not.toHaveBeenCalled();
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { workflowStatus: 'verify_done' },
    });
    expect(result.status).toBe('verify_done');
  });

  test('falls back to the raw output when extractMarkdownFromOutput finds no report', async () => {
    mockExtractMarkdown.mockReturnValue(null);
    mockCallAnthropicAPI.mockResolvedValue('raw unwrapped output');

    await run();

    expect(mockWriteWorkflowFile).toHaveBeenCalledWith(1, 'research', 'raw unwrapped output');
  });

  test('truncates the persisted execution output to 10000 characters', async () => {
    mockCallAnthropicAPI.mockResolvedValue('x'.repeat(10050));
    await run();
    const call = mockExecutionUpdate.mock.calls[0]?.[0] as { data: { output: string } };
    expect(call.data.output.length).toBe(10000);
  });

  test('truncates the returned output to 2000 characters', async () => {
    mockCallAnthropicAPI.mockResolvedValue('y'.repeat(2500));
    const result = await run();
    expect(result.output?.length).toBe(2000);
  });
});

describe('executeAPIAgent — verify.md honesty gate', () => {
  beforeEach(resetMocks);

  function runVerify(context: string = 'context') {
    return run({
      transition: { role: 'verifier', outputFile: 'verify', nextStatus: 'verify_done' },
      context,
    });
  }

  test('advances normally when verify.md passes validation', async () => {
    mockValidateVerify.mockReturnValue({ ok: true, missingSections: [], severity: 0, summary: '' });
    const result = await runVerify();
    expect(mockAttemptVerifyRepair).not.toHaveBeenCalled();
    expect(result.status).toBe('verify_done');
    expect(mockTaskUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { workflowStatus: 'verify_done' },
    });
  });

  test('does not repair a low-severity validation failure', async () => {
    mockValidateVerify.mockReturnValue({
      ok: false,
      missingSections: ['x'],
      severity: 40,
      summary: 'minor gaps',
    });
    const result = await runVerify();
    expect(mockAttemptVerifyRepair).not.toHaveBeenCalled();
    expect(result.status).toBe('verify_done');
  });

  test('bounces back to the implementer when repair succeeds on a high-severity failure', async () => {
    mockValidateVerify.mockReturnValue({
      ok: false,
      missingSections: ['pass/fail'],
      severity: 90,
      summary: 'contradicts itself',
    });
    mockAttemptVerifyRepair.mockResolvedValue({
      bounced: true,
      newStatus: 'plan_approved',
      attempt: 1,
    });

    mockWriteWorkflowFile.mockResolvedValueOnce('persisted verification');
    const result = await runVerify();
    expect(mockValidateVerify).toHaveBeenCalledWith('persisted verification');

    expect(mockAttemptVerifyRepair).toHaveBeenCalledWith(
      1,
      'in_progress',
      'contradicts itself',
      'persisted verification',
    );
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(result.status).toBe('plan_approved');
  });

  test('blocks durably once repair attempts are exhausted, without advancing workflowStatus', async () => {
    mockValidateVerify.mockReturnValue({
      ok: false,
      missingSections: [],
      severity: 100,
      summary: 'exhausted repairs',
    });
    mockAttemptVerifyRepair.mockResolvedValue({ bounced: false });

    const result = await runVerify();

    expect(mockWriteBlockedStatusDurable).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 1, source: 'WorkflowAPIExecutor' }),
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('exhausted repairs');
    expect(mockTaskUpdate).not.toHaveBeenCalled();
    expect(mockSessionUpdate).toHaveBeenCalledWith({
      where: { id: 1 },
      data: expect.objectContaining({ status: 'failed' }),
    });
    expect(mockExecutionUpdate).toHaveBeenCalledWith({
      where: { id: 10 },
      data: expect.objectContaining({ status: 'completed' }),
    });
  });
});

describe('executeAPIAgent — implementer auto-advance', () => {
  beforeEach(resetMocks);

  test('schedules advanceWorkflow after the implementer phase completes', async () => {
    await run({ transition: { role: 'implementer', outputFile: null, nextStatus: 'verify_done' } });
    await new Promise((resolve) => setTimeout(resolve, 1050));
    expect(mockAdvanceWorkflow).toHaveBeenCalledWith(1, 'ja');
  });

  test('logs (instead of throwing unhandled) when the scheduled auto-advance rejects', async () => {
    mockAdvanceWorkflow.mockRejectedValueOnce(new Error('advance failed'));
    await run({ transition: { role: 'implementer', outputFile: null, nextStatus: 'verify_done' } });
    await new Promise((resolve) => setTimeout(resolve, 1050));
    expect(noopLog.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      '[WorkflowAPIExecutor] Failed to auto-advance to verifier',
    );
  });

  test('does not schedule an auto-advance for non-implementer roles', async () => {
    await run({
      transition: { role: 'researcher', outputFile: 'research', nextStatus: 'research_done' },
    });
    await new Promise((resolve) => setTimeout(resolve, 1050));
    expect(mockAdvanceWorkflow).not.toHaveBeenCalled();
  });
});
