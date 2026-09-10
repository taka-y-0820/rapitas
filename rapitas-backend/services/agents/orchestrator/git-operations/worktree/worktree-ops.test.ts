/**
 * Tests for git worktree cleanup operations.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';

const mockPrisma = {
  agentSession: {
    findMany: mock(() => Promise.resolve([])),
    update: mock(() => Promise.resolve({})),
    updateMany: mock(() => Promise.resolve({ count: 0 })),
  },
  // computeWorktreeKeepPaths (used by cleanupOrphanedWorktrees's new liveness
  // guard) queries this — empty means "no live task owns any worktree here",
  // matching these tests' genuinely-orphaned fixtures.
  task: {
    findMany: mock(() => Promise.resolve([])),
  },
};

let worktreeListStdout = `worktree /test/repo
HEAD abcd1234

worktree /test/repo/.worktrees/task-123-abc123
branch refs/heads/feature/task-123

`;

// NOTE: util.promisify(execFile) resolves with the FIRST callback argument. To simulate
// the real execFile behaviour (which uses util.promisify.custom to return { stdout, stderr }),
// we pass { stdout, stderr } as the first callback arg so destructuring works in the module.
// The production code was migrated from exec(shell string) to execFile(file, args[]) to close
// a shell-injection vector; this mock joins file+args back into a "command" string so the
// existing command-matching assertions below keep working unchanged.
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

// NOTE: Mirror ALL child_process exports — bun mock.module is process-global, and
// worktree-ops.ts pulls in repository-setup.ts / git-exec.ts / worktree-preflight.ts,
// which still import the shell-string `exec` (not under test here). Without this
// stub, their `import { exec } from 'child_process'` would fail to resolve.
const mockExec = mock((command: string, options: unknown, callback?: unknown) => {
  const cb = (typeof options === 'function' ? options : callback) as
    | ((error: Error | null, result: unknown) => void)
    | undefined;
  cb?.(null, { stdout: '', stderr: '' });
  return { kill: mock(() => undefined) };
});

const mockExistsSync = mock((_path: string) => false);
const mockFsRm = mock(() => Promise.resolve(undefined));
const mockReaddir = mock(() => Promise.resolve([]));
const mockStat = mock(() =>
  Promise.resolve({ isDirectory: () => false } as import('node:fs').Stats),
);
const mockAwaitWorktreeDependencies = mock(() => Promise.resolve());
const mockClearWorktreeDependenciesTracking = mock(() => {});
const mockClearGitRemoteCache = mock((_cwd: string) => {});

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
mock.module('node:fs', () => ({
  existsSync: mockExistsSync,
}));
mock.module('node:fs/promises', () => ({
  rm: mockFsRm,
  rmdir: mockFsRm,
  readdir: mockReaddir,
  stat: mockStat,
  mkdir: mock(() => Promise.resolve()),
  appendFile: mock(() => Promise.resolve()),
}));
const mockIsPathSafeForWorktreeOperation = mock(() => true);
mock.module('../core/safety', () => ({
  WORKTREE_DIR: '.worktrees',
  isPathSafeForWorktreeOperation: mockIsPathSafeForWorktreeOperation,
  normalizePath: mock((path: string) => path.replace(/\\/g, '/')),
}));
mock.module('./dependency-installer', () => ({
  awaitWorktreeDependencies: mockAwaitWorktreeDependencies,
  clearWorktreeDependenciesTracking: mockClearWorktreeDependenciesTracking,
}));
mock.module('../../../../github/git-exec', () => ({
  clearGitRemoteCache: mockClearGitRemoteCache,
}));
// NOTE: worktree-ops imports hasTaskIdMarker from branch-name-generator, whose
// real module pulls in the ai-client dependency chain — far beyond this test's
// minimal node-primitive mocks. hasTaskIdMarker is a pure function covered by
// branch-name-generator.test.ts; mirror its logic to keep the module graph small.
mock.module('../../../../../utils/common/branch-name-generator', () => ({
  hasTaskIdMarker: (branchName: string, taskId: number) =>
    new RegExp(`(?:^|[/-])t${taskId}(?:[/-]|$)`).test(branchName),
}));

const { cleanupOrphanedWorktrees, cleanupStaleWorktrees, removeWorktree, rmDirWithRetry } =
  await import('./worktree-ops');

// ---------------------------------------------------------------------------
// rmDirWithRetry
// ---------------------------------------------------------------------------

describe('rmDirWithRetry', () => {
  const noopSleep = () => Promise.resolve();

  beforeEach(() => {
    mockFsRm.mockReset();
    mockFsRm.mockResolvedValue(undefined);
  });

  test.each([
    {
      desc: 'returns true on first-attempt success',
      setupFsRm: () => {},
      expectedResult: true,
      expectedCalls: 1,
    },
    {
      desc: 'returns true after EBUSY failures then success',
      setupFsRm: () => {
        let callCount = 0;
        mockFsRm.mockImplementation(() => {
          callCount++;
          if (callCount < 4) {
            const err = Object.assign(new Error('EBUSY: resource busy or locked'), {
              code: 'EBUSY',
            });
            return Promise.reject(err);
          }
          return Promise.resolve(undefined);
        });
      },
      expectedResult: true,
      expectedCalls: 4,
    },
    {
      desc: 'returns false after all attempts fail and does not throw',
      setupFsRm: () => {
        const ebusyErr = Object.assign(new Error('EBUSY: resource busy or locked'), {
          code: 'EBUSY',
        });
        mockFsRm.mockImplementation(() => Promise.reject(ebusyErr));
      },
      expectedResult: false,
      expectedCalls: 5,
    },
  ])('$desc', async ({ setupFsRm, expectedResult, expectedCalls }) => {
    setupFsRm();

    let thrownError: unknown;
    let result: boolean | undefined;
    try {
      result = await rmDirWithRetry('/test/dir', { sleepFn: noopSleep, maxAttempts: 5 });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeUndefined();
    expect(result).toBe(expectedResult);
    expect(mockFsRm).toHaveBeenCalledTimes(expectedCalls);
  });
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

describe('removeWorktree', () => {
  const mockBaseDir = '/test/repo';
  const mockWorktreePath = '/test/repo/.worktrees/task-123-abc123';

  beforeEach(() => {
    mockExistsSync.mockReset();
    mockExistsSync.mockImplementation(() => false);
    mockFsRm.mockReset();
    mockFsRm.mockResolvedValue(undefined);
    mockAwaitWorktreeDependencies.mockReset();
    mockAwaitWorktreeDependencies.mockResolvedValue(undefined);
    mockClearWorktreeDependenciesTracking.mockReset();
    mockClearGitRemoteCache.mockReset();
    mockIsPathSafeForWorktreeOperation.mockReset();
    mockIsPathSafeForWorktreeOperation.mockReturnValue(true);

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

  test('calls awaitWorktreeDependencies before git worktree remove', async () => {
    const callOrder: string[] = [];

    mockAwaitWorktreeDependencies.mockImplementation(async () => {
      callOrder.push('awaitDependencies');
    });

    mockExecFile.mockImplementation(
      (file: string, args: unknown, options: unknown, callback?: unknown) => {
        const argv = Array.isArray(args) ? (args as string[]) : [];
        const cb = (typeof options === 'function' ? options : callback) as
          | ((error: Error | null, result: unknown) => void)
          | undefined;
        const command = [file, ...argv].join(' ');
        if (command.includes('git worktree remove')) {
          callOrder.push('gitWorktreeRemove');
        }
        cb?.(null, makeExecResult(command));
        return { kill: mock(() => undefined) };
      },
    );

    await removeWorktree(mockBaseDir, mockWorktreePath, false);

    const awaitIdx = callOrder.indexOf('awaitDependencies');
    const removeIdx = callOrder.indexOf('gitWorktreeRemove');
    expect(awaitIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(awaitIdx).toBeLessThan(removeIdx);
  });

  test('calls clearWorktreeDependenciesTracking after removal', async () => {
    await removeWorktree(mockBaseDir, mockWorktreePath, false);
    expect(mockClearWorktreeDependenciesTracking).toHaveBeenCalledWith(mockWorktreePath);
  });

  test('passes a timeout on the git worktree remove call so a hang cannot block the phase (#809)', async () => {
    await removeWorktree(mockBaseDir, mockWorktreePath, false);
    const removeCall = mockExecFile.mock.calls.find((c) => {
      const argv = Array.isArray(c[1]) ? (c[1] as string[]) : [];
      return [c[0], ...argv].join(' ').includes('git worktree remove');
    });
    const opts = removeCall?.[2] as { timeout?: number } | undefined;
    expect(opts?.timeout).toBe(60_000);
  });

  test('attempts rm when git worktree remove fails and directory exists', async () => {
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

    // Only the worktree root exists (no .git sub-directory)
    mockExistsSync.mockImplementation(
      (p: string) => p === mockWorktreePath || p === join(mockWorktreePath, '.git'),
    );

    await removeWorktree(mockBaseDir, mockWorktreePath, false);

    expect(mockFsRm).toHaveBeenCalledWith(mockWorktreePath, { recursive: true, force: true });
  });

  test('continues gracefully when awaitWorktreeDependencies rejects', async () => {
    mockAwaitWorktreeDependencies.mockImplementation(() =>
      Promise.reject(new Error('setup failed')),
    );

    // Should not throw even when awaitWorktreeDependencies rejects
    let thrownError: unknown;
    try {
      await removeWorktree(mockBaseDir, mockWorktreePath, false);
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeUndefined();
  });

  test('calls clearGitRemoteCache with worktreePath after successful removal', async () => {
    await removeWorktree(mockBaseDir, mockWorktreePath, false);
    expect(mockClearGitRemoteCache).toHaveBeenCalledTimes(1);
    expect(mockClearGitRemoteCache).toHaveBeenCalledWith(mockWorktreePath);
  });

  test('calls clearGitRemoteCache even when git worktree remove fails and fs fallback runs', async () => {
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

    // Only the worktree root exists (no .git sub-directory)
    mockExistsSync.mockImplementation(
      (p: string) => p === mockWorktreePath || p === join(mockWorktreePath, '.git'),
    );

    await removeWorktree(mockBaseDir, mockWorktreePath, false);

    expect(mockClearGitRemoteCache).toHaveBeenCalledTimes(1);
    expect(mockClearGitRemoteCache).toHaveBeenCalledWith(mockWorktreePath);
  });

  test('returns early without running any git/fs cleanup when the path is unsafe', async () => {
    mockIsPathSafeForWorktreeOperation.mockReturnValueOnce(false);

    let thrownError: unknown;
    try {
      await removeWorktree(mockWorktreePath, mockWorktreePath, false);
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockAwaitWorktreeDependencies).not.toHaveBeenCalled();
    expect(mockClearWorktreeDependenciesTracking).not.toHaveBeenCalled();
    expect(mockClearGitRemoteCache).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// cleanupOrphanedWorktrees
// ---------------------------------------------------------------------------

describe('cleanupOrphanedWorktrees', () => {
  const mockBaseDir = '/test/repo';

  beforeEach(() => {
    mockPrisma.agentSession.findMany.mockReset();
    mockPrisma.agentSession.update.mockReset();
    mockPrisma.agentSession.updateMany.mockReset();
    mockPrisma.task.findMany.mockReset();
    mockExecFile.mockReset();
    mockExistsSync.mockReset();
    mockFsRm.mockReset();
    mockReaddir.mockReset();
    mockAwaitWorktreeDependencies.mockReset();

    mockPrisma.agentSession.findMany.mockResolvedValue([]);
    mockPrisma.agentSession.update.mockResolvedValue({});
    mockPrisma.agentSession.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockExistsSync.mockImplementation(() => false);
    mockFsRm.mockResolvedValue(undefined);
    mockReaddir.mockResolvedValue([]);
    mockAwaitWorktreeDependencies.mockResolvedValue(undefined);
    worktreeListStdout = `worktree /test/repo
HEAD abcd1234

worktree /test/repo/.worktrees/task-123-abc123
branch refs/heads/feature/task-123

`;
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

  test('passes a timeout on the git worktree list call so a hang cannot block cleanup (#809)', async () => {
    // The filesystem-orphan scan (which issues the `git worktree list` call
    // under test) only runs when the worktree root exists.
    mockExistsSync.mockImplementation(() => true);
    await cleanupOrphanedWorktrees(mockBaseDir);
    const listCall = mockExecFile.mock.calls.find((c) => {
      const argv = Array.isArray(c[1]) ? (c[1] as string[]) : [];
      return [c[0], ...argv].join(' ').includes('git worktree list --porcelain');
    });
    const opts = listCall?.[2] as { timeout?: number } | undefined;
    expect(opts?.timeout).toBe(60_000);
  });

  test('cleans up database-tracked orphaned worktrees', async () => {
    mockPrisma.agentSession.findMany.mockResolvedValue([
      {
        id: 1,
        worktreePath: '/test/repo/.worktrees/task-123-abc123',
        status: 'completed',
      },
      {
        id: 2,
        worktreePath: '/test/repo/.worktrees/task-456-def456',
        status: 'failed',
      },
    ] as never);

    const cleanedCount = await cleanupOrphanedWorktrees(mockBaseDir);

    expect(cleanedCount).toBe(2);
    expect(mockPrisma.agentSession.findMany).toHaveBeenCalledWith({
      where: {
        worktreePath: { not: null },
        status: { in: ['completed', 'failed', 'cancelled'] },
      },
      select: {
        id: true,
        worktreePath: true,
        status: true,
      },
    });
    expect(mockPrisma.agentSession.updateMany).toHaveBeenCalledTimes(2);
  });

  test('groups sessions sharing the same worktreePath: removeWorktree called once, all session ids cleared (#825)', async () => {
    mockPrisma.agentSession.findMany.mockResolvedValue([
      { id: 1, worktreePath: '/test/repo/.worktrees/task-621-abc', status: 'completed' },
      { id: 2, worktreePath: '/test/repo/.worktrees/task-621-abc', status: 'failed' },
      { id: 3, worktreePath: '/test/repo/.worktrees/task-621-abc', status: 'cancelled' },
    ] as never);

    const cleanedCount = await cleanupOrphanedWorktrees(mockBaseDir);

    // One unique directory → one removeWorktree call and one cleanedCount increment,
    // even though three session rows reference it.
    expect(cleanedCount).toBe(1);
    const removeWorktreeCalls = mockExecFile.mock.calls.filter((c) => {
      const argv = Array.isArray(c[1]) ? (c[1] as string[]) : [];
      return [c[0], ...argv].join(' ').includes('git worktree remove');
    });
    expect(removeWorktreeCalls).toHaveLength(1);
    expect(mockPrisma.agentSession.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.agentSession.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [1, 2, 3] } },
      data: { worktreePath: null },
    });
  });

  test('skips a worktree whose AgentSession is terminal but the owning Task is still live', async () => {
    // Reproduces the task-501 incident: a self-repair bounce leaves the OLD
    // session marked 'failed' while the same worktree keeps being used by the
    // task's current (non-terminal) run. Deleting on the stale session alone
    // would wipe a real in-progress implementation.
    mockPrisma.agentSession.findMany.mockResolvedValue([
      { id: 3, worktreePath: '/test/repo/.worktrees/task-789-live123', status: 'failed' },
    ] as never);
    // computeWorktreeKeepPaths's bare readdir(worktreeRoot) call (no options) —
    // must list the directory name so it can parse the owning task id.
    mockReaddir.mockImplementation((..._args: unknown[]) => {
      const opts = _args[1] as { withFileTypes?: boolean } | undefined;
      return Promise.resolve(opts?.withFileTypes ? [] : ['task-789-live123']);
    });
    // Task 789 is still non-terminal (e.g. 'in_progress') — the keep-list
    // query matches it.
    mockPrisma.task.findMany.mockResolvedValue([{ id: 789 }] as never);

    const cleanedCount = await cleanupOrphanedWorktrees(mockBaseDir);

    expect(cleanedCount).toBe(0);
    expect(mockPrisma.agentSession.updateMany).not.toHaveBeenCalled();
  });

  test('continues processing multiple database-tracked worktrees', async () => {
    mockPrisma.agentSession.findMany.mockResolvedValue([
      {
        id: 1,
        worktreePath: '/test/repo/.worktrees/task-123-abc123',
        status: 'completed',
      },
      {
        id: 2,
        worktreePath: '/test/repo/.worktrees/task-456-def456',
        status: 'failed',
      },
    ] as never);

    const cleanedCount = await cleanupOrphanedWorktrees(mockBaseDir);

    expect(cleanedCount).toBe(2);
    expect(mockPrisma.agentSession.updateMany).toHaveBeenCalledTimes(2);
  });

  test('skips null worktree paths', async () => {
    mockPrisma.agentSession.findMany.mockResolvedValue([
      {
        id: 1,
        worktreePath: null,
        status: 'completed',
      },
      {
        id: 2,
        worktreePath: '/test/repo/.worktrees/task-456-def456',
        status: 'failed',
      },
    ] as never);

    const cleanedCount = await cleanupOrphanedWorktrees(mockBaseDir);

    expect(cleanedCount).toBe(1);
    expect(mockPrisma.agentSession.updateMany).toHaveBeenCalledTimes(1);
  });

  test.each(['EBUSY', 'ENOTEMPTY'])(
    'filesystem orphan: %s preserves contents and cleanup continues',
    async (code) => {
      const ebusyErr = Object.assign(new Error(code), {
        code,
      });
      // NOTE: Inject a no-op sleepFn so retries do not incur real 1-4s waits.
      const noopSleep = () => Promise.resolve();

      // NOTE: Set all mocks inline so this test doesn't depend on beforeEach residue.
      // Return true for all existsSync paths — no DB sessions, so removeWorktree is never called.
      mockPrisma.agentSession.findMany.mockImplementation(() => Promise.resolve([]));
      mockFsRm.mockImplementation(() => Promise.reject(ebusyErr));
      mockExistsSync.mockImplementation(() => true);
      // Shape depends on the caller: worktree-ops.ts asks for Dirent objects
      // (withFileTypes: true) to sweep the filesystem; computeWorktreeKeepPaths
      // (the new liveness guard) does a bare readdir expecting plain name
      // strings. Both hit this same mocked module, so return the shape the
      // caller actually asked for instead of always Dirent-like objects.
      mockReaddir.mockImplementation((..._args: unknown[]) => {
        const opts = _args[1] as { withFileTypes?: boolean } | undefined;
        if (opts?.withFileTypes) {
          return Promise.resolve([
            { name: 'task-9001-aaa', isDirectory: () => true },
            { name: 'task-9002-bbb', isDirectory: () => true },
          ]);
        }
        return Promise.resolve(['task-9001-aaa', 'task-9002-bbb']);
      });
      // Both orphan paths are NOT in the git tracked list (worktreeListStdout only has task-123-abc123)

      let thrownError: unknown;
      let result: number | undefined;
      try {
        result = await cleanupOrphanedWorktrees(mockBaseDir, { sleepFn: noopSleep });
      } catch (err) {
        thrownError = err;
      }

      // Must not throw
      expect(thrownError).toBeUndefined();
      // Orphans that failed are not counted
      expect(result).toBe(0);
      // rm was attempted (exact path is platform-specific; just verify it was invoked)
      expect(mockFsRm).toHaveBeenCalled();
    },
  );

  test('filesystem orphan: successful rm increments count', async () => {
    // NOTE: Inject a no-op sleepFn to avoid real waits on any retry path.
    const noopSleep = () => Promise.resolve();
    // NOTE: Set all mocks inline for isolation.
    mockPrisma.agentSession.findMany.mockImplementation(() => Promise.resolve([]));
    mockFsRm.mockImplementation(() => Promise.resolve(undefined));
    mockExistsSync.mockImplementation(() => true);
    // See the shape note in the EBUSY test above — same dual-caller mock.
    mockReaddir.mockImplementation((..._args: unknown[]) => {
      const opts = _args[1] as { withFileTypes?: boolean } | undefined;
      if (opts?.withFileTypes) {
        return Promise.resolve([{ name: 'task-9003-xyz', isDirectory: () => true }]);
      }
      return Promise.resolve(['task-9003-xyz']);
    });
    // git list does NOT include task-9003-xyz → it's an orphan

    const result = await cleanupOrphanedWorktrees(mockBaseDir, { sleepFn: noopSleep });

    expect(result).toBe(1);
    expect(mockFsRm).toHaveBeenCalledWith(expect.stringContaining('task-9003-xyz'));
    expect(mockFsRm.mock.calls.every((call) => call.length === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cleanupStaleWorktrees
// ---------------------------------------------------------------------------

describe('cleanupStaleWorktrees', () => {
  const mockBaseDir = '/test/repo';

  beforeEach(() => {
    mockExecFile.mockReset();
    worktreeListStdout = `worktree /test/repo
HEAD abcd1234

`;
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

  test('passes a timeout on the git worktree prune call so a hang cannot block startup (#809)', async () => {
    await cleanupStaleWorktrees(mockBaseDir);
    const pruneCall = mockExecFile.mock.calls.find((c) => {
      const argv = Array.isArray(c[1]) ? (c[1] as string[]) : [];
      return [c[0], ...argv].join(' ') === 'git worktree prune';
    });
    const opts = pruneCall?.[2] as { timeout?: number } | undefined;
    expect(opts?.timeout).toBe(60_000);
  });
});
