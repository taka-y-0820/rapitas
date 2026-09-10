/**
 * Tests for removeWorktree's boolean return-value propagation through
 * cleanupOrphanedWorktrees and cleanupStaleWorktrees (task 790 / K-8046 /
 * K-8047 — a safety-guard refusal or fs-fallback exhaustion must not be
 * silently treated as a successful removal by callers). Split from
 * worktree-ops.test.ts, which is already at the 500-line hard limit.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';

const mockPrisma = {
  agentSession: {
    findMany: mock(() => Promise.resolve([])),
    update: mock(() => Promise.resolve({})),
    updateMany: mock(() => Promise.resolve({ count: 0 })),
  },
};

let worktreeListStdout = `worktree /test/repo
HEAD abcd1234

worktree /test/repo/.worktrees/task-123-abc123
branch refs/heads/feature/task-123

`;

// NOTE: See worktree-ops.test.ts for why util.promisify(execFile) is simulated
// this way — this file mirrors that harness for the subset it needs.
const makeExecResult = (command: string) => ({
  stdout: command.includes('git worktree list --porcelain') ? worktreeListStdout : '',
  stderr: '',
});

const mockExecFile = mock((file: string, args: unknown, options: unknown, callback?: unknown) => {
  const argv = Array.isArray(args) ? (args as string[]) : [];
  const cb = (typeof options === 'function' ? options : callback) as
    | ((error: Error | null, result: unknown) => void)
    | undefined;
  const command = [file, ...argv].join(' ');
  cb?.(null, makeExecResult(command));
  return { kill: mock(() => undefined) };
});

const mockExec = mock((command: string, options: unknown, callback?: unknown) => {
  const cb = (typeof options === 'function' ? options : callback) as
    | ((error: Error | null, result: unknown) => void)
    | undefined;
  cb?.(null, { stdout: '', stderr: '' });
  return { kill: mock(() => undefined) };
});

const mockExistsSync = mock((_path: string) => false);
const mockAwaitWorktreeDependencies = mock(() => Promise.resolve());
const mockClearWorktreeDependenciesTracking = mock(() => {});
const mockClearGitRemoteCache = mock((_cwd: string) => {});
const mockIsPathSafe = mock(() => true);
// NOTE: rmDirWithRetry is mocked directly (rather than making node:fs/promises's
// rm reject repeatedly) so the "fs fallback exhausted" case resolves instantly
// instead of waiting through the real 1+2+3+4s exponential backoff.
const mockRmDirWithRetry = mock(() => Promise.resolve(true));

mock.module('../../../../../config/database', () => ({
  ensureDatabaseConnection: () => Promise.resolve(),
  prisma: mockPrisma,
}));
mock.module('../../../../../config/logger', () => ({
  createLogger: () => ({
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
  }),
}));
mock.module('child_process', () => ({ execFile: mockExecFile, exec: mockExec }));
mock.module('node:child_process', () => ({ execFile: mockExecFile, exec: mockExec }));
mock.module('node:fs', () => ({ existsSync: mockExistsSync }));
mock.module('node:fs/promises', () => ({
  rm: mock(() => Promise.resolve(undefined)),
  readdir: mock(() => Promise.resolve([])),
  stat: mock(() => Promise.resolve({ isDirectory: () => false } as import('node:fs').Stats)),
  mkdir: mock(() => Promise.resolve()),
  appendFile: mock(() => Promise.resolve()),
}));
mock.module('../core/safety', () => ({
  WORKTREE_DIR: '.worktrees',
  isPathSafeForWorktreeOperation: mockIsPathSafe,
  normalizePath: (path: string) => path.replace(/\\/g, '/'),
}));
mock.module('./dependency-installer', () => ({
  awaitWorktreeDependencies: mockAwaitWorktreeDependencies,
  clearWorktreeDependenciesTracking: mockClearWorktreeDependenciesTracking,
}));
mock.module('../../../../github/git-exec', () => ({
  clearGitRemoteCache: mockClearGitRemoteCache,
}));
mock.module('./dir-remove-retry', () => ({ rmDirWithRetry: mockRmDirWithRetry }));
mock.module('../../../worktree-keep-list', () => ({
  computeWorktreeKeepPaths: mock(() => Promise.resolve([])),
}));
mock.module('../../../../../utils/common/branch-name-generator', () => ({
  hasTaskIdMarker: (branchName: string, taskId: number) =>
    new RegExp(`(?:^|[/-])t${taskId}(?:[/-]|$)`).test(branchName),
}));

const { removeWorktree, cleanupOrphanedWorktrees, cleanupStaleWorktrees } =
  await import('./worktree-ops');

const mockBaseDir = '/test/repo';
const mockWorktreePath = '/test/repo/.worktrees/task-123-abc123';

/** Makes `git worktree remove` fail so removeWorktree falls through to the fs fallback. */
function gitRemoveFails() {
  mockExecFile.mockImplementation(
    (file: string, args: unknown, options: unknown, callback?: unknown) => {
      const argv = Array.isArray(args) ? (args as string[]) : [];
      const cb = (typeof options === 'function' ? options : callback) as
        | ((error: Error | null, result: unknown) => void)
        | undefined;
      const command = [file, ...argv].join(' ');
      if (command.includes('git worktree remove')) {
        cb?.(new Error('git error'), undefined);
      } else {
        cb?.(null, makeExecResult(command));
      }
      return { kill: mock(() => undefined) };
    },
  );
}

