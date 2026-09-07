/**
 * claude-code-provider.test
 *
 * Coverage for ClaudeCodeProvider: capabilities, isAvailable()'s CLI probe
 * (close/error/timeout paths), validateConfig(), healthCheck(), and
 * createAgent()'s config-merge precedence. `child_process` and
 * `fs`/`fs/promises` are mocked end-to-end so no real CLI process or
 * filesystem access ever occurs; `ClaudeCodeAgentAdapter` is mocked so
 * createAgent() can be verified in isolation from adapter internals (covered
 * separately in claude-code-agent-adapter*.test.ts). CLI path resolution
 * (win32-only `where` resolution/caching) is delegated to
 * utils/common/cli-path-resolver — covered in its own cli-path-resolver.test.ts —
 * and stubbed here via a static import so bun:test's mock.module() can
 * intercept it (see the NOTE on the claude-code-provider.ts import).
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { AgentProviderConfig, ClaudeCodeProviderConfig } from '../types';

// ── child_process mock ──────────────────────────────────────────────────────

class MockChild extends EventEmitter {
  kill = mock(() => {});
}

let spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
let spawnedChildren: MockChild[] = [];
let spawnShouldThrow = false;

const mockSpawn = mock((command: string, args: string[], options: Record<string, unknown>) => {
  if (spawnShouldThrow) throw new Error('spawn boom');
  spawnCalls.push({ command, args, options });
  const child = new MockChild();
  spawnedChildren.push(child);
  return child;
});

mock.module('child_process', () => ({
  spawn: mockSpawn,
  execFileSync: mock(() => Buffer.from('')),
  spawnSync: mock(() => ({ status: 0, stdout: '', stderr: '' })),
  fork: mock(() => {}),
}));

// Stubbed CLI path returned to the SUT on each call — override per-test to
// exercise the Windows/non-Windows branches without shelling out to `where`.
let resolvedClaudePath = 'claude';
const mockResolveCliPathAsync = mock((_cliName: string) => Promise.resolve(resolvedClaudePath));

mock.module('../../../../utils/common/cli-path-resolver', () => ({
  resolveCliPathAsync: mockResolveCliPathAsync,
}));

let existsSyncImpl: (p: string) => boolean = () => true;
const mockExistsSync = mock((p: string) => existsSyncImpl(p));

// NOTE: mock.module() is process-global — mirroring only existsSync (the one
// export this file cares about) previously left every other real `fs` export
// (mkdirSync, readFileSync, etc.) undefined for any sibling test file that
// imports `fs` in the same bun process, crashing with "Export named
// 'mkdirSync' not found in module 'node:fs'".
const realFs = await import('fs');
mock.module('fs', () => ({
  ...realFs,
  existsSync: mockExistsSync,
}));

let accessImpl: (p: string) => Promise<void> = () => Promise.resolve();
const mockAccess = mock((p: string) => accessImpl(p));

const realFsPromises = await import('fs/promises');
mock.module('fs/promises', () => ({
  ...realFsPromises,
  access: mockAccess,
}));

// ── ClaudeCodeAgentAdapter mock (createAgent() is tested in isolation) ──────

class MockAdapter {
  constructor(public config: ClaudeCodeProviderConfig) {}
}

mock.module('./claude-code-agent-adapter', () => ({
  ClaudeCodeAgentAdapter: MockAdapter,
}));

const { ClaudeCodeProvider } = await import('./claude-code-provider');

// ── fixtures / helpers ───────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ClaudeCodeProviderConfig> = {}): ClaudeCodeProviderConfig {
  return { providerId: 'claude-code', enabled: true, ...overrides };
}

/** Flushes pending microtasks — enough for the dynamic `import('child_process')` + spawn call. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

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

/** Awaits the next spawned child and settles its 'close' event with `code`. */
async function resolveNextSpawnClose(code: number): Promise<void> {
  await flush();
  spawnedChildren[spawnedChildren.length - 1]!.emit('close', code);
}

beforeEach(() => {
  spawnCalls = [];
  spawnedChildren = [];
  spawnShouldThrow = false;
  resolvedClaudePath = 'claude';
  existsSyncImpl = () => true;
  accessImpl = () => Promise.resolve();
  mockSpawn.mockClear();
  mockResolveCliPathAsync.mockClear();
  mockExistsSync.mockClear();
  mockAccess.mockClear();
});

