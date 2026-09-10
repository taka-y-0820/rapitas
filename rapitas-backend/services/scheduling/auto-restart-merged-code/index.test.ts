/**
 * index.test (AutoRestartMergedCodeScheduler)
 *
 * Drives runOnce() with every dependency mocked and asserts the exact call
 * order on the success path (fetch → classify → decide → clean-check →
 * ff-merge → final idle recheck → notification → rate-limit stamp → shutdown
 * sequence), plus every early-exit gate — and the task-boundary path
 * (evaluateBoundaryRestart) with its wait / defer / forced-restart branches.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const callOrder: string[] = [];

// ── Swappable behaviours ─────────────────────────────────────────────────────
let enabled = true;
let aheadCount: number | null = 3;
// Machinery path by default so the legacy success-path expectations still fire.
let changedPaths: string[] = ['rapitas-backend/services/workflow/workflow-runner.ts'];
let clean = true;
let ffOk = true;
let snapshots: Array<{
  activeExecutionsDegraded?: boolean;
  isShuttingDown: boolean;
  activeExecutions: number;
  runningExecutions: number;
  queueDepth: number;
}> = [];
let snapshotIndex = 0;
let lastRestartAt = 0;
let deferCount = 0;
let auxChildren = 0;
let isMergingFlag = false;
let notificationFails = false;

const idleSnapshot = {
  isShuttingDown: false,
  activeExecutions: 0,
  runningExecutions: 0,
  queueDepth: 0,
};

// ── Module mocks (before importing the scheduler) ────────────────────────────
mock.module('./git-io', () => ({
  captureStartupCommit: () => {
    callOrder.push('captureStartupCommit');
    return Promise.resolve('startup123');
  },
  fetchAndCountAhead: (startupCommit: string, branch: string) => {
    callOrder.push(`fetchAndCountAhead:${startupCommit}:${branch}`);
    return Promise.resolve(aheadCount);
  },
  isWorkingTreeClean: () => {
    callOrder.push('isWorkingTreeClean');
    return Promise.resolve(clean);
  },
  fastForwardToRemote: (branch: string) => {
    callOrder.push(`fastForwardToRemote:${branch}`);
    return Promise.resolve(ffOk);
  },
  listChangedPaths: (startupCommit: string, branch: string) => {
    callOrder.push(`listChangedPaths:${startupCommit}:${branch}`);
    return Promise.resolve(changedPaths);
  },
}));

mock.module('./settings-store', () => ({
  readAutoRestartEnabled: () => {
    callOrder.push('readAutoRestartEnabled');
    return enabled;
  },
  writeAutoRestartEnabled: () => {},
  readLastRestartAt: () => lastRestartAt,
  writeLastRestartAt: (_ts: number) => {
    callOrder.push('writeLastRestartAt');
  },
  readDeferCount: () => deferCount,
  writeDeferCount: (count: number) => {
    callOrder.push(`writeDeferCount:${count}`);
    deferCount = count;
  },
}));

mock.module('../../agents/agent-process-tracker', () => ({
  countLiveTrackedProcesses: (_role: string) => auxChildren,
}));

mock.module('../../workflow/auto-merge-watcher', () => ({
  AutoMergeWatcher: {
    getInstance: () => ({ isMerging: () => isMergingFlag }),
  },
}));

mock.module('../../system/shutdown-sequence', () => ({
  scheduleShutdownSequence: (prefix: string, exitCode: number) => {
    callOrder.push(`scheduleShutdownSequence:${prefix}:${exitCode}`);
  },
}));

mock.module('../../communication/notification-service', () => ({
  createNotification: (params: { type: string; title: string; message: string }) => {
    callOrder.push(`createNotification:${params.type}`);
    return notificationFails
      ? Promise.reject(new Error('notification down'))
      : Promise.resolve({ id: 1 });
  },
}));

mock.module('../../../routes/agents/system/agent-system-router', () => ({
  getAgentSystemSnapshot: () => {
    callOrder.push('getAgentSystemSnapshot');
    const snap = snapshots[snapshotIndex] ?? idleSnapshot;
    snapshotIndex += 1;
    return Promise.resolve({
      status: 'healthy',
      interruptedExecutions: 0,
      activePreviewCount: 0,
      serverTime: new Date().toISOString(),
      ...snap,
    });
  },
}));

mock.module('../../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const { AutoRestartMergedCodeScheduler } = await import('./index');
const { resetUiActivity, recordUiRequest } = await import('./ui-activity-tracker');

/** Fresh scheduler with the private startupCommit primed (runOnce is driven directly). */
function makeScheduler(startupCommit: string | null = 'startup123'): {
  runOnce(): Promise<boolean>;
  evaluateBoundaryRestart(): Promise<boolean>;
} {
  const scheduler = new AutoRestartMergedCodeScheduler();
  (scheduler as unknown as { startupCommit: string | null }).startupCommit = startupCommit;
  return scheduler;
}