beforeEach(() => {
  mockExistsSync.mockReset();
  mockExistsSync.mockImplementation(() => false);
  mockAwaitWorktreeDependencies.mockReset();
  mockAwaitWorktreeDependencies.mockResolvedValue(undefined);
  mockClearWorktreeDependenciesTracking.mockReset();
  mockClearGitRemoteCache.mockReset();
  mockIsPathSafe.mockReset();
  mockIsPathSafe.mockImplementation(() => true);
  mockRmDirWithRetry.mockReset();
  mockRmDirWithRetry.mockResolvedValue(true);
  mockPrisma.agentSession.findMany.mockReset();
  mockPrisma.agentSession.findMany.mockResolvedValue([]);
  mockPrisma.agentSession.update.mockReset();
  mockPrisma.agentSession.update.mockResolvedValue({});
  mockPrisma.agentSession.updateMany.mockReset();
  mockPrisma.agentSession.updateMany.mockResolvedValue({ count: 0 });

  worktreeListStdout = `worktree /test/repo
HEAD abcd1234

worktree /test/repo/.worktrees/task-123-abc123
branch refs/heads/feature/task-123

`;
  mockExecFile.mockReset();
  mockExecFile.mockImplementation(
    (file: string, args: unknown, options: unknown, callback?: unknown) => {
      const argv = Array.isArray(args) ? (args as string[]) : [];
      const cb = (typeof options === 'function' ? options : callback) as
        | ((error: Error | null, result: unknown) => void)
        | undefined;
      const command = [file, ...argv].join(' ');
      cb?.(null, makeExecResult(command));
      return { kill: mock(() => undefined) };
    },
  );
});

