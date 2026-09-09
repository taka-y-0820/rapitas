/**
 * fallback-executor テスト
 *
 * 未分類エラー(no_candidate)時のLLM診断呼び出し(task 612)が
 * fire-and-forget であり、executeWithFallbackAgent のreturnを
 * ブロックしないことを検証する。診断側に人為的な遅延Promiseを仕込み、
 * 関数呼び出しからのreturnがその解決を待たずに完了することを確認する。
 * NOTE: mock.module はプロセスグローバル。
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test';
import type { FallbackContext } from './fallback-executor';
import type { AgentConfigInput } from '../agent-factory';

const createAgentMock = mock(() => ({}) as unknown);
mock.module('../agent-factory', () => ({
  agentFactory: { createAgent: createAgentMock, removeAgent: mock(async () => {}) },
}));
mock.module('./execution-helpers', () => ({
  setupQuestionDetectedHandler: mock(() => {}),
  setupOutputHandler: mock(() => {}),
}));

const findFallbackAgentConfigMock = mock(async () => null as unknown);
const agentTypeToProviderMock = mock((_type: string) => 'openai' as string | undefined);
mock.module('../../ai/agent-fallback', () => ({
  findFallbackAgentConfig: findFallbackAgentConfigMock,
  agentTypeToProvider: agentTypeToProviderMock,
}));

const classifyAgentErrorMock = mock((_blob: string, _hint?: unknown) => null as unknown);
mock.module('../../ai/agent-error-classifier', () => ({
  classifyAgentError: classifyAgentErrorMock,
}));

const recordRecoveryAttemptMock = mock(() => {});
mock.module('../../ai/recovery-metrics', () => ({
  recordRecoveryAttempt: recordRecoveryAttemptMock,
}));

let diagnosisResolved = false;
const diagnoseErrorWithLlmMock = mock(
  () =>
    new Promise<void>((resolve) => {
      setTimeout(() => {
        diagnosisResolved = true;
        resolve();
      }, 200);
    }),
);
mock.module('../../ai/error-diagnosis', () => ({
  diagnoseErrorWithLlm: diagnoseErrorWithLlmMock,
}));

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
mock.module('../../../config/logger', () => ({
  logger: noopLogger,
  createLogger: () => noopLogger,
}));

const { executeWithFallbackAgent } = await import('./fallback-executor');

const runningExecution = async () => ({ status: 'running', session: { status: 'active' } });
const FALLBACK_CTX = {
  options: { taskId: 612 },
  execution: { id: 1 },
  state: { status: 'running' },
  ctx: { prisma: { agentExecution: { findUnique: runningExecution } } },
} as unknown as FallbackContext;
const ORIGINAL_AGENT_CONFIG = {
  type: 'claude-code',
  name: 'primary',
  modelId: 'sonnet',
} as unknown as AgentConfigInput;

test('durable cancellation prevents provider classification and fallback startup', async () => {
  findFallbackAgentConfigMock.mockClear();
  findFallbackAgentConfigMock.mockImplementation(async () => null);
  const stopped = {
    ctx: {
      prisma: {
        agentExecution: {
          findUnique: async () => ({ status: 'cancelled', session: { status: 'cancelled' } }),
        },
      },
    },
    execution: { id: 3947 },
    state: { status: 'running' },
    options: { taskId: 913, sessionId: 4013 },
    fileLogger: { logWarn: () => {} },
  } as unknown as FallbackContext;
  const result = await executeWithFallbackAgent(
    stopped,
    'gemini rate limit 429',
    ORIGINAL_AGENT_CONFIG,
  );
  expect(findFallbackAgentConfigMock).not.toHaveBeenCalled();
  expect(result.result.failureType).toBe('cancelled');
  expect(result.fallbackSucceeded).toBe(false);
});

describe('executeWithFallbackAgent — no_candidate診断のfire-and-forget', () => {
  beforeEach(() => {
    diagnosisResolved = false;
    findFallbackAgentConfigMock.mockClear();
    findFallbackAgentConfigMock.mockImplementation(async () => null);
    classifyAgentErrorMock.mockClear();
    classifyAgentErrorMock.mockImplementation(() => null);
    recordRecoveryAttemptMock.mockClear();
    diagnoseErrorWithLlmMock.mockClear();
  });

  test('LLM診断呼び出しが遅延していても no_candidate の応答をブロックしない', async () => {
    const result = await executeWithFallbackAgent(
      FALLBACK_CTX,
      'some unclassified provider error',
      ORIGINAL_AGENT_CONFIG,
    );

    expect(result.fallbackSucceeded).toBe(false);
    // The diagnosis promise takes 200ms — if it had been awaited, this
    // assertion would run after `diagnosisResolved` flips to true.
    expect(diagnosisResolved).toBe(false);
  });

  test('errorBlobが空文字ならLLM診断を呼び出さない', async () => {
    await executeWithFallbackAgent(FALLBACK_CTX, '', ORIGINAL_AGENT_CONFIG);

    expect(diagnoseErrorWithLlmMock).not.toHaveBeenCalled();
  });

  test('classifyAgentErrorが分類できた場合はLLM診断を呼び出さない', async () => {
    classifyAgentErrorMock.mockImplementation(() => ({
      reason: 'rate_limit',
      provider: 'openai',
      retryWithFallback: true,
      rawMessage: 'rate limited',
    }));

    await executeWithFallbackAgent(FALLBACK_CTX, 'rate limited error', ORIGINAL_AGENT_CONFIG);

    expect(diagnoseErrorWithLlmMock).not.toHaveBeenCalled();
  });
});

const FALLBACK_CTX_RETRY = {
  ctx: {
    buildAgentConfigFromDb: async () => ({
      type: 'gemini-cli',
      name: 'fallback-gemini',
      modelId: null,
    }),
    emitEvent: () => {},
    prisma: { agentExecution: { update: async () => {}, findUnique: runningExecution } },
  },
  execution: { id: 1 },
  state: { output: '' },
  fileLogger: { logOutput: () => {} },
  logManager: { addChunk: () => {} },
  agentInfo: {},
  taskWithAnalysis: {},
  options: { taskId: 898, sessionId: 1 },
} as unknown as FallbackContext;

describe('executeWithFallbackAgent — retryEvidence は成功時に output 全体を分類対象へ混入させない (task 898)', () => {
  beforeEach(() => {
    findFallbackAgentConfigMock.mockClear();
    findFallbackAgentConfigMock.mockImplementation(async () => ({
      agentConfig: { id: 99, agentType: 'gemini-cli', name: 'fallback-gemini' },
      classified: { provider: 'gemini', reason: 'rate_limit' },
    }));
    classifyAgentErrorMock.mockClear();
    classifyAgentErrorMock.mockImplementation(() => null);
    recordRecoveryAttemptMock.mockClear();
    createAgentMock.mockClear();
  });

  test('stop during fallback configuration prevents the prepared agent from executing', async () => {
    let cancelled = false;
    const execute = mock(async () => ({ success: true }));
    createAgentMock.mockImplementation(() => ({ id: 'stopped-fallback', execute }));
    const context = {
      ...FALLBACK_CTX_RETRY,
      fileLogger: { logOutput: () => {}, logWarn: () => {} },
      ctx: {
        ...FALLBACK_CTX_RETRY.ctx,
        prisma: {
          agentExecution: {
            findUnique: async () => ({
              status: cancelled ? 'cancelled' : 'running',
              session: { status: 'active' },
            }),
            update: async () => {
              cancelled = true;
            },
          },
        },
      },
    } as unknown as FallbackContext;
    const result = await executeWithFallbackAgent(context, '429 rate limit', ORIGINAL_AGENT_CONFIG);
    expect(execute).not.toHaveBeenCalled();
    expect(result.result.failureType).toBe('cancelled');
    expect(result.fallbackSucceeded).toBe(false);
  });

  test('revoked workflow ownership prevents fallback launch even with a running DB row', async () => {
    const execute = mock(async () => ({ success: true }));
    createAgentMock.mockImplementation(() => ({ id: 'revoked-fallback', execute }));
    const pending = executeWithFallbackAgent(
      {
        ...FALLBACK_CTX_RETRY,
        options: {
          ...FALLBACK_CTX_RETRY.options,
          assertExecutionAllowed: () => {
            throw new Error('workflow ownership revoked');
          },
        },
      },
      '429 rate limit',
      ORIGINAL_AGENT_CONFIG,
    );
    await expect(pending).rejects.toThrow('workflow ownership revoked');
    expect(execute).not.toHaveBeenCalled();
  });

  test('成功+errorMessage無し+output本文に429を含む場合、classifyAgentErrorは呼ばれずfallbackSucceededはtrue', async () => {
    createAgentMock.mockImplementation(() => ({
      id: 'fb-1',
      execute: mock(async () => ({
        success: true,
        output: 'plan discusses 429 handling',
        errorMessage: undefined,
        executionTimeMs: 10,
        costUsd: 0,
      })),
    }));

    const result = await executeWithFallbackAgent(
      FALLBACK_CTX_RETRY,
      'original error',
      ORIGINAL_AGENT_CONFIG,
    );

    expect(classifyAgentErrorMock).not.toHaveBeenCalled();
    expect(result.fallbackSucceeded).toBe(true);
  });

  test('成功+errorMessageに明示的な429を含む場合、classifyAgentErrorにはerrorMessageのみが渡りoutputは混入しない', async () => {
    createAgentMock.mockImplementation(() => ({
      id: 'fb-1',
      execute: mock(async () => ({
        success: true,
        output: '(long unrelated output)',
        errorMessage: '429 Too Many Requests',
        executionTimeMs: 10,
        costUsd: 0,
      })),
    }));

    await executeWithFallbackAgent(FALLBACK_CTX_RETRY, 'original error', ORIGINAL_AGENT_CONFIG);

    expect(classifyAgentErrorMock).toHaveBeenCalled();
    const [evidenceArg] = classifyAgentErrorMock.mock.calls[0] as [string, unknown];
    expect(evidenceArg).toBe('429 Too Many Requests');
    expect(evidenceArg).not.toContain('long unrelated output');
  });
});