beforeEach(() => {
  callOrder.length = 0;
  enabled = true;
  aheadCount = 3;
  changedPaths = ['rapitas-backend/services/workflow/workflow-runner.ts'];
  clean = true;
  ffOk = true;
  snapshots = [idleSnapshot, idleSnapshot];
  snapshotIndex = 0;
  lastRestartAt = 0;
  deferCount = 0;
  auxChildren = 0;
  isMergingFlag = false;
  notificationFails = false;
  resetUiActivity();
  delete process.env.RAPITAS_PRIMARY_BRANCH;
});

describe('runOnce — success path', () => {
  test('runs fetch → snapshot → clean → ff → recheck → notify → stamp → shutdown in order', async () => {
    const fired = await makeScheduler().runOnce();
    expect(fired).toBe(true);
    expect(callOrder).toEqual([
      'readAutoRestartEnabled',
      'fetchAndCountAhead:startup123:develop',
      'listChangedPaths:startup123:develop',
      'getAgentSystemSnapshot',
      'isWorkingTreeClean',
      'fastForwardToRemote:develop',
      'getAgentSystemSnapshot',
      'createNotification:system',
      'writeLastRestartAt',
      'scheduleShutdownSequence:[auto-restart]:75',
    ]);
  });

  test('honours RAPITAS_PRIMARY_BRANCH for fetch and merge', async () => {
    process.env.RAPITAS_PRIMARY_BRANCH = 'main';
    await makeScheduler().runOnce();
    expect(callOrder).toContain('fetchAndCountAhead:startup123:main');
    expect(callOrder).toContain('fastForwardToRemote:main');
  });
});

describe('runOnce — early-exit gates', () => {
  test('toggle off: no git I/O at all', async () => {
    enabled = false;
    expect(await makeScheduler().runOnce()).toBe(false);
    expect(callOrder).toEqual(['readAutoRestartEnabled']);
  });

  test('missing startup commit: stops before fetch', async () => {
    expect(await makeScheduler(null).runOnce()).toBe(false);
    expect(callOrder).toEqual(['readAutoRestartEnabled']);
  });

  test('fetch failure (null): stops before snapshot', async () => {
    aheadCount = null;
    expect(await makeScheduler().runOnce()).toBe(false);
    expect(callOrder.some((c) => c === 'getAgentSystemSnapshot')).toBe(false);
  });

  test('aheadCount 0: stops before snapshot', async () => {
    aheadCount = 0;
    expect(await makeScheduler().runOnce()).toBe(false);
    expect(callOrder.some((c) => c === 'getAgentSystemSnapshot')).toBe(false);
  });

  test('UI-only merge: batched to the boundary — no snapshot, no pull, no restart', async () => {
    changedPaths = [
      'rapitas-frontend/src/components/task-card/task-card.tsx',
      'rapitas-frontend/src/app/page.tsx',
    ];
    expect(await makeScheduler().runOnce()).toBe(false);
    expect(callOrder.some((c) => c.startsWith('listChangedPaths'))).toBe(true);
    expect(callOrder.some((c) => c === 'getAgentSystemSnapshot')).toBe(false);
    expect(callOrder.some((c) => c.startsWith('fastForwardToRemote'))).toBe(false);
    expect(callOrder.some((c) => c.startsWith('scheduleShutdownSequence'))).toBe(false);
  });

  test('unknown change set ([]): batched to the boundary (safe side)', async () => {
    changedPaths = [];
    expect(await makeScheduler().runOnce()).toBe(false);
    expect(callOrder.some((c) => c.startsWith('scheduleShutdownSequence'))).toBe(false);
  });

  test('machinery merge: fires immediately (classification passes)', async () => {
    changedPaths = ['rapitas-frontend/src/app/page.tsx', 'rapitas-desktop/scripts/dev.js'];
    expect(await makeScheduler().runOnce()).toBe(true);
    expect(callOrder).toContain('scheduleShutdownSequence:[auto-restart]:75');
  });

  test('busy system (decision gate): no pull, no restart', async () => {
    snapshots = [{ ...idleSnapshot, activeExecutions: 1 }];
    expect(await makeScheduler().runOnce()).toBe(false);
    expect(callOrder.some((c) => c === 'isWorkingTreeClean')).toBe(false);
    expect(callOrder.some((c) => c.startsWith('fastForwardToRemote'))).toBe(false);
  });

  test('rate-limited: no pull, no restart', async () => {
    lastRestartAt = Date.now() - 60_000; // 1 min ago < 30 min floor
    expect(await makeScheduler().runOnce()).toBe(false);
    expect(callOrder.some((c) => c === 'isWorkingTreeClean')).toBe(false);
  });

  test('dirty tree: no ff-merge, no notification', async () => {
    clean = false;
    expect(await makeScheduler().runOnce()).toBe(false);
    expect(callOrder.some((c) => c.startsWith('fastForwardToRemote'))).toBe(false);
    expect(callOrder.some((c) => c.startsWith('createNotification'))).toBe(false);
  });

  test('ff-merge failure: no notification, no shutdown', async () => {
    ffOk = false;
    expect(await makeScheduler().runOnce()).toBe(false);
    expect(callOrder.some((c) => c.startsWith('createNotification'))).toBe(false);
    expect(callOrder.some((c) => c.startsWith('scheduleShutdownSequence'))).toBe(false);
  });

  test('busy at final recheck: pull happened but restart deferred (no notification/stamp/shutdown)', async () => {
    snapshots = [idleSnapshot, { ...idleSnapshot, runningExecutions: 1 }];
    expect(await makeScheduler().runOnce()).toBe(false);
    expect(callOrder.some((c) => c.startsWith('fastForwardToRemote'))).toBe(true);
    expect(callOrder.some((c) => c.startsWith('createNotification'))).toBe(false);
    expect(callOrder.some((c) => c === 'writeLastRestartAt')).toBe(false);
    expect(callOrder.some((c) => c.startsWith('scheduleShutdownSequence'))).toBe(false);
  });

  test('isShuttingDown at final recheck: restart deferred (dual-path guard)', async () => {
    snapshots = [idleSnapshot, { ...idleSnapshot, isShuttingDown: true }];
    expect(await makeScheduler().runOnce()).toBe(false);
    expect(callOrder.some((c) => c.startsWith('scheduleShutdownSequence'))).toBe(false);
  });

  test('notification failure does not block the restart', async () => {
    notificationFails = true;
    expect(await makeScheduler().runOnce()).toBe(true);
    expect(callOrder.some((c) => c.startsWith('scheduleShutdownSequence'))).toBe(true);
  });
});

