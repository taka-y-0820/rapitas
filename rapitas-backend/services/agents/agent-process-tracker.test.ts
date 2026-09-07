/**
 * agent-process-tracker.test
 *
 * Unit tests for registerProcess / unregisterProcess / cleanupZombieProcesses /
 * killProcessTreeSafely / clearAllPidFiles. All fs and child_process access is
 * mocked — no real processes or files are ever touched.
 *
 * NOTE: mock.module is process-global in bun:test, so both mocks below spread
 * the real module's exports and only override the specific functions the
 * source file (agent-process-tracker.ts) actually calls, keeping every other
 * export intact for any other module that happens to load in this process.
 *
 * NOTE: agent-process-tracker.ts branches on process.platform === 'win32' for
 * isProcessAlive/isListeningOnBackendPort/cleanupZombieProcesses/
 * killProcessTreeSafely, and every mock above (tasklist/netstat/taskkill/
 * PowerShell snapshot output) is shaped for the win32 branch only. Without
 * pinning process.platform, this file passes locally (Windows dev machine)
 * but on Linux CI it silently falls through to the POSIX branch — a REAL,
 * unmocked process.kill(pid, 0/'SIGKILL') against test PIDs like 1000/2300 —
 * which is both wrong (bypasses every mock) and unsafe (task #869).
 */
