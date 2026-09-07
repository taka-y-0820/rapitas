/**
 * claude-cli-provider.parsing.test
 *
 * Coverage for the pure/internal plumbing of the Claude Code CLI provider
 * that isn't exported directly: the Windows spawn-command builder
 * (buildSpawnCommand — including how it embeds whatever path
 * getClaudePathAsync resolves to), the spawn env builder (buildCliEnv),
 * non-Windows platform branches, `extractLastJsonObject`, and the streaming
 * NDJSON line buffer (handleLine). These are exercised indirectly through the
 * public callClaudeCli/callClaudeCliStream entry points by inspecting what
 * gets passed to the mocked `spawn`. CLI path resolution itself
 * (where/`.cmd` fallback/caching) is covered in
 * utils/common/cli-path-resolver.test.ts — this file only stubs
 * getClaudePathAsync.
 *
 * Happy-path / concurrency coverage lives in claude-cli-provider.test.ts;
 * error-classification coverage lives in claude-cli-provider.errors.test.ts.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'child_process';

// ── child_process mock (see claude-cli-provider.test.ts for rationale) ─────

type MutableStream = EventEmitter & { setEncoding: (enc: string) => void };

function makeStream(): MutableStream {
  const em = new EventEmitter() as MutableStream;
  em.setEncoding = () => {};
  return em;
}

class MockChild extends EventEmitter {
  stdout = makeStream();
  stderr = makeStream();
  stdin = Object.assign(new EventEmitter(), { end: mock((_buf?: Buffer) => {}) });
  kill = mock(() => {});
}

let spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
let spawnedChildren: MockChild[] = [];
// Stubbed CLI path returned to the SUT on each call — override per-test to
// exercise buildSpawnCommand's quoting/platform branches.
let claudePathImpl: () => string = () => 'claude';

const mockSpawn = mock((command: string, args: string[], options: Record<string, unknown>) => {
  spawnCalls.push({ command, args, options });
  const child = new MockChild();
  spawnedChildren.push(child);
  return child as unknown as ChildProcess;
});
const mockGetClaudePathAsync = mock(() => Promise.resolve(claudePathImpl()));

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

mock.module('../common/cli-path-resolver', () => ({
  getClaudePathAsync: mockGetClaudePathAsync,
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

const { callClaudeCli, callClaudeCliStream } = await import('./claude-cli-provider');

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function respondSuccess(child: MockChild, result = 'ok'): void {
  child.stdout.emit(
    'data',
    JSON.stringify({ result, is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }),
  );
  child.emit('close', 0);
}

async function drainSSE(stream: ReadableStream): Promise<string> {
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

/** Temporarily overrides process.platform for the duration of `fn`. */
async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

/**
 * The spawned invocation as one string, regardless of platform: win32 packs
 * everything into `command` (shell string), unix keeps a real argv array.
 * Assertions against this stay green on both — asserting on `.command` alone
 * made these tests Windows-only and permanently red on Linux CI.
 */
function fullCommand(i: number): string {
  const call = spawnCalls[i];
  return [call.command, ...(call.args ?? [])].join(' ');
}

beforeEach(() => {
  spawnCalls = [];
  spawnedChildren = [];
  claudePathImpl = () => 'claude';
  mockSpawn.mockClear();
  mockGetClaudePathAsync.mockClear();
});

afterEach(() => {
  delete process.env.CLAUDE_CODE_PATH;
});

// ── buildSpawnCommand embeds whatever getClaudePathAsync resolves to ────────
// NOTE: `where`/`.cmd`-fallback/caching behavior lives in
// utils/common/cli-path-resolver.test.ts. These only verify that this module
// correctly plumbs the resolved path into the spawn command on Windows.

describe('buildSpawnCommand — Windows', () => {
  test('embeds the resolved CLI path in the spawn command', async () => {
    claudePathImpl = () => process.execPath;

    await withPlatform('win32', async () => {
      const p = callClaudeCli(undefined, [{ role: 'user', content: 'hi' }], undefined, 100);
      await flush();
      respondSuccess(spawnedChildren[0]);
      await p;
    });

    expect(spawnCalls[0].command).toContain(
      process.execPath.includes(' ') ? `"${process.execPath}"` : process.execPath,
    );
    expect(mockGetClaudePathAsync).toHaveBeenCalled();
  });

  test('quotes a resolved path containing spaces when building the spawn command', async () => {
    claudePathImpl = () => 'C:\\Program Files\\Claude\\claude.cmd';

    await withPlatform('win32', async () => {
      const p = callClaudeCli(undefined, [{ role: 'user', content: 'hi' }], undefined, 100);
      await flush();
      respondSuccess(spawnedChildren[0]);
      await p;
    });

    expect(spawnCalls[0].command).toContain('"C:\\Program Files\\Claude\\claude.cmd"');
  });
});

// ── buildCliEnv ───────────────────────────────────────────────────────────────

describe('buildCliEnv', () => {
  test('adds Windows UTF-8 env overrides on the win32 platform', async () => {
    await withPlatform('win32', async () => {
      const p = callClaudeCli(undefined, [{ role: 'user', content: 'hi' }], undefined, 100);
      await flush();
      respondSuccess(spawnedChildren[0]);
      await p;
    });
    const env = spawnCalls[0].options.env as NodeJS.ProcessEnv;
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.CHCP).toBe('65001');
    expect(env.NODE_OPTIONS).toBe('--no-warnings');
  });
});

// ── non-Windows platform branches ────────────────────────────────────────────