describe('evaluateBoundaryRestart — task-boundary path', () => {
  test('all quiet: clean → ff → notify → stamp → deferCount reset → boundary shutdown', async () => {
    changedPaths = ['rapitas-frontend/src/app/page.tsx']; // batched merges DO fire at the boundary
    expect(await makeScheduler().evaluateBoundaryRestart()).toBe(true);
    expect(callOrder).toEqual([
      'readAutoRestartEnabled',
      'fetchAndCountAhead:startup123:develop',
      'getAgentSystemSnapshot',
      'isWorkingTreeClean',
      'fastForwardToRemote:develop',
      'getAgentSystemSnapshot',
      'createNotification:system',
      'writeLastRestartAt',
      'writeDeferCount:0',
      'scheduleShutdownSequence:[auto-restart-boundary]:75',
    ]);
  });

  test('toggle off: nothing but the toggle read', async () => {
    enabled = false;
    expect(await makeScheduler().evaluateBoundaryRestart()).toBe(false);
    expect(callOrder).toEqual(['readAutoRestartEnabled']);
  });

  test('missing startup commit (scheduler never started): no-op', async () => {
    expect(await makeScheduler(null).evaluateBoundaryRestart()).toBe(false);
    expect(callOrder).toEqual(['readAutoRestartEnabled']);
  });

  test('no unactivated commits: stops before the snapshot', async () => {
    aheadCount = 0;
    expect(await makeScheduler().evaluateBoundaryRestart()).toBe(false);
    expect(callOrder.some((c) => c === 'getAgentSystemSnapshot')).toBe(false);
  });

  test('live aux CLI children: wait — no defer increment, no shutdown', async () => {
    auxChildren = 1;
    expect(await makeScheduler().evaluateBoundaryRestart()).toBe(false);
    expect(callOrder.some((c) => c.startsWith('writeDeferCount'))).toBe(false);
    expect(callOrder.some((c) => c.startsWith('scheduleShutdownSequence'))).toBe(false);
  });

  test('auto-merge tick in flight: wait', async () => {
    isMergingFlag = true;
    expect(await makeScheduler().evaluateBoundaryRestart()).toBe(false);
    expect(callOrder.some((c) => c.startsWith('scheduleShutdownSequence'))).toBe(false);
  });

  test('rate-limited (within the 10-min boundary floor): wait', async () => {
    lastRestartAt = Date.now() - 60_000;
    expect(await makeScheduler().evaluateBoundaryRestart()).toBe(false);
    expect(callOrder.some((c) => c.startsWith('scheduleShutdownSequence'))).toBe(false);
  });

  test('UI active: defer — count persisted, no pull, no shutdown', async () => {
    recordUiRequest(Date.now());
    expect(await makeScheduler().evaluateBoundaryRestart()).toBe(false);
    expect(callOrder).toContain('writeDeferCount:1');
    expect(callOrder.some((c) => c === 'isWorkingTreeClean')).toBe(false);
    expect(callOrder.some((c) => c.startsWith('scheduleShutdownSequence'))).toBe(false);
  });

  test('UI active at the deferral ceiling: forced restart with count reset', async () => {
    recordUiRequest(Date.now());
    deferCount = 5; // default RAPITAS_RESTART_MAX_DEFERRALS
    expect(await makeScheduler().evaluateBoundaryRestart()).toBe(true);
    expect(callOrder).toContain('writeDeferCount:0');
    expect(callOrder).toContain('scheduleShutdownSequence:[auto-restart-boundary]:75');
  });

  test('dirty tree at restart: skipped — stamps and shutdown never happen', async () => {
    clean = false;
    expect(await makeScheduler().evaluateBoundaryRestart()).toBe(false);
    expect(callOrder.some((c) => c === 'writeLastRestartAt')).toBe(false);
    expect(callOrder.some((c) => c.startsWith('scheduleShutdownSequence'))).toBe(false);
  });

  test('ff failure at restart: no notification, no shutdown', async () => {
    ffOk = false;
    expect(await makeScheduler().evaluateBoundaryRestart()).toBe(false);
    expect(callOrder.some((c) => c.startsWith('createNotification'))).toBe(false);
    expect(callOrder.some((c) => c.startsWith('scheduleShutdownSequence'))).toBe(false);
  });

  test('busy snapshot (running executions): wait', async () => {
    snapshots = [{ ...idleSnapshot, runningExecutions: 1 }];
    expect(await makeScheduler().evaluateBoundaryRestart()).toBe(false);
    expect(callOrder.some((c) => c.startsWith('scheduleShutdownSequence'))).toBe(false);
  });
});

