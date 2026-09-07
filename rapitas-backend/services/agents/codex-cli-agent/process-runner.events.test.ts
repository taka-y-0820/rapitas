/**
 * process-runner.events.test
 *
 * Covers stdout event coordination inside `spawnCodexProcess`: JSON event
 * dispatch to the (real, pure) json-event-handler, and non-JSON raw-line
 * filtering/truncation. Partial-line buffering across chunks lives in
 * process-runner.line-buffering.test.ts; stderr filtering and idle/timeout
 * polling live in process-runner.timing.test.ts (both kept separate to stay
 * under the 300-500 line file-size policy); argument/env construction lives
 * in process-runner.spawn.test.ts / process-runner.args.test.ts; close/error/
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
  pid = 777;
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

// ── stdout: JSON event dispatch (real json-event-handler) ──────────────────

describe('spawnCodexProcess — stdout JSON events', () => {
  test('thread.started sets the session id and notifies onSessionId', async () => {
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
      `${JSON.stringify({ type: 'thread.started', thread_id: 'thr-1' })}\n`,
    );
    expect(callbacks.onSessionId).toHaveBeenCalledWith('thr-1');
    expect(state.codexSessionId).toBe('thr-1');
    child.emit('close', 0);
    await resultPromise;
  });

  test('an AskUserQuestion tool_use kills the process and marks waiting_for_input', async () => {
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
    const event = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'AskUserQuestion',
            input: { question: '続けますか?' },
          },
        ],
      },
    };
    child.stdout.emit('data', `${JSON.stringify(event)}\n`);
    expect(callbacks.onStatusChange).toHaveBeenCalledWith('waiting_for_input');
    expect(callbacks.emitQuestionDetected).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emit('close', null);
    const result = await resultPromise;
    expect(result.waitingForInput).toBe(true);
    expect(result.question).toBe('続けますか?');
  });

  test('turn.failed produces a [Result: failed] line with the error message', async () => {
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
      `${JSON.stringify({ type: 'turn.failed', error: { message: 'model unavailable' } })}\n`,
    );
    expect(state.outputBuffer).toContain('[Result: failed]');
    expect(state.outputBuffer).toContain('model unavailable');
    child.emit('close', 1);
    await resultPromise;
  });

  test('an unknown event type does not throw and produces no display output', async () => {
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
    const callsBefore = callbacks.emitOutput.mock.calls.length;
    child.stdout.emit('data', `${JSON.stringify({ type: 'totally.unknown' })}\n`);
    expect(callbacks.emitOutput.mock.calls.length).toBe(callsBefore);
    child.emit('close', 0);
    await resultPromise;
  });

  test('item.completed agent_message text reaches the final AgentExecutionResult.output', async () => {
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
      `${JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: '最終回答のテキストです' },
      })}\n`,
    );
    child.emit('close', 0);
    const result = await resultPromise;
    expect(result.output).toContain('最終回答のテキストです');
  });
});

// ── stdout: non-JSON raw line handling ──────────────────────────────────────

describe('spawnCodexProcess — non-JSON raw stdout', () => {
  test('filters Windows chcp diagnostic lines out of the output buffer', async () => {
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
    child.stdout.emit('data', 'Active code page: 65001\n');
    expect(state.outputBuffer).toBe('');
    child.emit('close', 0);
    await resultPromise;
  });

  test('appends a short plain-text raw line verbatim (implementation mode)', async () => {
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
    child.stdout.emit('data', 'a short human-readable status line\n');
    expect(state.outputBuffer).toContain('a short human-readable status line');
    child.emit('close', 0);
    await resultPromise;
  });

  test('hides a raw diff/code-shaped line via shouldHideRawCliLine (implementation mode)', async () => {
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
    child.stdout.emit('data', 'const x = 1;\n');
    expect(state.outputBuffer).toBe('');
    child.emit('close', 0);
    await resultPromise;
  });

  test('hides a raw line longer than 240 chars entirely (shouldHideRawCliLine length gate)', async () => {
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
    child.stdout.emit('data', `${'y'.repeat(300)}\n`);
    expect(state.outputBuffer).toBe('');
    child.emit('close', 0);
    await resultPromise;
  });

  test('truncates a raw line whose trimmed content passes the filter but whose raw length exceeds 240', async () => {
    // NOTE: shouldHideRawCliLine gates on the *trimmed* length, so a line
    // padded with enough whitespace to exceed 240 raw chars while its
    // trimmed content stays under the cutoff reaches appendRawLine's own
    // (line.length > 240) truncation branch.
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
    const padded = `  ${'y'.repeat(238)}${' '.repeat(150)}`;
    expect(padded.trim().length).toBeLessThanOrEqual(240);
    expect(padded.length).toBeGreaterThan(240);
    child.stdout.emit('data', `${padded}\n`);
    expect(state.outputBuffer).toContain('...');
    expect(state.outputBuffer.length).toBeLessThan(padded.length);
    child.emit('close', 0);
    await resultPromise;
  });

  test('investigation mode keeps every raw byte verbatim, unfiltered and untruncated', async () => {
    const state = makeState();
    const callbacks = makeCallbacks();
    const resultPromise = spawnCodexProcess(
      { investigationMode: true },
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
    const codeLine = 'const x = 1; // this would be hidden in implementation mode';
    child.stdout.emit('data', `${codeLine}\n`);
    expect(state.outputBuffer).toContain(codeLine);
    child.emit('close', 0);
    await resultPromise;
  });
});
