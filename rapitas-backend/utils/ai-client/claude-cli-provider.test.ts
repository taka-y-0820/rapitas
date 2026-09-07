/**
 * claude-cli-provider.test
 *
 * Happy-path coverage for the Claude Code CLI provider: prompt construction,
 * model alias mapping, the concurrency semaphore, and the memoized
 * availability probe. Failure/error-classification paths live in
 * claude-cli-provider.errors.test.ts; pure-parsing/platform-branch paths live
 * in claude-cli-provider.parsing.test.ts (kept separate to stay under the
 * 300-500 line file-size policy).
 *
 * `child_process` is mocked end-to-end — no real `claude` CLI process is ever
 * spawned. bun's `mock.module` is process-global, but bunfig.toml sets
 * `isolate = true`, so each test file gets a fresh module registry; the mock
 * factories below still mirror every export the real modules provide as
 * defense-in-depth in case isolation is ever disabled.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'child_process';
import type { AIMessage } from './types';

// ── child_process mock ──────────────────────────────────────────────────────

type MutableStream = EventEmitter & { setEncoding: (enc: string) => void };

function makeStream(): MutableStream {
  const em = new EventEmitter() as MutableStream;
  em.setEncoding = () => {};
  return em;
}

/** Minimal stand-in for Node's ChildProcess, driven manually by tests. */
class MockChild extends EventEmitter {
  stdout = makeStream();
  stderr = makeStream();
  stdin = Object.assign(new EventEmitter(), { end: mock((_buf?: Buffer) => {}) });
  kill = mock(() => {});
}

let spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
let spawnedChildren: MockChild[] = [];

const mockSpawn = mock((command: string, args: string[], options: Record<string, unknown>) => {
  spawnCalls.push({ command, args, options });
  const child = new MockChild();
  spawnedChildren.push(child);
  return child as unknown as ChildProcess;
});

mock.module('child_process', () => ({
  spawn: mockSpawn,
  // NOTE: agent-process-tracker (imported transitively for process registration)
  // statically imports execSync — must remain a valid named export even though
  // these tests never exercise that path.
  execSync: mock(() => ''),
  execFileSync: mock(() => Buffer.from('')),
  spawnSync: mock(() => ({ status: 0, stdout: '', stderr: '' })),
  fork: mock(() => {}),
}));

// CLI path resolution is delegated to utils/common/cli-path-resolver (see
// cli-path-resolver.test.ts for its own coverage). Default: falls back to the
// raw command name — keeps the default path deterministic without depending
// on the real filesystem.
mock.module('../common/cli-path-resolver', () => ({
  getClaudePathAsync: mock(() => Promise.resolve('claude.cmd')),
}));