import { describe, test, expect, mock, beforeEach, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import * as realFs from 'fs';
import * as realChildProcess from 'child_process';

const existsSyncMock = mock((_path: string) => false);
const mkdirSyncMock = mock((_path: string, _opts?: unknown): string | undefined => undefined);
const writeFileSyncMock = mock((_path: string, _data: string, _enc?: string): void => undefined);
const unlinkSyncMock = mock((_path: string): void => undefined);
const readdirSyncMock = mock((_path: string): string[] => []);
const readFileSyncMock = mock((_path: string, _enc?: string): string => '');

mock.module('fs', () => ({
  ...realFs,
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  unlinkSync: unlinkSyncMock,
  readdirSync: readdirSyncMock,
  readFileSync: readFileSyncMock,
}));

/** Result script for a mocked exec command: a literal stdout string, or an Error to throw (simulates a non-zero exit). */
type ExecOutcome = string | Error;

let tasklistOutcome: ExecOutcome = 'INFO: No tasks are running which match the specified criteria.';
let netstatOutcome: ExecOutcome = new Error('findstr: no match (exit 1)');
let taskkillOutcome: ExecOutcome = '';
// Empty JSON array = "snapshot enumeration returned nothing" — descendants/orphan
// sweep finds no extra targets, keeping the legacy single-pid expectations valid.
let snapshotOutcome: ExecOutcome = '[]';

function resolveExecOutcome(outcome: ExecOutcome): string {
  if (outcome instanceof Error) throw outcome;
  return outcome;
}

const execSyncMock = mock((command: string, _opts?: unknown): string => {
  if (command.startsWith('tasklist')) return resolveExecOutcome(tasklistOutcome);
  if (command.startsWith('netstat')) return resolveExecOutcome(netstatOutcome);
  if (command.startsWith('taskkill')) return resolveExecOutcome(taskkillOutcome);
  if (command.startsWith('powershell')) return resolveExecOutcome(snapshotOutcome);
  throw new Error(`unexpected exec command in test: ${command}`);
});

mock.module('child_process', () => ({
  ...realChildProcess,
  execSync: execSyncMock,
}));

const infoMock = mock((..._args: unknown[]) => {});
const warnMock = mock((..._args: unknown[]) => {});
const errorMock = mock((..._args: unknown[]) => {});
const debugMock = mock((..._args: unknown[]) => {});

mock.module('../../config/logger', () => ({
  createLogger: () => ({ info: infoMock, warn: warnMock, error: errorMock, debug: debugMock }),
  logger: { info: infoMock, warn: warnMock, error: errorMock, debug: debugMock },
  getBackendLogFilePath: () => '/fake/backend.log',
}));

const {
  registerProcess,
  unregisterProcess,
  countLiveTrackedProcesses,
  cleanupZombieProcesses,
  killProcessTreeSafely,
  clearAllPidFiles,
} = await import('./agent-process-tracker');

const PID_DIR = join(process.cwd(), '.agent-pids');

const originalPlatform = process.platform;

beforeAll(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

/** Marks a PID as alive to tasklist and NOT listening on port 3001 — the "normal zombie" shape. */
function makePidAliveNotListening(pid: number): void {
  tasklistOutcome = `Image Name  PID Session Name\nnode.exe    ${pid} Console`;
  netstatOutcome = new Error('findstr: no match (exit 1)');
}

function makePidAliveAndListening(pid: number): void {
  tasklistOutcome = `Image Name  PID Session Name\nnode.exe    ${pid} Console`;
  netstatOutcome = `  TCP    0.0.0.0:3001   0.0.0.0:0   LISTENING   ${pid}`;
}

function makePidDead(): void {
  tasklistOutcome = 'INFO: No tasks are running which match the specified criteria.';
}

beforeEach(() => {
  existsSyncMock.mockClear();
  mkdirSyncMock.mockClear();
  writeFileSyncMock.mockClear();
  unlinkSyncMock.mockClear();
  readdirSyncMock.mockClear();
  readFileSyncMock.mockClear();
  execSyncMock.mockClear();
  infoMock.mockClear();
  warnMock.mockClear();
  errorMock.mockClear();
  debugMock.mockClear();

  existsSyncMock.mockImplementation(() => false);
  mkdirSyncMock.mockImplementation(() => undefined);
  writeFileSyncMock.mockImplementation(() => undefined);
  unlinkSyncMock.mockImplementation(() => undefined);
  readdirSyncMock.mockImplementation(() => []);
  readFileSyncMock.mockImplementation(() => '');

  tasklistOutcome = 'INFO: No tasks are running which match the specified criteria.';
  netstatOutcome = new Error('findstr: no match (exit 1)');
  taskkillOutcome = '';
  snapshotOutcome = '[]';
});

describe('countLiveTrackedProcesses', () => {
  test('returns 0 when the PID directory does not exist', () => {
    existsSyncMock.mockImplementation(() => false);
    expect(countLiveTrackedProcesses('cli-agent')).toBe(0);
  });

  test('counts live PIDs of the requested role only and removes dead-PID files', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => [
      'cli-agent-100.pid',
      'cli-agent-300.pid',
      'worker-200.pid',
    ]);
    readFileSyncMock.mockImplementation((path: string) =>
      String(path).includes('cli-agent-100')
        ? JSON.stringify({ pid: 100, role: 'cli-agent', startedAt: 't', parentPid: 1 })
        : JSON.stringify({ pid: 300, role: 'cli-agent', startedAt: 't', parentPid: 1 }),
    );
    makePidAliveNotListening(100); // tasklist output names 100 only → 300 reads as dead
    expect(countLiveTrackedProcesses('cli-agent')).toBe(1);
    // The dead 300 file self-heals (removed) so it can never pin the count.
    expect(unlinkSyncMock).toHaveBeenCalledWith(join(PID_DIR, 'cli-agent-300.pid'));
    expect(unlinkSyncMock).toHaveBeenCalledTimes(1);
  });

  test('removes unparsable PID files without counting them', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => ['cli-agent-400.pid']);
    readFileSyncMock.mockImplementation(() => 'not json at all');
    expect(countLiveTrackedProcesses('cli-agent')).toBe(0);
    expect(unlinkSyncMock).toHaveBeenCalledWith(join(PID_DIR, 'cli-agent-400.pid'));
  });

  test('returns 0 (fail-open) and warns when the directory scan fails', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(countLiveTrackedProcesses('cli-agent')).toBe(0);
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});

