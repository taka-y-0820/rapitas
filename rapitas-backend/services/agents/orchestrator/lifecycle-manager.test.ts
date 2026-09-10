/**
 * lifecycle-manager unit tests
 *
 * Covers saveAgentState / saveAllAgentStates / gracefulShutdown / setupSignalHandlers.
 * process.on / process.exit are stubbed for setupSignalHandlers so no real
 * signal listener is attached and no test-process-wide exit can be triggered.
 */
import { describe, test, expect, mock, spyOn, beforeEach } from 'bun:test';

// ── Module-level mocks (before dynamic import) ─────────────────────────────

mock.module('../../../config/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  getBackendLogFilePath: () => '/tmp/fake.log',
}));

const mockStopAllPreviewSessions = mock(() => Promise.resolve());
mock.module('../preview/preview-session-manager', () => ({
  stopAllPreviewSessions: mockStopAllPreviewSessions,
}));

const mockRecordTransition = mock(() => Promise.resolve());
mock.module('../../workflow/transition-recorder', () => ({
  recordTransition: mockRecordTransition,
}));

const { saveAgentState, saveAllAgentStates, gracefulShutdown, setupSignalHandlers } =
  await import('./lifecycle-manager');

import type { LifecycleContext } from './lifecycle-manager';
import type { ActiveAgentInfo, ExecutionState, PrismaClientInstance } from './types';
import type { QuestionTimeoutManager } from './question-timeout-manager';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAgentInfo(overrides: Partial<ActiveAgentInfo> = {}): ActiveAgentInfo {
  const state: ExecutionState = {
    executionId: 1,
    sessionId: 10,
    agentId: 'agent-1',
    taskId: 100,
    status: 'running',
    startedAt: new Date(),
    output: 'some output',
  };
  return {
    agent: { stop: mock(() => Promise.resolve()) } as unknown as ActiveAgentInfo['agent'],
    executionId: 1,
    sessionId: 10,
    taskId: 100,
    state,
    lastOutput: 'last chunk of output',
    lastSavedAt: new Date(),
    ...overrides,
  };
}

function makePrisma(
  overrides: {
    agentExecutionUpdate?: ReturnType<typeof mock>;
    agentSessionUpdate?: ReturnType<typeof mock>;
    taskFindUnique?: ReturnType<typeof mock>;
    taskUpdate?: ReturnType<typeof mock>;
  } = {},
): PrismaClientInstance {
  return {
    agentExecution: {
      updateMany: overrides.agentExecutionUpdate ?? mock(async () => ({ count: 1 })),
    },
    agentSession: { updateMany: overrides.agentSessionUpdate ?? mock(async () => ({ count: 1 })) },
    task: {
      findUnique:
        overrides.taskFindUnique ??
        mock(async () => ({ id: 100, status: 'in-progress', workflowStatus: 'in_progress' })),
      updateMany: overrides.taskUpdate ?? mock(async () => ({ count: 1 })),
    },
  } as unknown as PrismaClientInstance;
}

function makeCtx(overrides: Partial<LifecycleContext> = {}): LifecycleContext {
  let shuttingDown = false;
  return {
    prisma: makePrisma(),
    activeAgents: new Map(),
    activeExecutions: new Map(),
    questionTimeoutManager: {
      cancelAllTimeouts: mock(() => {}),
      clearAllLocks: mock(() => {}),
    } as unknown as QuestionTimeoutManager,
    serverStopCallback: null,
    getIsShuttingDown: () => shuttingDown,
    setIsShuttingDown: (value: boolean) => {
      shuttingDown = value;
    },
    ...overrides,
  };
}

// ── saveAgentState ────────────────────────────────────────────────────────

