/**
 * execution-handlers unit tests
 *
 * Covers setupQuestionDetectedHandler (question detection → DB + timeout +
 * event emission) and setupOutputHandler (streaming output → DB batching,
 * idea-marker extraction, callback/emit error isolation).
 */
import { describe, test, expect, mock, afterEach } from 'bun:test';

// ── Module-level mocks (before dynamic import) ─────────────────────────────

mock.module('../../../config/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  getBackendLogFilePath: () => '/tmp/fake.log',
}));

const extractIdeaMarkers = mock(() => {});
mock.module('./idea-extractor', () => ({ extractIdeaMarkers }));

const { setupQuestionDetectedHandler, setupOutputHandler } = await import('./execution-handlers');
const { DEFAULT_QUESTION_TIMEOUT_SECONDS } = await import('../question-detection');

import type { QuestionHandlerContext, OutputHandlerContext } from './execution-helpers-types';
import type { ExecutionState, OrchestratorEvent, ActiveAgentInfo } from './types';
import type { BaseAgent, QuestionDetectedHandler, AgentOutputHandler } from '../base-agent';
import type { LogChunkManager } from './log-chunk-manager';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Fake agent that just captures whichever handler gets registered on it. */
function makeFakeAgent(): {
  agent: BaseAgent;
  getQuestionHandler: () => QuestionDetectedHandler;
  getOutputHandler: () => AgentOutputHandler;
} {
  let questionHandler: QuestionDetectedHandler | undefined;
  let outputHandler: AgentOutputHandler | undefined;
  const agent = {
    setQuestionDetectedHandler: (h: QuestionDetectedHandler) => {
      questionHandler = h;
    },
    setOutputHandler: (h: AgentOutputHandler) => {
      outputHandler = h;
    },
  } as unknown as BaseAgent;
  return {
    agent,
    getQuestionHandler: () => {
      if (!questionHandler) throw new Error('handler not registered');
      return questionHandler;
    },
    getOutputHandler: () => {
      if (!outputHandler) throw new Error('handler not registered');
      return outputHandler;
    },
  };
}

function makeState(): ExecutionState {
  return {
    executionId: 1,
    sessionId: 10,
    agentId: 'agent-1',
    taskId: 100,
    status: 'running',
    startedAt: new Date(),
    output: '',
  };
}

function makeQuestionCtx(overrides: Partial<QuestionHandlerContext> = {}): QuestionHandlerContext {
  return {
    prisma: {
      agentExecution: { update: mock(async () => ({})) },
    } as unknown as QuestionHandlerContext['prisma'],
    executionId: 1,
    sessionId: 10,
    taskId: 100,
    state: makeState(),
    fileLogger: {
      logQuestionDetected: mock(() => {}),
    } as unknown as QuestionHandlerContext['fileLogger'],
    existingClaudeSessionId: null,
    emitEvent: mock((_e: OrchestratorEvent) => {}),
    startQuestionTimeout: mock(() => {}),
    getQuestionTimeoutInfo: mock(() => null),
    ...overrides,
  };
}

function makeOutputCtx(overrides: Partial<OutputHandlerContext> = {}): OutputHandlerContext {
  const state = makeState();
  const agentInfo = {
    lastOutput: '',
    lastSavedAt: new Date(),
  } as unknown as ActiveAgentInfo;
  return {
    prisma: {
      agentExecution: { updateMany: mock(async () => ({})) },
    } as unknown as OutputHandlerContext['prisma'],
    executionId: 1,
    sessionId: 10,
    taskId: 100,
    state,
    agentInfo,
    fileLogger: { logOutput: mock(() => {}) } as unknown as OutputHandlerContext['fileLogger'],
    emitEvent: mock((_e: OrchestratorEvent) => {}),
    ...overrides,
  };
}

const cleanupManagers: LogChunkManager[] = [];
afterEach(async () => {
  await Promise.all(cleanupManagers.splice(0).map((manager) => manager.cleanup()));
});
function makeLogManager(): LogChunkManager {
  const handlers: Array<() => Promise<void>> = [];
  const manager = {
    addChunk: mock(() => {}),
    registerCleanup: (handler: () => Promise<void>) => handlers.push(handler),
    cleanup: async () => {
      await Promise.all(handlers.map((handler) => handler()));
    },
    flushLogChunks: mock(async () => {}),
  } as unknown as LogChunkManager;
  cleanupManagers.push(manager);
  return manager;
}