describe('non-Windows platform branches', () => {
  test('buildSpawnCommand keeps a real argv array (no chcp/quoting wrapper)', async () => {
    // buildCliEnv spreads ...process.env, so LANG/CHCP may already be present
    // on the host (e.g. Git Bash sets LANG). Clear them for this test so the
    // assertion checks buildCliEnv's own platform-conditional override, not
    // ambient host state.
    const savedLang = process.env.LANG;
    const savedChcp = process.env.CHCP;
    delete process.env.LANG;
    delete process.env.CHCP;
    try {
      await withPlatform('darwin', async () => {
        const p = callClaudeCli(undefined, [{ role: 'user', content: 'hi' }], undefined, 100);
        await flush();
        respondSuccess(spawnedChildren[0]);
        await p;
      });

      const call = spawnCalls[0];
      expect(call.command).toBe('claude'); // unsuffixed default binary name on non-Windows
      expect(call.args.length).toBeGreaterThan(0);
      expect(call.args).toContain('--model');
      const env = call.options.env as NodeJS.ProcessEnv;
      expect(env.LANG).toBeUndefined();
      expect(env.CHCP).toBeUndefined();
    } finally {
      if (savedLang !== undefined) process.env.LANG = savedLang;
      if (savedChcp !== undefined) process.env.CHCP = savedChcp;
    }
  });
});

// ── extractLastJsonObject (via callClaudeCli stdout parsing) ─────────────────

describe('extractLastJsonObject', () => {
  test('extracts the last balanced JSON object, ignoring earlier JSON-looking noise', async () => {
    const p = callClaudeCli(undefined, [{ role: 'user', content: 'hi' }], undefined, 100);
    await flush();
    const noise = 'Loading...\n{"unrelated":"blob","nested":{"x":1}}\nsome more CLI banner text\n';
    const finalPayload = {
      result: 'final answer',
      is_error: false,
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    spawnedChildren[0].stdout.emit('data', noise + JSON.stringify(finalPayload) + '\n\n');
    spawnedChildren[0].emit('close', 0);
    const response = await p;
    expect(response.content).toBe('final answer');
  });
});

// ── streaming: NDJSON line buffering (handleLine) ────────────────────────────

describe('callClaudeCliStream — line buffering', () => {
  test('reassembles a JSON line split across multiple stdout chunks', async () => {
    const stream = await callClaudeCliStream(
      undefined,
      [{ role: 'user', content: 'hi' }],
      undefined,
      100,
    );
    const child = spawnedChildren[0];
    const readPromise = drainSSE(stream);
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'split-line-ok' }] },
    });
    child.stdout.emit('data', line.slice(0, 10));
    child.stdout.emit('data', line.slice(10) + '\n');
    child.emit('close', 0);
    const raw = await readPromise;
    expect(raw).toContain('split-line-ok');
  });

  test('processes multiple NDJSON lines delivered in a single chunk', async () => {
    const stream = await callClaudeCliStream(
      undefined,
      [{ role: 'user', content: 'hi' }],
      undefined,
      100,
    );
    const child = spawnedChildren[0];
    const readPromise = drainSSE(stream);
    const line1 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'first' }] },
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'second' }] },
    });
    child.stdout.emit('data', `${line1}\n${line2}\n`);
    child.emit('close', 0);
    const raw = await readPromise;
    expect(raw).toContain('first');
    expect(raw).toContain('second');
  });

  test('ignores non-JSON noise lines without crashing the stream', async () => {
    const stream = await callClaudeCliStream(
      undefined,
      [{ role: 'user', content: 'hi' }],
      undefined,
      100,
    );
    const child = spawnedChildren[0];
    const readPromise = drainSSE(stream);
    child.stdout.emit('data', 'not json at all\n');
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'valid-after-noise' }] },
      })}\n`,
    );
    child.emit('close', 0);
    const raw = await readPromise;
    expect(raw).toContain('valid-after-noise');
    expect(raw).not.toContain('"error"');
  });

  test('flushes a trailing line lacking a terminating newline when the process closes', async () => {
    const stream = await callClaudeCliStream(
      undefined,
      [{ role: 'user', content: 'hi' }],
      undefined,
      100,
    );
    const child = spawnedChildren[0];
    const readPromise = drainSSE(stream);
    // No trailing '\n' — relies on the close handler's flush of a leftover lineBuffer.
    child.stdout.emit(
      'data',
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'no-trailing-newline' }] },
      }),
    );
    child.emit('close', 0);
    const raw = await readPromise;
    expect(raw).toContain('no-trailing-newline');
  });

  test('ignores non-text content blocks (e.g. tool_use) within an assistant message', async () => {
    const stream = await callClaudeCliStream(
      undefined,
      [{ role: 'user', content: 'hi' }],
      undefined,
      100,
    );
    const child = spawnedChildren[0];
    const readPromise = drainSSE(stream);
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', text: 'should-not-appear' },
            { type: 'text', text: 'only-this-text' },
          ],
        },
      })}\n`,
    );
    child.emit('close', 0);
    const raw = await readPromise;
    expect(raw).toContain('only-this-text');
    expect(raw).not.toContain('should-not-appear');
  });
});

// ── streaming: request shape ──────────────────────────────────────────────────

describe('callClaudeCliStream — request shape', () => {
  test('requests stream-json output, verbose mode, and the same tool restrictions', async () => {
    const stream = await callClaudeCliStream(
      'claude-3-5-sonnet-20241022',
      [{ role: 'user', content: 'hi' }],
      undefined,
      100,
    );
    const child = spawnedChildren[0];
    child.emit('close', 0);
    await drainSSE(stream);

    expect(fullCommand(0)).toContain('--verbose');
    expect(fullCommand(0)).toContain('--output-format stream-json');
    expect(fullCommand(0)).toContain('--model sonnet');
    expect(fullCommand(0)).toContain('--disallowedTools Bash,Edit,Write');
  });
});
