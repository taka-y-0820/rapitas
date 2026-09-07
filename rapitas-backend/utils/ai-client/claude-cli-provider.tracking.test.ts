/**
 * claude-cli-provider.tracking.test
 *
 * Aux CLI child-process tracking (concern #1284): every spawned CLI child is
 * registered with the shared process tracker as role 'cli-agent' and
 * unregistered exactly once on every outcome — success, spawn error, and
 * timeout — for both the one-shot and streaming entry points. A leaked
 * registration would pin the boundary restart's aux-children gate forever.
 *
 * `child_process` and the tracker are mocked — no real process is spawned.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'child_process';

// Short wall-clock cap keeps the timeout test fast (baked in at import time).
process.env.RAPITAS_AUX_AI_CLI_TIMEOUT_MS = '150';

type MutableStream = EventEmitter & { setEncoding: (enc: string) => void };

function makeStream(): MutableStream {
  const em = new EventEmitter() as MutableStream;
  em.setEncoding = () => {};
  return em;
}

class MockChild extends EventEmitter {
  pid = 4242;
  stdout = makeStream();
  stderr = makeStream();
  stdin = Object.assign(new EventEmitter(), { end: mock((_buf?: Buffer) => {}) });
  kill = mock(() => {});
}

let spawnedChildren: MockChild[] = [];

const mockSpawn = mock((_command: string, _args: string[], _options: Record<string, unknown>) => {
  const child = new MockChild();
  spawnedChildren.push(child);
  return child as unknown as ChildProcess;
});

mock.module('child_process', () => ({
  spawn: mockSpawn,
  execFileSync: mock(() => Buffer.from('')),
  spawnSync: mock(() => ({ status: 0, stdout: '', stderr: '' })),
  fork: mock(() => {}),
}));

// CLI path resolution is delegated to utils/common/cli-path-resolver (see
// cli-path-resolver.test.ts for its own coverage); stub it to a fixed path so
// these tests exercise process tracking in isolation.
mock.module('../common/cli-path-resolver', () => ({
  getClaudePathAsync: mock(() => Promise.resolve('claude.cmd')),
}));

const registerMock = mock((_info: { pid: number; role: string }) => {});
const unregisterMock = mock((_pid: number) => {});

mock.module('../../services/agents/agent-process-tracker', () => ({
  registerProcess: registerMock,
  unregisterProcess: unregisterMock,
  countLiveTrackedProcesses: mock(() => 0),
}));

mock.module('../../config/logger', () => ({
  createLogger: () => ({
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  },
  getBackendLogFilePath: mock((_stamp?: string) => 'mock-log-path'),
}));

const { callClaudeCli, callClaudeCliStream } = await import('./claude-cli-provider');

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const messages = [{ role: 'user' as const, content: 'hello' }];

beforeEach(() => {
  spawnedChildren = [];
  mockSpawn.mockClear();
  registerMock.mockClear();
  unregisterMock.mockClear();
});

describe('aux CLI child tracking — one-shot (callClaudeCli)', () => {
  test('success: registered as cli-agent and unregistered exactly once', async () => {
    const promise = callClaudeCli(undefined, messages, undefined, 1024);
    await flush();
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(registerMock.mock.calls[0][0]).toMatchObject({ pid: 4242, role: 'cli-agent' });
    expect(unregisterMock).not.toHaveBeenCalled();

    const child = spawnedChildren[0];
    child.stdout.emit('data', '{"result":"ok","usage":{"input_tokens":1,"output_tokens":1}}');
    child.emit('close', 0);
    await expect(promise).resolves.toMatchObject({ content: 'ok' });
    expect(unregisterMock).toHaveBeenCalledTimes(1);
    expect(unregisterMock).toHaveBeenCalledWith(4242);
  });

  test('spawn error: unregistered exactly once (no leak, no double call)', async () => {
    const promise = callClaudeCli(undefined, messages, undefined, 1024);
    await flush();
    const child = spawnedChildren[0];
    child.emit('error', new Error('ENOENT'));
    await expect(promise).rejects.toThrow('spawn failed');
    // A close event after the error must not unregister a second time.
    child.emit('close', 1);
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(unregisterMock).toHaveBeenCalledTimes(1);
  });

  test('timeout: unregistered exactly once even though close never fires', async () => {
    const promise = callClaudeCli(undefined, messages, undefined, 1024);
    await flush();
    await expect(promise).rejects.toThrow('timed out');
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(unregisterMock).toHaveBeenCalledTimes(1);
    expect(unregisterMock).toHaveBeenCalledWith(4242);
  });
});

describe('aux CLI child tracking — streaming (callClaudeCliStream)', () => {
  test('close finishes the stream and unregisters exactly once', async () => {
    const stream = await callClaudeCliStream(undefined, messages, undefined, 1024);
    const reader = stream.getReader();
    await flush();
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(registerMock.mock.calls[0][0]).toMatchObject({ pid: 4242, role: 'cli-agent' });

    const child = spawnedChildren[0];
    child.stdout.emit('data', '{"type":"result","result":"done"}\n');
    child.emit('close', 0);
    // Drain to completion so finish() has run.
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
    }
    expect(unregisterMock).toHaveBeenCalledTimes(1);
    expect(unregisterMock).toHaveBeenCalledWith(4242);
  });

  test('stream error path unregisters exactly once', async () => {
    const stream = await callClaudeCliStream(undefined, messages, undefined, 1024);
    const reader = stream.getReader();
    await flush();
    const child = spawnedChildren[0];
    child.emit('close', 1);
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
    }
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(unregisterMock).toHaveBeenCalledTimes(1);
  });
});
