/**
 * process-runner.errors.test
 *
 * Covers error classification and process-close/status handling inside
 * `spawnCodexProcess`: synchronous spawn failures, the child's own 'error'
 * event, non-zero exit diagnostics, the hasQuestion/cancelled/failed
 * short-circuits in the close handler, and `buildCloseResult`'s error
 * message assembly. Argument/env construction lives in
 * process-runner.spawn.test.ts; stdout/stderr event coordination and
 * idle/timeout polling live in process-runner.events.test.ts.
 *
 * `child_process.spawn` is mocked end-to-end — no real Codex CLI process is
 * ever spawned.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'child_process';
import { createInitialWaitingState } from '../question-detection';
import type { ProcessRunnerState } from './process-runner';
import type { AgentArtifact, GitCommitInfo } from '../base-agent';

// ── child_process mock ──────────────────────────────────────────────────────

type MutableStream = EventEmitter & { setEncoding: (enc: string) => void };

function makeStream(): MutableStream {
  const em = new EventEmitter() as MutableStream;
  em.setEncoding = mock(() => {});
  return em;
}

class MockChild extends EventEmitter {
  pid = 999;
  killed = false;
  stdout = makeStream();
  stderr = makeStream();
  stdin = Object.assign(new EventEmitter(), {
    write: mock((_data: string) => {}),
    end: mock(() => {}),
    setDefaultEncoding: mock((_enc: string) => {}),
  });
  kill = mock((_signal?: string) => {
    this.killed = true;
  });
}

let spawnedChildren: MockChild[] = [];

const mockSpawn = mock((_command: string, _args: string[], _options: Record<string, unknown>) => {
  const child = new MockChild();
  spawnedChildren.push(child);
  return child as unknown as ChildProcess;
});

mock.module('child_process', () => ({
  spawn: mockSpawn,
  exec: mock(() => {}),
  execFile: mock(() => {}),
  execSync: mock(() => Buffer.from('')),
  execFileSync: mock(() => Buffer.from('')),
  spawnSync: mock(() => ({ status: 0, stdout: '', stderr: '' })),
  fork: mock(() => {}),
}));

mock.module('./types', () => ({
  resolveCliPath: mock((cliName: string) => cliName),
}));

const { spawnCodexProcess } = await import('./process-runner');

// ── test helpers ─────────────────────────────────────────────────────────────

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function makeState(overrides: Partial<ProcessRunnerState> = {}): ProcessRunnerState {
  return {
    process: null,
    outputBuffer: '',
    errorBuffer: '',
    lineBuffer: '',
    detectedQuestion: createInitialWaitingState(),
    activeTools: new Map(),
    codexSessionId: null,
    actualModel: null,
    status: 'running',
    turnFailed: false,
    turnFailureMessage: null,
    activeCodexCommands: new Map(),
    seenAgentMessageIds: new Set(),
    ...overrides,
  };
}

function makeCallbacks() {
  return {
    emitOutput: mock((_text: string, _isError?: boolean) => {}),
    emitQuestionDetected: mock(() => {}),
    onSessionId: mock((_id: string) => {}),
    onQuestionDetected: mock(() => {}),
    onStatusChange: mock((_status: string) => {}),
    logPrefix: '[test-agent]',
  };
}

const noArtifacts = (): AgentArtifact[] => [];
const noCommits = (): GitCommitInfo[] => [];

beforeEach(() => {
  spawnedChildren = [];
  mockSpawn.mockClear();
});

// ── spawn() throws synchronously ─────────────────────────────────────────────

describe('spawnCodexProcess — synchronous spawn failure', () => {
  test('resolves a failure result without ever touching state.process', async () => {
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('spawn ENOENT');
    });
    const state = makeState();
    const callbacks = makeCallbacks();
    const result = await spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      callbacks,
      Date.now(),
      noArtifacts,
      noCommits,
    );
    expect(result.success).toBe(false);
    expect(result.output).toBe('');
    expect(result.errorMessage).toBe('spawn ENOENT');
    expect(state.process).toBeNull();
    expect(state.status).toBe('failed');
    expect(callbacks.onStatusChange).toHaveBeenCalledWith('failed');
  });

  test('stringifies a non-Error throw', async () => {
    mockSpawn.mockImplementationOnce(() => {
      // NOTE: the SUT's catch block does `error instanceof Error ? ... : String(error)` —
      // a non-Error throw is a real branch worth pinning even though it's atypical.
      throw 'raw string failure';
    });
    const result = await spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      makeState(),
      makeCallbacks(),
      Date.now(),
      noArtifacts,
      noCommits,
    );
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('raw string failure');
  });
});

// ── child process 'error' event ─────────────────────────────────────────────

describe("spawnCodexProcess — child 'error' event", () => {
  test('resolves a failure result with the error message and any accumulated stderr', async () => {
    const state = makeState();
    const callbacks = makeCallbacks();
    const resultPromise = spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      callbacks,
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    const child = spawnedChildren[0];
    child.stderr.emit('data', 'permission denied\n');
    child.emit('error', new Error('spawn EACCES'));
    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('プロセス起動エラー: spawn EACCES');
    expect(result.errorMessage).toContain('permission denied');
    expect(state.status).toBe('failed');
    expect(callbacks.onStatusChange).toHaveBeenCalledWith('failed');
    expect(callbacks.emitOutput).toHaveBeenCalledWith(
      expect.stringContaining('spawn EACCES'),
      true,
    );
  });

  test('omits the stderr section when nothing was captured', async () => {
    const state = makeState();
    const resultPromise = spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      makeCallbacks(),
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    spawnedChildren[0].emit('error', new Error('spawn EACCES'));
    const result = await resultPromise;
    expect(result.errorMessage).toBe('プロセス起動エラー: spawn EACCES');
  });
});

// ── close: exit-code / question / status branches ───────────────────────────

describe('spawnCodexProcess — close handling', () => {
  test('exit code 0 with no pending question resolves success and status=completed', async () => {
    const state = makeState();
    const callbacks = makeCallbacks();
    const resultPromise = spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      callbacks,
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    spawnedChildren[0].emit('close', 0);
    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(result.waitingForInput).toBe(false);
    expect(state.status).toBe('completed');
    expect(callbacks.onStatusChange).toHaveBeenCalledWith('completed');
  });

  test('non-zero exit code assembles a Japanese error message with stderr and output tails', async () => {
    const state = makeState();
    const callbacks = makeCallbacks();
    const resultPromise = spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      callbacks,
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    const child = spawnedChildren[0];
    child.stderr.emit('data', 'a fatal error occurred\n');
    child.stdout.emit('data', `${JSON.stringify({ type: 'turn.started' })}\n`);
    child.emit('close', 1);
    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(state.status).toBe('failed');
    expect(result.errorMessage).toContain('プロセスがコード 1 で終了しました');
    expect(result.errorMessage).toContain('【標準エラー出力】');
    expect(result.errorMessage).toContain('a fatal error occurred');
    expect(callbacks.emitOutput).toHaveBeenCalledWith(
      expect.stringContaining('Codex 終了コード 1'),
      true,
    );
  });

  test('a pending question at close resolves waitingForInput=true regardless of exit code', async () => {
    const state = makeState();
    const callbacks = makeCallbacks();
    const resultPromise = spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      callbacks,
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    const child = spawnedChildren[0];
    const askEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: { question: 'どちら?' } },
        ],
      },
    };
    child.stdout.emit('data', `${JSON.stringify(askEvent)}\n`);
    child.emit('close', null);
    const result = await resultPromise;
    expect(result.waitingForInput).toBe(true);
    expect(result.question).toBe('どちら?');
    expect(state.status).toBe('waiting_for_input');
    expect(callbacks.onStatusChange).toHaveBeenCalledWith('waiting_for_input');
    expect(callbacks.emitOutput).toHaveBeenCalledWith(
      expect.stringContaining('回答を待っています'),
    );
  });

  test('status=cancelled at close short-circuits to a cancelled failure result', async () => {
    const state = makeState();
    const callbacks = makeCallbacks();
    const resultPromise = spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      callbacks,
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    // Simulate an external stop() call flipping status before the process
    // actually exits (mirrors CodexCliAgent.stop()).
    state.status = 'cancelled';
    spawnedChildren[0].emit('close', 0);
    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe('Execution cancelled');
    // #808: downstream determineExecutionStatus()/checkNeedsFallback() key off
    // this tag to route cancellations away from the failed/ERROR path.
    expect(result.failureType).toBe('cancelled');
    // The cancelled short-circuit must not overwrite status back to completed.
    expect(callbacks.onStatusChange).not.toHaveBeenCalled();
  });

  test('status=failed at close (already resolved by the timeout path) does not build a second result', async () => {
    const state = makeState();
    const callbacks = makeCallbacks();
    const resultPromise = spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      callbacks,
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    // Simulate the timeout-check interval having already resolved the
    // promise and flipped status to 'failed' before the SIGTERM'd process
    // actually reports its exit.
    state.status = 'failed';
    spawnedChildren[0].emit('close', 143);
    // The close handler's early-return means onStatusChange is never called
    // a second time by this path (it was already called once by whatever
    // set status='failed' — nothing in this test set it, so it stays unset).
    expect(callbacks.onStatusChange).not.toHaveBeenCalled();
    // Resolve the dangling promise manually is not possible (resolve is
    // internal); the test only needs to prove the close handler didn't throw
    // or double-invoke callbacks. Emit a second close defensively to ensure
    // no crash from repeated events.
    spawnedChildren[0].emit('close', 143);
    void resultPromise; // never settles in this scenario — intentionally unawaited
  });

  test('passes parseArtifacts/parseCommits output through to the result on success', async () => {
    const artifact: AgentArtifact = { type: 'file', name: 'a.txt', path: 'a.txt', content: 'hi' };
    const commit: GitCommitInfo = {
      hash: 'abc123',
      message: 'msg',
      branch: 'main',
      filesChanged: 1,
      additions: 2,
      deletions: 0,
    };
    const state = makeState();
    const resultPromise = spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      makeCallbacks(),
      Date.now(),
      () => [artifact],
      () => [commit],
    );
    await flush();
    spawnedChildren[0].emit('close', 0);
    const result = await resultPromise;
    expect(result.artifacts).toEqual([artifact]);
    expect(result.commits).toEqual([commit]);
  });

  test('reports the actual model surfaced via stderr over the configured model', async () => {
    const state = makeState();
    const resultPromise = spawnCodexProcess(
      { model: 'gpt-5' },
      'C:/work',
      'prompt',
      state,
      makeCallbacks(),
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    const child = spawnedChildren[0];
    child.stderr.emit('data', 'model: gpt-5.5-codex-actual\n');
    child.emit('close', 0);
    const result = await resultPromise;
    expect(result.modelName).toBe('gpt-5.5-codex-actual');
  });

  test('falls back to the configured model name when stderr never reports one', async () => {
    const state = makeState();
    const resultPromise = spawnCodexProcess(
      { model: 'gpt-5' },
      'C:/work',
      'prompt',
      state,
      makeCallbacks(),
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    spawnedChildren[0].emit('close', 0);
    const result = await resultPromise;
    expect(result.modelName).toBe('gpt-5');
  });

  test('turn.failed followed by exit code 0 resolves success:false with a Codex-turn-failed message', async () => {
    const state = makeState();
    const callbacks = makeCallbacks();
    const resultPromise = spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      callbacks,
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    const child = spawnedChildren[0];
    child.stdout.emit(
      'data',
      `${JSON.stringify({ type: 'turn.failed', error: { message: 'context window exceeded' } })}\n`,
    );
    child.emit('close', 0);
    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Codexターンが失敗しました');
    expect(result.errorMessage).toContain('context window exceeded');
    expect(state.status).toBe('failed');
    expect(callbacks.onStatusChange).toHaveBeenCalledWith('failed');
  });

  test('turn.failed followed by non-zero exit code does not duplicate the failure message', async () => {
    const state = makeState();
    const resultPromise = spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      makeCallbacks(),
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    const child = spawnedChildren[0];
    child.stdout.emit(
      'data',
      `${JSON.stringify({ type: 'turn.failed', error: { message: 'context window exceeded' } })}\n`,
    );
    child.emit('close', 1);
    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('プロセスがコード 1 で終了しました');
    expect(result.errorMessage).not.toContain('Codexターンが失敗しました');
  });

  test('turn.failed does not override a pending question at close', async () => {
    const state = makeState();
    const callbacks = makeCallbacks();
    const resultPromise = spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      callbacks,
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    const child = spawnedChildren[0];
    child.stdout.emit(
      'data',
      `${JSON.stringify({ type: 'turn.failed', error: { message: 'context window exceeded' } })}\n`,
    );
    const askEvent = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'AskUserQuestion', input: { question: 'どちら?' } },
        ],
      },
    };
    child.stdout.emit('data', `${JSON.stringify(askEvent)}\n`);
    child.emit('close', 0);
    const result = await resultPromise;
    expect(result.waitingForInput).toBe(true);
    expect(result.success).toBe(true);
    expect(state.status).toBe('waiting_for_input');
  });

  test('stderr chunks mixed with item.* events accumulate only in errorBuffer, not outputBuffer/turnFailed', async () => {
    const state = makeState();
    const callbacks = makeCallbacks();
    const resultPromise = spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      callbacks,
      Date.now(),
      noArtifacts,
      noCommits,
    );
    await flush();
    const child = spawnedChildren[0];
    child.stdout.emit(
      'data',
      `${JSON.stringify({ type: 'item.started', item: { type: 'command_execution', id: 'c1', command: 'ls' } })}\n`,
    );
    child.stderr.emit('data', 'a stray diagnostic line on stderr\n');
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        type: 'item.completed',
        item: { type: 'command_execution', id: 'c1', command: 'ls', exit_code: 0 },
      })}\n`,
    );
    child.emit('close', 0);
    const result = await resultPromise;
    expect(state.errorBuffer).toContain('a stray diagnostic line on stderr');
    expect(result.success).toBe(true);
    expect(state.turnFailed).toBe(false);
  });
});

test('stop requested during setup prevents spawning', async () => {
  const result = await spawnCodexProcess(
    {},
    'C:/work',
    'prompt',
    makeState({ cancelRequested: true }),
    makeCallbacks(),
    Date.now(),
    noArtifacts,
    noCommits,
  );
  expect(result.failureType).toBe('cancelled');
  expect(mockSpawn).not.toHaveBeenCalled();
});
test('cancellation intent wins over a late status event and exit zero', async () => {
  const state = makeState();
  const pending = spawnCodexProcess(
    {},
    'C:/work',
    'prompt',
    state,
    makeCallbacks(),
    Date.now(),
    noArtifacts,
    noCommits,
  );
  await flush();
  state.cancelRequested = true;
  state.status = 'running';
  spawnedChildren[0].emit('close', 0);
  expect((await pending).failureType).toBe('cancelled');
});

test('stop from a startup output callback prevents the subsequent spawn', async () => {
  const state = makeState();
  const callbacks = makeCallbacks();
  callbacks.emitOutput.mockImplementation(() => {
    state.cancelRequested = true;
  });
  const result = await spawnCodexProcess(
    {},
    'C:/work',
    'prompt',
    state,
    callbacks,
    Date.now(),
    noArtifacts,
    noCommits,
  );
  expect(result.failureType).toBe('cancelled');
  expect(mockSpawn).not.toHaveBeenCalled();
});