afterEach(() => {
  delete process.env.CLAUDE_CODE_PATH;
});

// ── getCapabilities() ────────────────────────────────────────────────────────

describe('ClaudeCodeProvider.getCapabilities', () => {
  test('reports parallelExecution=false and the rest of the CLI capabilities true', () => {
    const provider = new ClaudeCodeProvider();
    const caps = provider.getCapabilities();

    expect(caps.parallelExecution).toBe(false);
    expect(caps.codeGeneration).toBe(true);
    expect(caps.sessionContinuation).toBe(true);
  });

  test('returns a defensive copy on each call', () => {
    const provider = new ClaudeCodeProvider();
    expect(provider.getCapabilities()).not.toBe(provider.getCapabilities());
    expect(provider.getCapabilities()).toEqual(provider.getCapabilities());
  });
});

// ── isAvailable() ────────────────────────────────────────────────────────────

describe('ClaudeCodeProvider.isAvailable', () => {
  test('resolves true when the CLI process exits with code 0', async () => {
    const provider = new ClaudeCodeProvider();
    const promise = provider.isAvailable();
    await resolveNextSpawnClose(0);
    expect(await promise).toBe(true);
  });

  test('resolves false when the CLI process exits with a non-zero code', async () => {
    const provider = new ClaudeCodeProvider();
    const promise = provider.isAvailable();
    await resolveNextSpawnClose(1);
    expect(await promise).toBe(false);
  });

  test('resolves false when spawn emits an error event', async () => {
    const provider = new ClaudeCodeProvider();
    const promise = provider.isAvailable();
    await flush();
    spawnedChildren[0]!.emit('error', new Error('spawn failed'));
    expect(await promise).toBe(false);
  });

  test('resolves false and kills the process after the 10s timeout', async () => {
    const provider = new ClaudeCodeProvider();
    const originalSetTimeout = globalThis.setTimeout;
    let capturedDelay: number | undefined;
    // Overriding the global timer (rather than waiting 10 real seconds) fires
    // the timeout callback synchronously so the branch can be asserted
    // deterministically; restored in `finally` regardless of outcome.
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      capturedDelay = delay;
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      const available = await provider.isAvailable();
      expect(available).toBe(false);
      expect(capturedDelay).toBe(10000);
      expect(spawnedChildren[0]!.kill.mock.calls.length).toBe(1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('rejects when spawn() throws synchronously (the Promise executor swallows it before the outer catch runs)', async () => {
    spawnShouldThrow = true;
    const provider = new ClaudeCodeProvider();
    await expect(provider.isAvailable()).rejects.toThrow('spawn boom');
  });

  describe('on Windows', () => {
    test('uses CLAUDE_CODE_PATH and embeds the path resolveCliPathAsync resolves to', async () => {
      await withPlatform('win32', async () => {
        process.env.CLAUDE_CODE_PATH = 'custom-claude';
        resolvedClaudePath = 'C:\\tools\\custom-claude.cmd';
        const provider = new ClaudeCodeProvider();
        const promise = provider.isAvailable();
        await resolveNextSpawnClose(0);
        await promise;
        expect(mockResolveCliPathAsync).toHaveBeenCalledWith('custom-claude');
        expect(spawnCalls[0]!.command).toBe('C:\\tools\\custom-claude.cmd');
      });
    });

    test('falls back to the raw CLI name when resolveCliPathAsync cannot resolve it', async () => {
      await withPlatform('win32', async () => {
        resolvedClaudePath = 'claude.cmd'; // resolveCliPathAsync's own fallback contract
        const provider = new ClaudeCodeProvider();
        const promise = provider.isAvailable();
        await resolveNextSpawnClose(0);
        await promise;
        expect(spawnCalls[0]!.command).toBe('claude.cmd');
      });
    });
  });

  test('embeds the raw CLI name on non-Windows platforms (resolveCliPathAsync is a no-op there)', async () => {
    await withPlatform('linux', async () => {
      resolvedClaudePath = 'claude';
      const provider = new ClaudeCodeProvider();
      const promise = provider.isAvailable();
      await resolveNextSpawnClose(0);
      await promise;
      expect(spawnCalls[0]!.command).toBe('claude');
    });
  });
});

// ── validateConfig() ─────────────────────────────────────────────────────────

describe('ClaudeCodeProvider.validateConfig', () => {
  test('flags a non-claude-code providerId', async () => {
    const provider = new ClaudeCodeProvider();
    const badConfig = {
      providerId: 'other-provider',
      enabled: true,
    } as unknown as AgentProviderConfig;

    const promise = provider.validateConfig(badConfig);
    await resolveNextSpawnClose(0);
    const result = await promise;

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "Invalid provider ID: expected 'claude-code', got 'other-provider'",
    );
  });

  test('flags an unavailable CLI', async () => {
    const provider = new ClaudeCodeProvider();
    const promise = provider.validateConfig(makeConfig());
    await resolveNextSpawnClose(1);
    const result = await promise;

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Claude Code CLI is not installed or not available in PATH');
  });

  test('flags a cliPath that does not exist on disk', async () => {
    accessImpl = () => Promise.reject(new Error('ENOENT'));
    const provider = new ClaudeCodeProvider();
    const promise = provider.validateConfig(makeConfig({ cliPath: '/no/such/cli' }));
    await resolveNextSpawnClose(0);
    const result = await promise;

    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Specified CLI path does not exist: /no/such/cli');
  });

  test('is valid when the providerId matches, the CLI is available, and cliPath resolves', async () => {
    accessImpl = () => Promise.resolve();
    const provider = new ClaudeCodeProvider();
    const promise = provider.validateConfig(makeConfig({ cliPath: '/usr/bin/claude' }));
    await resolveNextSpawnClose(0);
    const result = await promise;

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('skips the cliPath check entirely when cliPath is not set', async () => {
    const provider = new ClaudeCodeProvider();
    const promise = provider.validateConfig(makeConfig());
    await resolveNextSpawnClose(0);
    const result = await promise;

    expect(result.valid).toBe(true);
    expect(mockAccess.mock.calls.length).toBe(0);
  });
});

// ── healthCheck() ────────────────────────────────────────────────────────────

describe('ClaudeCodeProvider.healthCheck', () => {
  test('reports healthy=true with platform/cliPath details when the CLI is available', async () => {
    const provider = new ClaudeCodeProvider();
    const promise = provider.healthCheck();
    await resolveNextSpawnClose(0);
    const result = await promise;

    expect(result.healthy).toBe(true);
    expect(result.available).toBe(true);
    expect(result.errors).toBeUndefined();
    expect(result.lastCheck).toBeInstanceOf(Date);
    expect(result.details?.platform).toBe(process.platform);
  });

  test('reports healthy=false with an error message when the CLI is unavailable', async () => {
    const provider = new ClaudeCodeProvider();
    const promise = provider.healthCheck();
    await resolveNextSpawnClose(1);
    const result = await promise;

    expect(result.healthy).toBe(false);
    expect(result.available).toBe(false);
    expect(result.errors).toEqual(['Claude Code CLI is not available']);
  });

  test('reports healthy=false via the outer catch when isAvailable() itself rejects', async () => {
    spawnShouldThrow = true;
    const provider = new ClaudeCodeProvider();

    const result = await provider.healthCheck();

    expect(result.healthy).toBe(false);
    expect(result.available).toBe(false);
    expect(result.errors).toEqual(['spawn boom']);
    expect(result.lastCheck).toBeInstanceOf(Date);
  });
});

// ── createAgent() ────────────────────────────────────────────────────────────

describe('ClaudeCodeProvider.createAgent', () => {
  test('merges provider-level defaults with per-call overrides, overrides taking precedence', () => {
    const provider = new ClaudeCodeProvider({
      defaultTimeout: 5000,
      dangerouslySkipPermissions: false,
    });

    const agent = provider.createAgent({
      providerId: 'claude-code',
      enabled: true,
      dangerouslySkipPermissions: true,
    });

    expect(agent).toBeInstanceOf(MockAdapter);
    expect((agent as unknown as MockAdapter).config).toEqual({
      providerId: 'claude-code',
      enabled: true,
      defaultTimeout: 5000,
      dangerouslySkipPermissions: true,
    });
  });

  test('works with no provider-level defaults', () => {
    const provider = new ClaudeCodeProvider();
    const agent = provider.createAgent(makeConfig({ cliPath: '/usr/bin/claude' }));

    expect((agent as unknown as MockAdapter).config).toEqual({
      providerId: 'claude-code',
      enabled: true,
      cliPath: '/usr/bin/claude',
    });
  });
});