describe('start() guards', () => {
  test('does nothing when TAURI_BUILD != true', async () => {
    const originalTauri = process.env.TAURI_BUILD;
    delete process.env.TAURI_BUILD;
    const scheduler = new AutoRestartMergedCodeScheduler();
    await scheduler.start(60_000);
    expect(scheduler.getIsRunning()).toBe(false);
    expect(callOrder.some((c) => c === 'captureStartupCommit')).toBe(false);
    if (originalTauri !== undefined) process.env.TAURI_BUILD = originalTauri;
  });

  test('starts and stops under TAURI_BUILD=true', async () => {
    const originalTauri = process.env.TAURI_BUILD;
    process.env.TAURI_BUILD = 'true';
    enabled = false; // keep the immediate runOnce a no-op
    const scheduler = new AutoRestartMergedCodeScheduler();
    await scheduler.start(60 * 60 * 1000);
    expect(scheduler.getIsRunning()).toBe(true);
    expect(callOrder).toContain('captureStartupCommit');
    scheduler.stop();
    expect(scheduler.getIsRunning()).toBe(false);
    if (originalTauri === undefined) delete process.env.TAURI_BUILD;
    else process.env.TAURI_BUILD = originalTauri;
  });
});

for (const mode of ['poll', 'boundary'] as const) {
  for (const stage of ['initial', 'final'] as const) {
    test(`${mode} restart refuses unknown ownership at ${stage} observation`, async () => {
      const unknown = { ...idleSnapshot, activeExecutionsDegraded: true };
      snapshots = stage === 'initial' ? [unknown] : [idleSnapshot, unknown];
      const scheduler = makeScheduler();
      const result =
        mode === 'poll' ? await scheduler.runOnce() : await scheduler.evaluateBoundaryRestart();
      expect(result).toBe(false);
      expect(callOrder.some((c) => c.startsWith('scheduleShutdownSequence'))).toBe(false);
      expect(callOrder.some((c) => c.startsWith('createNotification'))).toBe(false);
    });
  }
}

for (const field of ['activeExecutions', 'runningExecutions', 'queueDepth'] as const) {
  test(`boundary rechecks ${field} after pull before shutdown`, async () => {
    snapshots = [idleSnapshot, { ...idleSnapshot, [field]: 1 }];
    expect(await makeScheduler().evaluateBoundaryRestart()).toBe(false);
    expect(callOrder.some((c) => c.startsWith('scheduleShutdownSequence'))).toBe(false);
  });
}