describe('saveAgentState', () => {
  for (const terminal of ['canceling', 'cancelled', 'completed', 'failed']) {
    test(`shutdown preserves ${terminal} execution and leaves its session/task alone`, async () => {
      let stored = terminal;
      const update = mock(
        async (args: { where: { status: { in: string[] } }; data: { status: string } }) => {
          if (!args.where.status.in.includes(stored)) return { count: 0 };
          stored = args.data.status;
          return { count: 1 };
        },
      );
      const session = mock(async () => ({ count: 1 }));
      const task = mock(async () => ({ count: 1 }));
      await saveAgentState(
        makePrisma({ agentExecutionUpdate: update, agentSessionUpdate: session, taskUpdate: task }),
        1,
        makeAgentInfo(),
        'interrupted',
      );
      expect(stored).toBe(terminal);
      expect(session).not.toHaveBeenCalled();
      expect(task).not.toHaveBeenCalled();
    });
  }
  test('a stop between task read and update does not emit a false revert transition', async () => {
    mockRecordTransition.mockClear();
    const update = mock(async () => ({ count: 0 }));
    await saveAgentState(makePrisma({ taskUpdate: update }), 1, makeAgentInfo(), 'interrupted');
    expect(update).toHaveBeenCalledWith({
      where: { id: 100, status: 'in-progress', workflowStatus: 'in_progress' },
      data: { status: 'todo' },
    });
    expect(mockRecordTransition).not.toHaveBeenCalled();
  });
  test('interrupted status writes a Japanese "interrupted" error message', async () => {
    const update = mock(async () => ({ count: 1 }));
    const prisma = makePrisma({ agentExecutionUpdate: update });
    const info = makeAgentInfo();

    await saveAgentState(prisma, 1, info, 'interrupted');

    expect(update).toHaveBeenCalledTimes(1);
    const call = update.mock.calls[0][0] as {
      where: { id: number };
      data: { errorMessage: string; status: string };
    };
    expect(call.where).toEqual({
      id: 1,
      status: { in: ['pending', 'running', 'waiting_for_input', 'interrupted'] },
    });
    expect(call.data.status).toBe('interrupted');
    expect(call.data.errorMessage).toContain('中断されました');
  });

  test('failed status writes a Japanese "abnormal termination" error message', async () => {
    const update = mock(async () => ({ count: 1 }));
    const prisma = makePrisma({ agentExecutionUpdate: update });
    const info = makeAgentInfo();

    await saveAgentState(prisma, 1, info, 'failed');

    const call = update.mock.calls[0][0] as { data: { errorMessage: string; status: string } };
    expect(call.data.status).toBe('failed');
    expect(call.data.errorMessage).toContain('異常終了しました');
  });

  test('truncates lastOutput to the final 1000 characters in the message', async () => {
    const update = mock(async () => ({ count: 1 }));
    const prisma = makePrisma({ agentExecutionUpdate: update });
    const info = makeAgentInfo({ lastOutput: 'x'.repeat(1500) + 'TAIL' });

    await saveAgentState(prisma, 1, info, 'interrupted');

    const call = update.mock.calls[0][0] as { data: { errorMessage: string } };
    expect(call.data.errorMessage.endsWith('TAIL')).toBe(true);
    expect(call.data.errorMessage.length).toBeLessThan(1100);
  });

  test('session update failure is swallowed and does not block task revert', async () => {
    const sessionUpdate = mock(async () => {
      throw new Error('session db error');
    });
    const taskUpdate = mock(async () => ({ count: 1 }));
    const prisma = makePrisma({ agentSessionUpdate: sessionUpdate, taskUpdate });
    const info = makeAgentInfo();

    await expect(saveAgentState(prisma, 1, info, 'interrupted')).resolves.toBeUndefined();
    expect(taskUpdate).toHaveBeenCalledTimes(1);
  });

  test('reverts an in-progress task back to todo', async () => {
    const taskUpdate = mock(async () => ({ count: 1 }));
    const taskFindUnique = mock(async () => ({ id: 100, status: 'in-progress' }));
    const prisma = makePrisma({ taskFindUnique, taskUpdate });
    const info = makeAgentInfo();

    await saveAgentState(prisma, 1, info, 'interrupted');

    expect(taskUpdate).toHaveBeenCalledWith({
      where: { id: 100, status: 'in-progress', workflowStatus: undefined },
      data: { status: 'todo' },
    });
  });

  test('records a workflow transition when reverting an in-progress task', async () => {
    mockRecordTransition.mockClear();
    const taskFindUnique = mock(async () => ({
      id: 100,
      status: 'in-progress',
      workflowStatus: 'in_progress',
    }));
    const prisma = makePrisma({ taskFindUnique });
    const info = makeAgentInfo({ taskId: 100 });

    await saveAgentState(prisma, 1, info, 'interrupted');

    expect(mockRecordTransition).toHaveBeenCalledTimes(1);
    expect(mockRecordTransition.mock.calls[0][0]).toMatchObject({
      taskId: 100,
      fromStatus: 'in_progress',
      toStatus: 'in_progress',
      cause: 'agent_lifecycle_shutdown_revert',
    });
  });

  test('does not touch a task that is not in-progress', async () => {
    const taskUpdate = mock(async () => ({ count: 1 }));
    const taskFindUnique = mock(async () => ({ id: 100, status: 'done' }));
    const prisma = makePrisma({ taskFindUnique, taskUpdate });
    const info = makeAgentInfo();

    await saveAgentState(prisma, 1, info, 'interrupted');

    expect(taskUpdate).not.toHaveBeenCalled();
  });

  test('does not record a transition for a task that is not in-progress', async () => {
    mockRecordTransition.mockClear();
    const taskFindUnique = mock(async () => ({
      id: 100,
      status: 'done',
      workflowStatus: 'completed',
    }));
    const prisma = makePrisma({ taskFindUnique });
    const info = makeAgentInfo();

    await saveAgentState(prisma, 1, info, 'interrupted');

    expect(mockRecordTransition).not.toHaveBeenCalled();
  });

  test('missing task is handled without throwing or updating', async () => {
    const taskUpdate = mock(async () => ({ count: 1 }));
    const taskFindUnique = mock(async () => null);
    const prisma = makePrisma({ taskFindUnique, taskUpdate });
    const info = makeAgentInfo();

    await expect(saveAgentState(prisma, 1, info, 'interrupted')).resolves.toBeUndefined();
    expect(taskUpdate).not.toHaveBeenCalled();
  });

  test('task lookup failure is swallowed', async () => {
    const taskFindUnique = mock(async () => {
      throw new Error('lookup failed');
    });
    const prisma = makePrisma({ taskFindUnique });
    const info = makeAgentInfo();

    await expect(saveAgentState(prisma, 1, info, 'interrupted')).resolves.toBeUndefined();
  });
});