// ── setupQuestionDetectedHandler ──────────────────────────────────────────

describe('setupQuestionDetectedHandler', () => {
  test('persists the question to the DB and flips state to waiting_for_input', async () => {
    const ctx = makeQuestionCtx();
    const { agent, getQuestionHandler } = makeFakeAgent();
    setupQuestionDetectedHandler(agent, ctx);

    await getQuestionHandler()({
      question: '続行しますか？',
      questionType: 'confirmation',
      questionDetails: { options: [{ label: 'yes' }] },
      claudeSessionId: 'sess-abc',
    });

    const prisma = ctx.prisma as unknown as { agentExecution: { update: ReturnType<typeof mock> } };
    expect(prisma.agentExecution.update).toHaveBeenCalledTimes(1);
    const call = prisma.agentExecution.update.mock.calls[0][0] as {
      where: { id: number };
      data: { status: string; question: string; claudeSessionId: string };
    };
    expect(call.where).toEqual({ id: 1 });
    expect(call.data.status).toBe('waiting_for_input');
    expect(call.data.question).toBe('続行しますか？');
    expect(call.data.claudeSessionId).toBe('sess-abc');
    expect(ctx.state.status).toBe('waiting_for_input');
  });

  test('falls back to the existing claude session id when the new one is absent', async () => {
    const ctx = makeQuestionCtx({ existingClaudeSessionId: 'existing-session' });
    const { agent, getQuestionHandler } = makeFakeAgent();
    setupQuestionDetectedHandler(agent, ctx);

    await getQuestionHandler()({ question: 'q', questionType: 'clarification' });

    const prisma = ctx.prisma as unknown as { agentExecution: { update: ReturnType<typeof mock> } };
    const call = prisma.agentExecution.update.mock.calls[0][0] as {
      data: { claudeSessionId: string | null };
    };
    expect(call.data.claudeSessionId).toBe('existing-session');
  });

  test('claudeSessionId is null when neither the event nor the context provide one', async () => {
    const ctx = makeQuestionCtx({ existingClaudeSessionId: null });
    const { agent, getQuestionHandler } = makeFakeAgent();
    setupQuestionDetectedHandler(agent, ctx);

    await getQuestionHandler()({ question: 'q', questionType: 'clarification' });

    const prisma = ctx.prisma as unknown as { agentExecution: { update: ReturnType<typeof mock> } };
    const call = prisma.agentExecution.update.mock.calls[0][0] as {
      data: { claudeSessionId: string | null };
    };
    expect(call.data.claudeSessionId).toBeNull();
  });

  test('starts the question timeout and emits the countdown deadline from an active timeout', async () => {
    const deadline = new Date('2026-01-01T00:05:00Z');
    const startQuestionTimeout = mock(() => {});
    const getQuestionTimeoutInfo = mock(() => ({
      remainingSeconds: 42,
      deadline,
      questionKey: undefined,
    }));
    const emitEvent = mock((_e: OrchestratorEvent) => {});
    const ctx = makeQuestionCtx({ startQuestionTimeout, getQuestionTimeoutInfo, emitEvent });
    const { agent, getQuestionHandler } = makeFakeAgent();
    setupQuestionDetectedHandler(agent, ctx);

    await getQuestionHandler()({
      question: 'q',
      questionType: 'selection',
      questionKey: { question_type: 'selection' } as never,
    });

    expect(startQuestionTimeout).toHaveBeenCalledWith(1, 100, { question_type: 'selection' });
    expect(emitEvent).toHaveBeenCalledTimes(1);
    const event = emitEvent.mock.calls[0][0];
    expect(event.data).toMatchObject({
      waitingForInput: true,
      questionTimeoutSeconds: 42,
      questionTimeoutDeadline: deadline.toISOString(),
    });
  });

  test('falls back to the default timeout seconds when no timeout info is available', async () => {
    const emitEvent = mock((_e: OrchestratorEvent) => {});
    const ctx = makeQuestionCtx({ getQuestionTimeoutInfo: mock(() => null), emitEvent });
    const { agent, getQuestionHandler } = makeFakeAgent();
    setupQuestionDetectedHandler(agent, ctx);

    await getQuestionHandler()({ question: 'q', questionType: 'clarification' });

    const event = emitEvent.mock.calls[0][0];
    expect(event.data).toMatchObject({ questionTimeoutSeconds: DEFAULT_QUESTION_TIMEOUT_SECONDS });
    expect(
      (event.data as { questionTimeoutDeadline?: string }).questionTimeoutDeadline,
    ).toBeUndefined();
  });

  test('a DB failure is caught and does not throw out of the handler', async () => {
    const update = mock(async () => {
      throw new Error('db down');
    });
    const ctx = makeQuestionCtx({
      prisma: {
        agentExecution: { updateMany: update },
      } as unknown as QuestionHandlerContext['prisma'],
    });
    const { agent, getQuestionHandler } = makeFakeAgent();
    setupQuestionDetectedHandler(agent, ctx);

    await expect(
      getQuestionHandler()({ question: 'q', questionType: 'clarification' }),
    ).resolves.toBeUndefined();
  });
});