describe('registerProcess', () => {
  test('creates the PID directory when it does not exist yet', () => {
    existsSyncMock.mockImplementation(() => false);
    registerProcess({ pid: 111, role: 'worker', startedAt: 't', parentPid: 1 });
    expect(mkdirSyncMock).toHaveBeenCalledWith(PID_DIR, { recursive: true });
  });

  test('skips directory creation when it already exists', () => {
    existsSyncMock.mockImplementation(() => true);
    registerProcess({ pid: 112, role: 'worker', startedAt: 't', parentPid: 1 });
    expect(mkdirSyncMock).not.toHaveBeenCalled();
  });

  test('writes a JSON PID file named <role>-<pid>.pid', () => {
    existsSyncMock.mockImplementation(() => true);
    const info = { pid: 222, role: 'cli-agent' as const, taskId: 5, startedAt: 't0', parentPid: 9 };
    registerProcess(info);
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      join(PID_DIR, 'cli-agent-222.pid'),
      JSON.stringify(info, null, 2),
      'utf-8',
    );
    expect(infoMock).toHaveBeenCalledTimes(1);
  });

  test('swallows a write failure and logs it instead of throwing', () => {
    existsSyncMock.mockImplementation(() => true);
    writeFileSyncMock.mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() =>
      registerProcess({ pid: 333, role: 'worker', startedAt: 't', parentPid: 1 }),
    ).not.toThrow();
    expect(errorMock).toHaveBeenCalledTimes(1);
  });
});

describe('unregisterProcess', () => {
  test('no-ops when the PID directory does not exist', () => {
    existsSyncMock.mockImplementation(() => false);
    unregisterProcess(1);
    expect(readdirSyncMock).not.toHaveBeenCalled();
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });

  test('removes the matching PID file and stops at the first match', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => ['worker-100.pid', 'cli-agent-200.pid']);
    unregisterProcess(100);
    expect(unlinkSyncMock).toHaveBeenCalledTimes(1);
    expect(unlinkSyncMock).toHaveBeenCalledWith(join(PID_DIR, 'worker-100.pid'));
    expect(infoMock).toHaveBeenCalledTimes(1);
  });

  test('does nothing when no file matches the pid', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => ['worker-999.pid']);
    unregisterProcess(100);
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });

  test('swallows errors while scanning and logs them', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(() => unregisterProcess(100)).not.toThrow();
    expect(errorMock).toHaveBeenCalledTimes(1);
  });
});

describe('cleanupZombieProcesses', () => {
  test('returns 0 when the PID directory does not exist', () => {
    existsSyncMock.mockImplementation(() => false);
    expect(cleanupZombieProcesses()).toBe(0);
  });

  test('returns 0 when there are no .pid files', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => ['readme.txt']);
    expect(cleanupZombieProcesses()).toBe(0);
  });

  test('removes an unparsable PID file and continues', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => ['broken.pid']);
    readFileSyncMock.mockImplementation(() => 'not json');
    expect(cleanupZombieProcesses()).toBe(0);
    expect(unlinkSyncMock).toHaveBeenCalledWith(join(PID_DIR, 'broken.pid'));
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  test('tolerates unlinkSync itself failing for a corrupt file', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => ['broken.pid']);
    readFileSyncMock.mockImplementation(() => 'not json');
    unlinkSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(() => cleanupZombieProcesses()).not.toThrow();
  });

  test('removes the PID file for a process that is no longer alive', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => ['worker-500.pid']);
    readFileSyncMock.mockImplementation(() =>
      JSON.stringify({ pid: 500, role: 'worker', startedAt: 't', parentPid: 1 }),
    );
    makePidDead();
    expect(cleanupZombieProcesses()).toBe(0);
    expect(unlinkSyncMock).toHaveBeenCalledWith(join(PID_DIR, 'worker-500.pid'));
    expect(execSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining('taskkill'),
      expect.anything(),
    );
  });

  test('protects a live process listening on port 3001 (never kills it)', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => ['worker-600.pid']);
    readFileSyncMock.mockImplementation(() =>
      JSON.stringify({ pid: 600, role: 'worker', startedAt: 't', parentPid: 1 }),
    );
    makePidAliveAndListening(600);
    expect(cleanupZombieProcesses()).toBe(0);
    expect(unlinkSyncMock).toHaveBeenCalledWith(join(PID_DIR, 'worker-600.pid'));
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  test('kills a live zombie process not on port 3001 and counts it', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => ['cli-agent-700.pid']);
    readFileSyncMock.mockImplementation(() =>
      JSON.stringify({ pid: 700, role: 'cli-agent', startedAt: 't', parentPid: 1 }),
    );
    makePidAliveNotListening(700);
    expect(cleanupZombieProcesses()).toBe(1);
    expect(unlinkSyncMock).toHaveBeenCalledWith(join(PID_DIR, 'cli-agent-700.pid'));
  });

  test('still removes the PID file even when the kill attempt itself fails', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => ['worker-800.pid']);
    readFileSyncMock.mockImplementation(() =>
      JSON.stringify({ pid: 800, role: 'worker', startedAt: 't', parentPid: 1 }),
    );
    makePidAliveNotListening(800);
    taskkillOutcome = new Error('access denied');
    expect(cleanupZombieProcesses()).toBe(0);
    expect(unlinkSyncMock).toHaveBeenCalledWith(join(PID_DIR, 'worker-800.pid'));
    expect(debugMock).toHaveBeenCalledTimes(1);
  });

  test('processes multiple PID files independently and sums kills', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => ['worker-900.pid', 'cli-agent-901.pid']);
    readFileSyncMock.mockImplementation((path: string) => {
      if (String(path).includes('900')) {
        return JSON.stringify({ pid: 900, role: 'worker', startedAt: 't', parentPid: 1 });
      }
      return JSON.stringify({ pid: 901, role: 'cli-agent', startedAt: 't', parentPid: 1 });
    });
    // Both PIDs are alive and not on port 3001 for every tasklist/netstat call in this test.
    tasklistOutcome = 'PID 900 901 both alive';
    netstatOutcome = new Error('no match');
    expect(cleanupZombieProcesses()).toBe(2);
  });

  test('propagates an unexpected top-level failure into the outer catch', () => {
    existsSyncMock.mockImplementation(() => {
      throw new Error('unexpected fs failure');
    });
    let result = -1;
    expect(() => {
      result = cleanupZombieProcesses();
    }).not.toThrow();
    expect(result).toBe(0);
    expect(errorMock).toHaveBeenCalled();
  });
});