// ── saveAllAgentStates ────────────────────────────────────────────────────

describe('saveAllAgentStates', () => {
  test('saves state for every active agent', async () => {
    const update = mock(async () => ({ count: 1 }));
    const prisma = makePrisma({ agentExecutionUpdate: update });
    const activeAgents = new Map<number, ActiveAgentInfo>([
      [1, makeAgentInfo({ executionId: 1 })],
      [2, makeAgentInfo({ executionId: 2 })],
    ]);

    await saveAllAgentStates(prisma, activeAgents);

    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0][0]).toMatchObject({ where: { id: 1 } });
    expect(update.mock.calls[1][0]).toMatchObject({ where: { id: 2 } });
  });

  test('a failure on one agent does not stop the remaining agents from being saved', async () => {
    const update = mock((args: { where: { id: number } }) => {
      if (args.where.id === 1) return Promise.reject(new Error('db down'));
      return Promise.resolve({});
    });
    const prisma = makePrisma({
      agentExecutionUpdate: update as unknown as ReturnType<typeof mock>,
    });
    const activeAgents = new Map<number, ActiveAgentInfo>([
      [1, makeAgentInfo({ executionId: 1 })],
      [2, makeAgentInfo({ executionId: 2 })],
    ]);

    await expect(saveAllAgentStates(prisma, activeAgents)).resolves.toBeUndefined();
    expect(update).toHaveBeenCalledTimes(2);
  });
});