// ── setupOutputHandler ────────────────────────────────────────────────────

describe('setupOutputHandler', () => {
  test('appends output, mirrors to the file logger and log manager', async () => {
    const ctx = makeOutputCtx();
    const logManager = makeLogManager();
    const { agent, getOutputHandler } = makeFakeAgent();
    setupOutputHandler(agent, ctx, logManager);

    await getOutputHandler()('hello', false);

    expect(ctx.state.output).toBe('hello');
    expect(ctx.fileLogger.logOutput).toHaveBeenCalledWith('hello', false);
    expect(logManager.addChunk).toHaveBeenCalledWith('hello', false);
    expect(ctx.agentInfo.lastOutput).toBe('hello');
    expect(ctx.emitEvent).toHaveBeenCalledTimes(1);
  });

  test('truncates agentInfo.lastOutput to the final 2000 characters', async () => {
    const ctx = makeOutputCtx();
    const logManager = makeLogManager();
    const { agent, getOutputHandler } = makeFakeAgent();
    setupOutputHandler(agent, ctx, logManager);
    const big = 'a'.repeat(2500) + 'TAIL';

    await getOutputHandler()(big, false);

    expect(ctx.agentInfo.lastOutput.length).toBe(2000);
    expect(ctx.agentInfo.lastOutput.endsWith('TAIL')).toBe(true);
  });

  test('non-empty error output is saved to the DB immediately', async () => {
    const update = mock(async () => ({}));
    const ctx = makeOutputCtx({
      prisma: {
        agentExecution: { updateMany: update },
      } as unknown as OutputHandlerContext['prisma'],
    });
    const logManager = makeLogManager();
    const { agent, getOutputHandler } = makeFakeAgent();
    setupOutputHandler(agent, ctx, logManager);

    await getOutputHandler()('boom', true);

    expect(update).toHaveBeenCalledTimes(1);
    const call = update.mock.calls[0][0] as { data: { errorMessage: string } };
    expect(call.data.errorMessage).toBe('boom');
  });

  test('whitespace-only error output does not trigger the immediate DB write', async () => {
    const update = mock(async () => ({}));
    const ctx = makeOutputCtx({
      prisma: {
        agentExecution: { updateMany: update },
      } as unknown as OutputHandlerContext['prisma'],
    });
    const logManager = makeLogManager();
    const { agent, getOutputHandler } = makeFakeAgent();
    setupOutputHandler(agent, ctx, logManager);

    await getOutputHandler()('   ', true);

    expect(update).not.toHaveBeenCalled();
  });

  test('invokes the onOutput callback and isolates it from a thrown error', async () => {
    const onOutput = mock(() => {
      throw new Error('callback exploded');
    });
    const ctx = makeOutputCtx({ onOutput });
    const logManager = makeLogManager();
    const { agent, getOutputHandler } = makeFakeAgent();
    setupOutputHandler(agent, ctx, logManager);

    await expect(getOutputHandler()('hello', false)).resolves.toBeUndefined();
    expect(onOutput).toHaveBeenCalledWith('hello', false);
    // NOTE: the callback throwing must not prevent the rest of the pipeline
    // (event emission) from running.
    expect(ctx.emitEvent).toHaveBeenCalledTimes(1);
  });

  test('a throwing emitEvent is isolated and does not stop idea-marker extraction', async () => {
    extractIdeaMarkers.mockClear();
    const emitEvent = mock(() => {
      throw new Error('emit exploded');
    });
    const ctx = makeOutputCtx({ emitEvent });
    const logManager = makeLogManager();
    const { agent, getOutputHandler } = makeFakeAgent();
    setupOutputHandler(agent, ctx, logManager);

    await expect(getOutputHandler()('[IDEA] use fewer icons', false)).resolves.toBeUndefined();
    expect(extractIdeaMarkers).toHaveBeenCalledWith('[IDEA] use fewer icons', 100);
  });

  test('extracts idea markers only for non-error output', async () => {
    extractIdeaMarkers.mockClear();
    const ctx = makeOutputCtx();
    const logManager = makeLogManager();
    const { agent, getOutputHandler } = makeFakeAgent();
    setupOutputHandler(agent, ctx, logManager);

    await getOutputHandler()('[IDEA] should not fire on stderr', true);
    expect(extractIdeaMarkers).not.toHaveBeenCalled();

    await getOutputHandler()('[IDEA] should fire', false);
    expect(extractIdeaMarkers).toHaveBeenCalledWith('[IDEA] should fire', 100);
  });

  test('does not extract idea markers when the marker is absent', async () => {
    extractIdeaMarkers.mockClear();
    const ctx = makeOutputCtx();
    const logManager = makeLogManager();
    const { agent, getOutputHandler } = makeFakeAgent();
    setupOutputHandler(agent, ctx, logManager);

    await getOutputHandler()('plain output', false);

    expect(extractIdeaMarkers).not.toHaveBeenCalled();
  });

  test('persists each burst after the batch interval even without another chunk', async () => {
    const update = mock(async () => ({}));
    const ctx = makeOutputCtx({
      prisma: {
        agentExecution: { updateMany: update },
      } as unknown as OutputHandlerContext['prisma'],
    });
    const logManager = makeLogManager();
    const { agent, getOutputHandler } = makeFakeAgent();
    setupOutputHandler(agent, ctx, logManager);

    await getOutputHandler()('first chunk', false);
    expect(update).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(update).toHaveBeenCalledTimes(1);
    expect((update.mock.calls[0][0] as { data: { output: string } }).data.output).toBe(
      'first chunk',
    );
    await getOutputHandler()('second chunk', false);
    await logManager.cleanup();
    expect(update).toHaveBeenCalledTimes(2);
    expect((update.mock.calls[1][0] as { data: { output: string } }).data.output).toBe(
      'first chunksecond chunk',
    );
  });

  test('a synchronous throw inside the pipeline is caught by the outer guard', async () => {
    const fileLogger = {
      logOutput: mock(() => {
        throw new Error('logger exploded');
      }),
    } as unknown as OutputHandlerContext['fileLogger'];
    const ctx = makeOutputCtx({ fileLogger });
    const logManager = makeLogManager();
    const { agent, getOutputHandler } = makeFakeAgent();
    setupOutputHandler(agent, ctx, logManager);

    await expect(getOutputHandler()('hello', false)).resolves.toBeUndefined();
  });
});

test('persists the final output burst even when no later output arrives', async () => {
  const update = mock(async () => ({}));
  const ctx = makeOutputCtx({
    prisma: { agentExecution: { updateMany: update } } as unknown as OutputHandlerContext['prisma'],
  });
  const { agent, getOutputHandler } = makeFakeAgent();
  setupOutputHandler(agent, ctx, makeLogManager());
  await getOutputHandler()('Starting execution\n', false);
  await getOutputHandler()('Process PID: 12345\n', false);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(update).toHaveBeenCalledWith({
    where: { id: ctx.executionId, status: { in: ['running', 'waiting_for_input'] } },
    data: { output: 'Starting execution\nProcess PID: 12345\n' },
  });
});
