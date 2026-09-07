/**
 * process-runner.timing.test
 *
 * Covers stderr diagnostic filtering/model extraction and the idle /
 * initial-output / timeout polling loops inside `spawnCodexProcess`. Split
 * out of process-runner.events.test.ts (which covers stdout JSON-event
 * dispatch, line buffering, and raw-line filtering) to stay under the
 * 300-500 line file-size policy. Argument/env construction lives in
 * process-runner.spawn.test.ts / process-runner.args.test.ts; close/error
 * handling lives in process-runner.errors.test.ts.
 *
 * `child_process.spawn` is mocked end-to-end — no real Codex CLI process is
 * ever spawned. The idle/timeout intervals are exercised by monkey-patching
 * `setInterval`/`clearInterval` so tests don't wait on real wall-clock time.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'child_process';
import { createInitialWaitingState } from '../question-detection';
import type { ProcessRunnerState } from './process-runner';

// ── child_process mock ──────────────────────────────────────────────────────

type MutableStream = EventEmitter & { setEncoding: (enc: string) => void };

function makeStream(): MutableStream {
  const em = new EventEmitter() as MutableStream;
  em.setEncoding = mock(() => {});
  return em;
}

class MockChild extends EventEmitter {
  pid = 888;
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

function makeState(): ProcessRunnerState {
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

const noArtifacts = () => [];
const noCommits = () => [];

beforeEach(() => {
  spawnedChildren = [];
  mockSpawn.mockClear();
});

// ── stderr: diagnostic filtering + model extraction ─────────────────────────

describe('spawnCodexProcess — stderr handling', () => {
  test('extracts the reported model name from a "model: <name>" stderr line', async () => {
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
    child.stderr.emit('data', 'model: gpt-5.5-codex\n');
    expect(state.actualModel).toBe('gpt-5.5-codex');
    child.emit('close', 0);
    await resultPromise;
  });

  test('surfaces an important stderr line (error keyword) with isError=true', async () => {
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
    child.stderr.emit('data', 'thread panic: request failed\n');
    const importantCall = callbacks.emitOutput.mock.calls.find((c) => c[1] === true);
    expect(importantCall).toBeDefined();
    expect(String(importantCall?.[0])).toContain('panic');
    child.emit('close', 1);
    await resultPromise;
  });

  test('drops benign diagnostic noise from stderr entirely', async () => {
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
    child.stderr.emit('data', 'codex_core::session: failed to record rollout\n');
    expect(state.outputBuffer).toBe('');
    child.emit('close', 0);
    await resultPromise;
  });
});

// ── idle / initial-output / timeout polling ─────────────────────────────────

describe('spawnCodexProcess — idle and timeout monitoring', () => {
  type IntervalRecord = { fn: () => void; ms: number };
  let originalSetInterval: typeof setInterval;
  let originalClearInterval: typeof clearInterval;
  let intervalRecords: IntervalRecord[] = [];
  let clearedCount = 0;

  function installFakeIntervals(): void {
    intervalRecords = [];
    clearedCount = 0;
    let nextId = 1;
    originalSetInterval = global.setInterval;
    originalClearInterval = global.clearInterval;
    global.setInterval = ((fn: () => void, ms?: number) => {
      intervalRecords.push({ fn, ms: ms ?? 0 });
      return nextId++ as unknown as NodeJS.Timeout;
    }) as typeof setInterval;
    global.clearInterval = (() => {
      clearedCount += 1;
    }) as typeof clearInterval;
  }

  function restoreIntervals(): void {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }

  function invokeByDelay(ms: number): void {
    const record = intervalRecords.find((r) => r.ms === ms);
    if (!record) throw new Error(`No interval registered with delay ${ms}`);
    record.fn();
  }

  afterEach(() => {
    if (originalSetInterval) restoreIntervals();
  });

  test('warns once no output has arrived after the initial-output timeout', async () => {
    installFakeIntervals();
    const state = makeState();
    const callbacks = makeCallbacks();
    // Simulate the execution having "started" 61s ago so the 60s
    // initial-output threshold is already exceeded on the first idle check.
    const longAgoStart = Date.now() - 61_000;
    const resultPromise = spawnCodexProcess(
      {},
      'C:/work',
      'prompt',
      state,
      callbacks,
      longAgoStart,
      noArtifacts,
      noCommits,
    );
    await flush();
    invokeByDelay(5000); // IDLE_CHECK_INTERVAL_MS
    expect(callbacks.emitOutput).toHaveBeenCalledWith(expect.stringContaining('情報'));
    spawnedChildren[0].emit('close', 0);
    await resultPromise;
  });

  test('kills the process and resolves a failure once the output timeout elapses', async () => {
    installFakeIntervals();
    const state = makeState();
    const callbacks = makeCallbacks();
    const resultPromise = spawnCodexProcess(
      { timeout: 1 },
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
    // Let a sliver of real wall-clock time pass so `Date.now() - lastOutputTime`
    // exceeds the 1ms configured timeout when the interval callback runs.
    await new Promise((resolve) => setTimeout(resolve, 10));
    invokeByDelay(10000); // TIMEOUT_CHECK_INTERVAL_MS
    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('timed out');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(callbacks.onStatusChange).toHaveBeenCalledWith('failed');
    expect(clearedCount).toBeGreaterThan(0);
  });

  test('does not fire the timeout once output has refreshed lastOutputTime', async () => {
    installFakeIntervals();
    const state = makeState();
    const callbacks = makeCallbacks();
    const resultPromise = spawnCodexProcess(
      { timeout: 60_000 },
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
    child.stdout.emit('data', `${JSON.stringify({ type: 'turn.started' })}\n`);
    invokeByDelay(10000); // TIMEOUT_CHECK_INTERVAL_MS — should be a no-op right after fresh output
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('close', 0);
    await resultPromise;
  });
});