// ── gracefulShutdown ──────────────────────────────────────────────────────

describe('gracefulShutdown', () => {
  beforeEach(() => {
    mockStopAllPreviewSessions.mockClear();
  });

  test('stops all live-preview sessions (playwright-worker.mjs processes) before stopping agents', async () => {
    const ctx = makeCtx();

    await gracefulShutdown(ctx);

    expect(mockStopAllPreviewSessions).toHaveBeenCalledTimes(1);
  });

  test('a rejecting preview-session cleanup does not block the rest of shutdown', async () => {
    mockStopAllPreviewSessions.mockImplementationOnce(() =>
      Promise.reject(new Error('worker close failed')),
    );
    const serverStopCallback = mock(() => Promise.resolve());
    const ctx = makeCtx({ serverStopCallback });

    await expect(gracefulShutdown(ctx)).resolves.toBeUndefined();
    expect(serverStopCallback).toHaveBeenCalledTimes(1);
  });

  test('is a no-op re-entry guard when shutdown is already in progress', async () => {
    const setIsShuttingDown = mock((_v: boolean) => {});
    const ctx = makeCtx({ getIsShuttingDown: () => true, setIsShuttingDown });

    await gracefulShutdown(ctx);

    expect(setIsShuttingDown).not.toHaveBeenCalled();
  });

  test('stops every active agent, persists state, clears maps, and stops the server', async () => {
    const stop = mock(() => Promise.resolve());
    const agentUpdate = mock(async () => ({ count: 1 }));
    const prisma = makePrisma({ agentExecutionUpdate: agentUpdate });
    const info = makeAgentInfo({
      executionId: 1,
      agent: { stop } as unknown as ActiveAgentInfo['agent'],
    });
    const serverStopCallback = mock(() => Promise.resolve());
    const ctx = makeCtx({
      prisma,
      activeAgents: new Map([[1, info]]),
      activeExecutions: new Map([[1, info.state]]),
      serverStopCallback,
    });

    await gracefulShutdown(ctx);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(agentUpdate).toHaveBeenCalledTimes(1);
    expect(ctx.activeAgents.size).toBe(0);
    expect(ctx.activeExecutions.size).toBe(0);
    expect(serverStopCallback).toHaveBeenCalledTimes(1);
    expect(ctx.getIsShuttingDown()).toBe(true);
  });

  test('skips the server stop callback when skipServerStop is set', async () => {
    const serverStopCallback = mock(() => Promise.resolve());
    const ctx = makeCtx({ serverStopCallback });

    await gracefulShutdown(ctx, { skipServerStop: true });

    expect(serverStopCallback).not.toHaveBeenCalled();
  });

  test('tolerates a null server stop callback', async () => {
    const ctx = makeCtx({ serverStopCallback: null });

    await expect(gracefulShutdown(ctx)).resolves.toBeUndefined();
  });

  test('still saves agent state when agent.stop() rejects', async () => {
    const stop = mock(() => Promise.reject(new Error('stop failed')));
    const agentUpdate = mock(async () => ({ count: 1 }));
    const prisma = makePrisma({ agentExecutionUpdate: agentUpdate });
    const info = makeAgentInfo({
      executionId: 1,
      agent: { stop } as unknown as ActiveAgentInfo['agent'],
    });
    const ctx = makeCtx({ prisma, activeAgents: new Map([[1, info]]) });

    await expect(gracefulShutdown(ctx)).resolves.toBeUndefined();
    expect(agentUpdate).toHaveBeenCalledTimes(1);
  });

  test('a throwing server stop callback does not propagate', async () => {
    const serverStopCallback = mock(() => {
      throw new Error('listener close failed');
    });
    const ctx = makeCtx({ serverStopCallback });

    await expect(gracefulShutdown(ctx)).resolves.toBeUndefined();
  });

  test('falls back to saving all agent states when an unexpected error occurs mid-shutdown', async () => {
    const agentUpdate = mock(async () => ({ count: 1 }));
    const prisma = makePrisma({ agentExecutionUpdate: agentUpdate });
    const info = makeAgentInfo({ executionId: 1 });
    const questionTimeoutManager = {
      cancelAllTimeouts: mock(() => {
        throw new Error('boom');
      }),
      clearAllLocks: mock(() => {}),
    } as unknown as QuestionTimeoutManager;
    const ctx = makeCtx({ prisma, activeAgents: new Map([[1, info]]), questionTimeoutManager });

    await expect(gracefulShutdown(ctx)).resolves.toBeUndefined();
    // NOTE: falls through to the catch-all saveAllAgentStates fallback, so the
    // per-agent stop loop never ran but state is still persisted once.
    expect(agentUpdate).toHaveBeenCalledTimes(1);
    expect(ctx.activeAgents.size).toBe(0);
  });
});

