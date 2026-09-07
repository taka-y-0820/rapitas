/**
 * process-runner.line-buffering.test
 *
 * Covers partial-line buffering across stdout chunks inside
 * `spawnCodexProcess`: JSON events (and their command_execution
 * aggregated_output payload) split mid-line across `data` events, and lines
 * left unterminated when the process closes. Split out of
 * process-runner.events.test.ts (which now covers only JSON event dispatch
 * and non-JSON raw-line handling) to stay under the 300-500 line file-size
 * policy. stderr filtering and idle/timeout polling live in
 * process-runner.timing.test.ts; argument/env construction lives in
 * process-runner.spawn.test.ts / process-runner.args.test.ts; close/error/
 * status handling lives in process-runner.errors.test.ts.
 *
 * `child_process.spawn` is mocked end-to-end — no real Codex CLI process is
 * ever spawned.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
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
  pid = 778;
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
    seenAgentMessageIds: new Set(),
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

// ── stdout: partial-line buffering ──────────────────────────────────────────

describe('spawnCodexProcess — stdout line buffering', () => {
  test('holds an incomplete JSON line across chunks until the newline arrives', async () => {
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
    const full = JSON.stringify({ type: 'thread.started', thread_id: 'split-thread' });
    const mid = Math.floor(full.length / 2);
    child.stdout.emit('data', full.slice(0, mid));
    expect(callbacks.onSessionId).not.toHaveBeenCalled();
    child.stdout.emit('data', `${full.slice(mid)}\n`);
    expect(callbacks.onSessionId).toHaveBeenCalledWith('split-thread');
    child.emit('close', 0);
    await resultPromise;
  });

  test('flushes a trailing unterminated line when the process closes', async () => {
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
    // No trailing newline — this stays in lineBuffer until close() flushes it.
    child.stdout.emit('data', JSON.stringify({ type: 'thread.started', thread_id: 'flushed' }));
    expect(callbacks.onSessionId).not.toHaveBeenCalled();
    child.emit('close', 0);
    expect(callbacks.onSessionId).toHaveBeenCalledWith('flushed');
    await resultPromise;
  });

  test('item.completed(agent_message) split across multiple stdout chunks is processed as one event', async () => {
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
    const full = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '分割された最終回答' },
    });
    const mid = Math.floor(full.length / 2);
    child.stdout.emit('data', full.slice(0, mid));
    expect(state.outputBuffer).not.toContain('分割された最終回答');
    child.stdout.emit('data', `${full.slice(mid)}\n`);
    expect(state.outputBuffer).toContain('分割された最終回答');
    child.emit('close', 0);
    const result = await resultPromise;
    expect(result.output).toContain('分割された最終回答');
  });

  test('item.completed(agent_message) with no trailing newline is flushed on close', async () => {
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
    // No trailing newline — this stays in lineBuffer until close() flushes it.
    child.stdout.emit(
      'data',
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '改行なしの最終回答' },
      }),
    );
    expect(state.outputBuffer).not.toContain('改行なしの最終回答');
    child.emit('close', 0);
    const result = await resultPromise;
    expect(result.output).toContain('改行なしの最終回答');
  });

  test('item.completed(command_execution) split across multiple stdout chunks is processed as one event', async () => {
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
    const full = JSON.stringify({
      type: 'item.completed',
      item: {
        id: 'cmd-split',
        type: 'command_execution',
        command: 'echo chunked',
        exit_code: 0,
        aggregated_output: 'chunked output\n',
      },
    });
    const mid = Math.floor(full.length / 2);
    child.stdout.emit('data', full.slice(0, mid));
    expect(state.outputBuffer).not.toContain('[Command Done] echo chunked');
    child.stdout.emit('data', `${full.slice(mid)}\n`);
    expect(state.outputBuffer).toContain('[Command Done] echo chunked');
    child.emit('close', 0);
    const result = await resultPromise;
    expect(result.output).toContain('[Command Done] echo chunked');
  });

  test('item.completed(command_execution) with no trailing newline is flushed on close', async () => {
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
    // No trailing newline — this stays in lineBuffer until close() flushes it.
    child.stdout.emit(
      'data',
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'cmd-no-newline',
          type: 'command_execution',
          command: 'echo no-newline',
          exit_code: 1,
          aggregated_output: 'partial output before crash',
        },
      }),
    );
    expect(state.outputBuffer).not.toContain('[Command Failed] echo no-newline');
    child.emit('close', 0);
    const result = await resultPromise;
    expect(result.output).toContain('[Command Failed] echo no-newline');
    expect(result.output).toContain('partial output before crash');
  });
});