describe('killProcessTreeSafely', () => {
  test('returns false without attempting a kill when the process is already gone', () => {
    makePidDead();
    expect(killProcessTreeSafely(1000)).toBe(false);
    // tasklist check + snapshot enumeration, but no taskkill
    expect(execSyncMock).toHaveBeenCalledTimes(2);
    expect(execSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining('taskkill'),
      expect.anything(),
    );
  });

  test('refuses to kill a process listening on port 3001', () => {
    makePidAliveAndListening(1001);
    expect(killProcessTreeSafely(1001)).toBe(false);
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(execSyncMock).not.toHaveBeenCalledWith(
      expect.stringContaining('taskkill'),
      expect.anything(),
    );
  });

  test('kills and reports success for a live process not on port 3001', () => {
    makePidAliveNotListening(1002);
    expect(killProcessTreeSafely(1002)).toBe(true);
    expect(infoMock).toHaveBeenCalledTimes(1);
  });

  test('returns false and logs debug when the kill call throws', () => {
    makePidAliveNotListening(1003);
    taskkillOutcome = new Error('process vanished mid-kill');
    expect(killProcessTreeSafely(1003)).toBe(false);
    expect(debugMock).toHaveBeenCalledTimes(1);
  });

  test('kills snapshot descendants even when an intermediate parent is dead', () => {
    makePidAliveNotListening(2000);
    // 2000 → 2001 (alive child); 2002's parent 9999 is NOT in the snapshot
    // (dead tauri-cli shape) but its command line references the worktree.
    snapshotOutcome = JSON.stringify([
      { ProcessId: 2001, ParentProcessId: 2000, CommandLine: 'pnpm dev' },
      {
        ProcessId: 2002,
        ParentProcessId: 9999,
        CommandLine:
          'node C:\\Projects\\fusen\\.worktrees\\task-533\\node_modules\\vite\\bin\\vite.js',
      },
    ]);
    expect(
      killProcessTreeSafely(2000, { workdir: 'C:\\Projects\\fusen\\.worktrees\\task-533' }),
    ).toBe(true);
    const killCall = execSyncMock.mock.calls.find(([cmd]) => String(cmd).startsWith('taskkill'));
    expect(String(killCall?.[0])).toContain('/PID 2000');
    expect(String(killCall?.[0])).toContain('/PID 2001');
    expect(String(killCall?.[0])).toContain('/PID 2002');
  });

  test('does not sweep by command line for a non-worktree workdir', () => {
    makePidAliveNotListening(2100);
    snapshotOutcome = JSON.stringify([
      { ProcessId: 2101, ParentProcessId: 9999, CommandLine: 'node C:\\Projects\\fusen\\vite.js' },
    ]);
    expect(killProcessTreeSafely(2100, { workdir: 'C:\\Projects\\fusen' })).toBe(true);
    const killCall = execSyncMock.mock.calls.find(([cmd]) => String(cmd).startsWith('taskkill'));
    expect(String(killCall?.[0])).toContain('/PID 2100');
    expect(String(killCall?.[0])).not.toContain('/PID 2101');
  });

  test('sweeps worktree orphans even when the root process is already gone', () => {
    makePidDead();
    snapshotOutcome = JSON.stringify([
      {
        ProcessId: 2201,
        ParentProcessId: 9999,
        CommandLine: 'node C:\\Projects\\fusen\\.worktrees\\task-533\\vite.js',
      },
    ]);
    expect(
      killProcessTreeSafely(2200, { workdir: 'C:\\Projects\\fusen\\.worktrees\\task-533' }),
    ).toBe(true);
    const killCall = execSyncMock.mock.calls.find(([cmd]) => String(cmd).startsWith('taskkill'));
    expect(String(killCall?.[0])).toContain('/PID 2201');
    expect(String(killCall?.[0])).not.toContain('/PID 2200');
  });

  test('drops a port-3001 listener from the target set but kills the rest', () => {
    tasklistOutcome = 'node.exe 2300 Console';
    // netstat marks descendant 2301 as the backend listener; 2300 must die alone.
    netstatOutcome = `  TCP    127.0.0.1:3001   0.0.0.0:0   LISTENING   2301`;
    snapshotOutcome = JSON.stringify([
      { ProcessId: 2301, ParentProcessId: 2300, CommandLine: 'bun index.ts' },
    ]);
    expect(killProcessTreeSafely(2300)).toBe(true);
    expect(warnMock).toHaveBeenCalledTimes(1);
    const killCall = execSyncMock.mock.calls.find(([cmd]) => String(cmd).startsWith('taskkill'));
    expect(String(killCall?.[0])).toContain('/PID 2300');
    expect(String(killCall?.[0])).not.toContain('/PID 2301');
  });
});