// ── setupSignalHandlers ───────────────────────────────────────────────────

describe('setupSignalHandlers', () => {
  test('registers all four handlers without touching the real process listeners', () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>();
    const onSpy = spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: (...a: unknown[]) => unknown,
    ) => {
      registered.set(event, handler);
      return process;
    }) as typeof process.on);

    try {
      setupSignalHandlers(
        () => Promise.resolve(),
        () => Promise.resolve(),
      );
      expect(registered.has('SIGTERM')).toBe(true);
      expect(registered.has('SIGINT')).toBe(true);
      expect(registered.has('uncaughtException')).toBe(true);
      expect(registered.has('unhandledRejection')).toBe(true);
    } finally {
      onSpy.mockRestore();
    }
  });

  test('SIGTERM handler invokes the shutdown function', async () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>();
    const onSpy = spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: (...a: unknown[]) => unknown,
    ) => {
      registered.set(event, handler);
      return process;
    }) as typeof process.on);
    const shutdownFn = mock(() => Promise.resolve());

    try {
      setupSignalHandlers(shutdownFn, () => Promise.resolve());
      await registered.get('SIGTERM')?.();
      expect(shutdownFn).toHaveBeenCalledTimes(1);
    } finally {
      onSpy.mockRestore();
    }
  });

  test('unhandledRejection handler invokes the save-states function, not shutdown', async () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>();
    const onSpy = spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: (...a: unknown[]) => unknown,
    ) => {
      registered.set(event, handler);
      return process;
    }) as typeof process.on);
    const shutdownFn = mock(() => Promise.resolve());
    const saveStatesFn = mock(() => Promise.resolve());

    try {
      setupSignalHandlers(shutdownFn, saveStatesFn);
      await registered.get('unhandledRejection')?.(new Error('rejected'));
      expect(saveStatesFn).toHaveBeenCalledTimes(1);
      expect(shutdownFn).not.toHaveBeenCalled();
    } finally {
      onSpy.mockRestore();
    }
  });

  test('uncaughtException handler shuts down then exits with code 1', async () => {
    const registered = new Map<string, (...args: unknown[]) => unknown>();
    const onSpy = spyOn(process, 'on').mockImplementation(((
      event: string,
      handler: (...a: unknown[]) => unknown,
    ) => {
      registered.set(event, handler);
      return process;
    }) as typeof process.on);
    // NOTE: process.exit must never actually run inside a test process — stub
    // it to a sentinel throw so the handler's control flow is still observable.
    const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit:1');
    }) as typeof process.exit);
    const shutdownFn = mock(() => Promise.resolve());

    try {
      setupSignalHandlers(shutdownFn, () => Promise.resolve());
      await expect(registered.get('uncaughtException')?.(new Error('boom'))).rejects.toThrow(
        'exit:1',
      );
      expect(shutdownFn).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      onSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