describe('removeWorktree — return-value signal', () => {
  test('missing local Git metadata cannot borrow a clean parent status', async () => {
    mockExistsSync.mockImplementation((p: string) => p === mockWorktreePath);
    expect(await removeWorktree(mockBaseDir, mockWorktreePath, false)).toBe(false);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockRmDirWithRetry).not.toHaveBeenCalled();
  });

  test.each(['late-change', 'status-error'])('refuses uncertain content: %s', async (scenario) => {
    mockExistsSync.mockImplementation(
      (p: string) => p === mockWorktreePath || p === join(mockWorktreePath, '.git'),
    );
    let checks = 0;
    mockExecFile.mockImplementation(
      (file: string, args: unknown, options: unknown, callback?: unknown) => {
        const argv = Array.isArray(args) ? (args as string[]) : [];
        const cb = (typeof options === 'function' ? options : callback) as
          | ((error: Error | null, result: unknown) => void)
          | undefined;
        if (argv.includes('status')) {
          checks++;
          if (scenario === 'status-error') cb?.(new Error('git status failed'), undefined);
          else cb?.(null, { stdout: checks > 1 ? '?? late.ts\n' : '', stderr: '' });
        } else cb?.(null, makeExecResult([file, ...argv].join(' ')));
        return { kill: mock(() => undefined) };
      },
    );
    expect(await removeWorktree(mockBaseDir, mockWorktreePath, false)).toBe(false);
    expect(
      mockExecFile.mock.calls.some((call) => Array.isArray(call[1]) && call[1].includes('remove')),
    ).toBe(false);
    expect(mockRmDirWithRetry).not.toHaveBeenCalled();
  });

  test.each([' M existing.ts\n', '?? new-module.ts\n'])(
    'preserves unsaved work before teardown: %s',
    async (status) => {
      mockExistsSync.mockImplementation(() => true);
      mockExecFile.mockImplementation(
        (file: string, args: unknown, options: unknown, callback?: unknown) => {
          const argv = Array.isArray(args) ? (args as string[]) : [];
          const cb = (typeof options === 'function' ? options : callback) as
            | ((error: Error | null, result: unknown) => void)
            | undefined;
          cb?.(
            null,
            argv.includes('status')
              ? { stdout: status, stderr: '' }
              : makeExecResult([file, ...argv].join(' ')),
          );
          return { kill: mock(() => undefined) };
        },
      );

      expect(await removeWorktree(mockBaseDir, mockWorktreePath, false)).toBe(false);
      expect(
        mockExecFile.mock.calls.some((call) => {
          const argv = Array.isArray(call[1]) ? (call[1] as string[]) : [];
          return argv.includes('--teardown') || argv.includes('remove');
        }),
      ).toBe(false);
      expect(mockRmDirWithRetry).not.toHaveBeenCalled();
    },
  );

  test('returns false without throwing when the safety guard refuses', async () => {
    mockIsPathSafe.mockImplementation(() => false);

    const result = await removeWorktree(mockBaseDir, mockWorktreePath, false);

    expect(result).toBe(false);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  test('returns true when git worktree remove succeeds', async () => {
    const result = await removeWorktree(mockBaseDir, mockWorktreePath, false);
    expect(result).toBe(true);
  });

  test('returns true when git worktree remove fails but the fs fallback succeeds', async () => {
    gitRemoveFails();
    mockExistsSync.mockImplementation(
      (p: string) => p === mockWorktreePath || p === join(mockWorktreePath, '.git'),
    );
    mockRmDirWithRetry.mockResolvedValue(true);

    const result = await removeWorktree(mockBaseDir, mockWorktreePath, false);

    expect(result).toBe(true);
  });

  test('returns false when git worktree remove fails and the fs fallback is exhausted', async () => {
    gitRemoveFails();
    mockExistsSync.mockImplementation(
      (p: string) => p === mockWorktreePath || p === join(mockWorktreePath, '.git'),
    );
    mockRmDirWithRetry.mockResolvedValue(false);

    const result = await removeWorktree(mockBaseDir, mockWorktreePath, false);

    expect(result).toBe(false);
  });

  test('uses different timeouts for the teardown script (slow) and git worktree remove (fast) (#809)', async () => {
    const teardownScriptPath = join(mockWorktreePath, 'scripts', 'setup-worktree.cjs');
    mockExistsSync.mockImplementation((p: string) => p === teardownScriptPath);

    await removeWorktree(mockBaseDir, mockWorktreePath, false);

    const teardownCall = mockExecFile.mock.calls.find((c) =>
      (Array.isArray(c[1]) ? (c[1] as string[]) : []).includes('--teardown'),
    );
    const removeCall = mockExecFile.mock.calls.find((c) => {
      const argv = Array.isArray(c[1]) ? (c[1] as string[]) : [];
      return [c[0], ...argv].join(' ').includes('git worktree remove');
    });
    expect((teardownCall?.[2] as { timeout?: number } | undefined)?.timeout).toBe(120_000);
    expect((removeCall?.[2] as { timeout?: number } | undefined)?.timeout).toBe(60_000);
  });
});

describe('cleanupOrphanedWorktrees — refused/failed removal is not treated as cleaned up', () => {
  test('does not increment cleanedCount or clear worktreePath when removeWorktree returns false', async () => {
    mockPrisma.agentSession.findMany.mockResolvedValue([
      { id: 1, worktreePath: mockWorktreePath, status: 'completed' },
    ] as never);
    gitRemoveFails();
    mockExistsSync.mockImplementation(
      (p: string) => p === mockWorktreePath || p === join(mockWorktreePath, '.git'),
    );
    mockRmDirWithRetry.mockResolvedValue(false);

    const cleanedCount = await cleanupOrphanedWorktrees(mockBaseDir);

    expect(cleanedCount).toBe(0);
    expect(mockPrisma.agentSession.updateMany).not.toHaveBeenCalled();
  });

  test('increments cleanedCount and clears worktreePath when removeWorktree returns true', async () => {
    mockPrisma.agentSession.findMany.mockResolvedValue([
      { id: 1, worktreePath: mockWorktreePath, status: 'completed' },
    ] as never);

    const cleanedCount = await cleanupOrphanedWorktrees(mockBaseDir);

    expect(cleanedCount).toBe(1);
    expect(mockPrisma.agentSession.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('cleanupStaleWorktrees — refused/failed removal is not counted', () => {
  test('does not increment cleanedCount when removeWorktree returns false', async () => {
    gitRemoveFails();
    mockExistsSync.mockImplementation(
      (p: string) => p === mockWorktreePath || p === join(mockWorktreePath, '.git'),
    );
    mockRmDirWithRetry.mockResolvedValue(false);

    const cleanedCount = await cleanupStaleWorktrees(mockBaseDir);

    expect(cleanedCount).toBe(0);
  });

  test('increments cleanedCount when removeWorktree returns true', async () => {
    const cleanedCount = await cleanupStaleWorktrees(mockBaseDir);
    expect(cleanedCount).toBe(1);
  });
});