describe('clearAllPidFiles', () => {
  test('no-ops when the PID directory does not exist', () => {
    existsSyncMock.mockImplementation(() => false);
    expect(() => clearAllPidFiles()).not.toThrow();
    expect(readdirSyncMock).not.toHaveBeenCalled();
  });

  test('deletes every .pid file and ignores non-.pid files', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => ['a.pid', 'b.pid', 'notes.txt']);
    clearAllPidFiles();
    expect(unlinkSyncMock).toHaveBeenCalledTimes(2);
    expect(unlinkSyncMock).toHaveBeenCalledWith(join(PID_DIR, 'a.pid'));
    expect(unlinkSyncMock).toHaveBeenCalledWith(join(PID_DIR, 'b.pid'));
    expect(infoMock).toHaveBeenCalledTimes(1);
  });

  test('does not log a summary when there are no .pid files to clear', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => ['notes.txt']);
    clearAllPidFiles();
    expect(infoMock).not.toHaveBeenCalled();
  });

  test('continues past an individual unlink failure', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => ['a.pid', 'b.pid']);
    let calls = 0;
    unlinkSyncMock.mockImplementation(() => {
      calls++;
      if (calls === 1) throw new Error('locked');
    });
    expect(() => clearAllPidFiles()).not.toThrow();
    expect(unlinkSyncMock).toHaveBeenCalledTimes(2);
  });

  test('swallows a directory-scan failure via the outer catch', () => {
    existsSyncMock.mockImplementation(() => true);
    readdirSyncMock.mockImplementation(() => {
      throw new Error('EACCES');
    });
    expect(() => clearAllPidFiles()).not.toThrow();
    expect(errorMock).toHaveBeenCalledTimes(1);
  });
});