mock.module('../../config/logger', () => ({
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  },
  createLogger: () => ({
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
  getBackendLogFilePath: mock((_stamp?: string) => 'mock-log-path'),
}));

const { callClaudeCli, callClaudeCliStream, isClaudeCliAvailable } =
  await import('./claude-cli-provider');

// ── test helpers ─────────────────────────────────────────────────────────────

/** Flushes pending microtasks + one macrotask tick (enough for acquireSlot()). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The spawned invocation as one string, regardless of platform: win32 packs
 * everything into `command` (shell string), unix keeps a real argv array.
 * Asserting on `.command` alone made these tests Windows-only (red on CI).
 */
function fullCommand(i: number): string {
  const call = spawnCalls[i];
  return [call.command, ...(call.args ?? [])].join(' ');
}

/** Emits a well-formed non-streaming success payload and closes the child. */
function respondSuccess(
  child: MockChild,
  overrides: Partial<{
    result: string;
    is_error: boolean;
    usage: { input_tokens: number; output_tokens: number };
  }> = {},
): void {
  const payload = {
    result: 'ok',
    is_error: false,
    usage: { input_tokens: 3, output_tokens: 4 },
    ...overrides,
  };
  child.stdout.emit('data', JSON.stringify(payload));
  child.emit('close', 0);
}

async function readAllSSE(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

beforeEach(() => {
  spawnCalls = [];
  spawnedChildren = [];
  mockSpawn.mockClear();
});

// ── callClaudeCli: happy path ────────────────────────────────────────────────

describe('callClaudeCli — success', () => {
  test('returns the parsed result and summed token usage', async () => {
    const promise = callClaudeCli(undefined, [{ role: 'user', content: 'hi' }], undefined, 100);
    await flush();
    respondSuccess(spawnedChildren[0], {
      result: 'hello there',
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    const response = await promise;
    expect(response.content).toBe('hello there');
    expect(response.tokensUsed).toBe(30);
  });

  test('defaults tokensUsed to 0 when usage is absent', async () => {
    const promise = callClaudeCli(undefined, [{ role: 'user', content: 'hi' }], undefined, 100);
    await flush();
    const payload = { result: 'ok', is_error: false };
    spawnedChildren[0].stdout.emit('data', JSON.stringify(payload));
    spawnedChildren[0].emit('close', 0);
    const response = await promise;
    expect(response.tokensUsed).toBe(0);
  });

  test('disables repo/file/shell tools on every call', async () => {
    const promise = callClaudeCli(undefined, [{ role: 'user', content: 'hi' }], undefined, 100);
    await flush();
    respondSuccess(spawnedChildren[0]);
    await promise;
    expect(fullCommand(0)).toContain(
      '--disallowedTools Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite,MultiEdit',
    );
  });

  test('strips ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the spawn env', async () => {
    process.env.ANTHROPIC_API_KEY = 'fake-key-for-test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'fake-token-for-test';
    try {
      const promise = callClaudeCli(undefined, [{ role: 'user', content: 'hi' }], undefined, 100);
      await flush();
      respondSuccess(spawnedChildren[0]);
      await promise;
      const env = spawnCalls[0].options.env as NodeJS.ProcessEnv;
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.FORCE_COLOR).toBe('0');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    }
  });
});

// ── callClaudeCli: model alias mapping ───────────────────────────────────────

describe('callClaudeCli — model alias mapping', () => {
  test.each([
    [undefined, 'haiku'],
    ['claude-3-opus-20240229', 'opus'],
    ['claude-3-5-sonnet-20241022', 'sonnet'],
    ['SOME-OPUS-VARIANT', 'opus'],
    ['totally-unknown-model', 'haiku'],
  ])('model=%p -> --model %s', async (model, expected) => {
    const promise = callClaudeCli(model, [{ role: 'user', content: 'hi' }], undefined, 100);
    await flush();
    respondSuccess(spawnedChildren[0]);
    await promise;
    expect(fullCommand(0)).toContain(`--model ${expected}`);
  });
});

// ── callClaudeCli: prompt construction (combinePrompt via stdin) ────────────

describe('callClaudeCli — prompt construction', () => {
  function stdinText(child: MockChild): string {
    const call = (child.stdin.end as ReturnType<typeof mock>).mock.calls[0][0] as Buffer;
    return call.toString('utf8');
  }

  test('explicit systemPrompt takes precedence over an in-array system message', async () => {
    const messages: AIMessage[] = [
      { role: 'system', content: 'ignored system' },
      { role: 'user', content: 'question' },
    ];
    const promise = callClaudeCli(undefined, messages, 'explicit system', 100);
    await flush();
    const text = stdinText(spawnedChildren[0]);
    respondSuccess(spawnedChildren[0]);
    await promise;
    expect(text).toBe('explicit system\n\nquestion');
  });

  test('falls back to an in-array system message when systemPrompt is omitted', async () => {
    const messages: AIMessage[] = [
      { role: 'system', content: 'from array' },
      { role: 'user', content: 'question' },
    ];
    const promise = callClaudeCli(undefined, messages, undefined, 100);
    await flush();
    const text = stdinText(spawnedChildren[0]);
    respondSuccess(spawnedChildren[0]);
    await promise;
    expect(text).toBe('from array\n\nquestion');
  });

  test('prefixes assistant turns and joins multi-turn conversations with blank lines', async () => {
    const messages: AIMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ];
    const promise = callClaudeCli(undefined, messages, undefined, 100);
    await flush();
    const text = stdinText(spawnedChildren[0]);
    respondSuccess(spawnedChildren[0]);
    await promise;
    expect(text).toBe('first\n\nAssistant: reply\n\nsecond');
  });

  test('omits the leading blank line when there is no system prompt at all', async () => {
    const messages: AIMessage[] = [{ role: 'user', content: 'only message' }];
    const promise = callClaudeCli(undefined, messages, undefined, 100);
    await flush();
    const text = stdinText(spawnedChildren[0]);
    respondSuccess(spawnedChildren[0]);
    await promise;
    expect(text).toBe('only message');
  });
});

// ── concurrency semaphore ─────────────────────────────────────────────────────

describe('callClaudeCli — concurrency semaphore (MAX_CONCURRENT default = 2)', () => {
  test('a 3rd concurrent call queues until a slot is released', async () => {
    const p1 = callClaudeCli(undefined, [{ role: 'user', content: 'a' }], undefined, 100);
    const p2 = callClaudeCli(undefined, [{ role: 'user', content: 'b' }], undefined, 100);
    const p3 = callClaudeCli(undefined, [{ role: 'user', content: 'c' }], undefined, 100);

    await flush();
    expect(spawnedChildren.length).toBe(2); // 3rd call has not spawned yet — queued

    respondSuccess(spawnedChildren[0], { result: 'r1' });
    expect((await p1).content).toBe('r1');
    await flush();

    expect(spawnedChildren.length).toBe(3); // releasing slot 1 let the queued call through

    respondSuccess(spawnedChildren[1], { result: 'r2' });
    respondSuccess(spawnedChildren[2], { result: 'r3' });
    const [r2, r3] = await Promise.all([p2, p3]);
    expect(r2.content).toBe('r2');
    expect(r3.content).toBe('r3');
  });
});

// ── callClaudeCliStream: happy path ──────────────────────────────────────────

describe('callClaudeCliStream — success', () => {
  test('emits assistant text blocks as SSE frames then [DONE]', async () => {
    const stream = await callClaudeCliStream(
      undefined,
      [{ role: 'user', content: 'hi' }],
      undefined,
      100,
    );
    const child = spawnedChildren[0];
    const readPromise = readAllSSE(stream);

    child.stdout.emit(
      'data',
      `${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello ' }] },
      })}\n`,
    );
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'world' }] },
      })}\n`,
    );
    child.emit('close', 0);

    const raw = await readPromise;
    expect(raw).toContain('data: {"content":"Hello "}');
    expect(raw).toContain('data: {"content":"world"}');
    expect(raw.trim().endsWith('data: [DONE]')).toBe(true);
  });

  test('falls back to the terminal `result` event when no assistant blocks were emitted', async () => {
    const stream = await callClaudeCliStream(
      undefined,
      [{ role: 'user', content: 'hi' }],
      undefined,
      100,
    );
    const child = spawnedChildren[0];
    const readPromise = readAllSSE(stream);

    child.stdout.emit('data', `${JSON.stringify({ type: 'result', result: 'fallback text' })}\n`);
    child.emit('close', 0);

    const raw = await readPromise;
    expect(raw).toContain('data: {"content":"fallback text"}');
    expect(raw.trim().endsWith('data: [DONE]')).toBe(true);
  });

  test('ignores the fallback result once an assistant block already streamed', async () => {
    const stream = await callClaudeCliStream(
      undefined,
      [{ role: 'user', content: 'hi' }],
      undefined,
      100,
    );
    const child = spawnedChildren[0];
    const readPromise = readAllSSE(stream);

    child.stdout.emit(
      'data',
      `${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'streamed' }] },
      })}\n${JSON.stringify({ type: 'result', result: 'should be ignored' })}\n`,
    );
    child.emit('close', 0);

    const raw = await readPromise;
    expect(raw).toContain('streamed');
    expect(raw).not.toContain('should be ignored');
  });
});

// ── isClaudeCliAvailable ──────────────────────────────────────────────────────

describe('isClaudeCliAvailable', () => {
  test('probes with --version and memoizes the result across calls', async () => {
    const p = isClaudeCliAvailable();
    // checkClaudeAvailable() awaits getClaudePathAsync() before spawning, so
    // the spawn call lands after a microtask tick — flush before asserting.
    await flush();
    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0].args).toEqual(['--version']);
    expect(spawnCalls[0].options).toMatchObject({ shell: true, windowsHide: true });

    spawnedChildren[0].emit('close', 0);
    expect(await p).toBe(true);

    const callsBefore = mockSpawn.mock.calls.length;
    expect(await isClaudeCliAvailable()).toBe(true);
    expect(mockSpawn.mock.calls.length).toBe(callsBefore); // cached — no second spawn
  });
});
