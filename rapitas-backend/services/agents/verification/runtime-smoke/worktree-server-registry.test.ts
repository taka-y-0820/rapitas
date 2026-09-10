import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let rows: any[] = [];
let storeFailed = false;
let spawnCount = 0;
let birth = '100';
let ready: () => Promise<boolean> = async () => true;
let stopCount = 0;
let stopped = true;
let listenerOccupied = true;
let rootPresent = true;
let snapshotFailed = false;
let allocate: () => Promise<number> = async () => 45678;
let healthUrl: string | undefined;
let extraProcesses: Array<{ pid: number; parentPid: number; birth: string; command: string }> = [];
const originalFetch = globalThis.fetch;
const temporaryWorkdirs: string[] = [];
mock.module('./runtime-process-stop', () => ({
  stopRuntimeProcesses: async (identities: unknown[]) => {
    stopCount++;
    if (stopped) listenerOccupied = false;
    return { stopped, identities, reason: stopped ? undefined : 'exit-not-confirmed' };
  },
}));
mock.module('./runtime-registry-store', () => ({
  RuntimeRegistryStore: class {
    async read() {
      if (storeFailed) throw new Error('corrupt snapshot');
      return rows;
    }
    async update(change: (rows: any[]) => any[]) {
      if (storeFailed) throw new Error('disk failure');
      rows = change(rows);
    }
  },
}));
mock.module('./runtime-process-snapshot', () => ({
  ownsRuntimePort: () => listenerOccupied,
  readRuntimeProcessSnapshot: async () => {
    if (snapshotFailed) throw new Error('snapshot timeout');
    return {
      processes: [
        ...(rootPresent ? [{ pid: 123, parentPid: 1, birth, command: 'owned' }] : []),
        ...extraProcesses,
      ],
      protectedPids: new Set(),
      listeners: listenerOccupied ? [{ port: 45678, pid: 123 }] : [],
    };
  },
}));
mock.module('./runtime-config', () => ({
  substitutePort: (s: string, p: number) => s.replaceAll('{port}', String(p)),
}));
mock.module('./app-launcher', () => ({
  allocateFreePort: () => allocate(),
  launchApp: () => {
    spawnCount++;
    return { pid: 123, logs: () => [], hasExited: () => false, exitCode: () => null };
  },
  waitForHealthy: (url: string) => {
    healthUrl = url;
    return ready();
  },
}));
const {
  acquireRuntimeServer,
  releaseRuntimeServer,
  recoverRuntimeServerRegistry,
  normalizeWorkdirKey,
  _resetForTests,
  _debugSnapshotForTests,
} = await import('./worktree-server-registry');
const cfg = {
  start: 'server {port}',
  url: 'http://127.0.0.1:{port}',
  healthPath: '/',
  readyTimeoutMs: 100,
  checkPaths: ['/'],
};
const { registry } = await import('./runtime-server-registry-types');
const { stopOwnedAndVerify } = await import('./runtime-server-registry-lifecycle');

async function quarantineAfterUnconfirmedStop() {
  const acquired = await acquireRuntimeServer(process.cwd(), cfg);
  if (!acquired.ok) throw new Error('Initial acquisition failed');
  releaseRuntimeServer(acquired.lease);
  const entry = registry.get(normalizeWorkdirKey(process.cwd())!)!;
  stopped = false;
  await stopOwnedAndVerify(entry, 'test-timeout');
  expect(entry.state).toBe('quarantined');
}

test('missing npm script releases the reservation without spawning and permits a corrected retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-preflight-'));
  temporaryWorkdirs.push(dir);
  await mkdir(join(dir, 'rapitas-frontend'));
  const manifest = join(dir, 'rapitas-frontend', 'package.json');
  await writeFile(manifest, JSON.stringify({ scripts: {} }));
  const config = { ...cfg, start: 'cd rapitas-frontend && npm run dev:runtime -- -p {port}' };
  const rejected = await acquireRuntimeServer(dir, config);
  expect(rejected.ok).toBe(false);
  expect(JSON.stringify(rejected)).toContain('missing script');
  expect(spawnCount).toBe(0);
  expect(rows).toHaveLength(0);
  expect(_debugSnapshotForTests()).toHaveLength(0);
  await writeFile(manifest, JSON.stringify({ scripts: { 'dev:runtime': 'next dev' } }));
  expect((await acquireRuntimeServer(dir, config)).ok).toBe(true);
  expect(spawnCount).toBe(1);
});

test('fresh exit proof clears a transient quarantine and concurrent borrowers share one new server', async () => {
  await quarantineAfterUnconfirmedStop();
  rootPresent = false;
  listenerOccupied = false;
  allocate = async () => {
    rootPresent = true;
    listenerOccupied = true;
    return 45678;
  };
  const results = await Promise.all([
    acquireRuntimeServer(process.cwd(), cfg),
    acquireRuntimeServer(process.cwd(), cfg),
  ]);
  expect(results.every((result) => result.ok)).toBe(true);
  expect(spawnCount).toBe(2);
  expect(stopCount).toBe(1);
  expect(_debugSnapshotForTests()[0].leases).toBe(2);
});

test.each(['alive', 'port', 'reused', 'persistence', 'snapshot'])(
  'quarantine recovery stays closed with %s evidence',
  async (condition) => {
    await quarantineAfterUnconfirmedStop();
    if (condition === 'port') rootPresent = false;
    if (condition === 'reused') birth = '200';
    if (condition === 'snapshot') snapshotFailed = true;
    if (condition === 'persistence') {
      rootPresent = false;
      listenerOccupied = false;
      storeFailed = true;
    }
    expect((await acquireRuntimeServer(process.cwd(), cfg)).ok).toBe(false);
    expect(_debugSnapshotForTests()[0].state).toBe('quarantined');
    expect(spawnCount).toBe(1);
    expect(stopCount).toBe(1);
  },
);
beforeEach(() => {
  _resetForTests();
  rows = [];
  storeFailed = false;
  spawnCount = 0;
  birth = '100';
  ready = async () => true;
  stopCount = 0;
  stopped = true;
  listenerOccupied = true;
  extraProcesses = [];
  rootPresent = true;
  snapshotFailed = false;
  allocate = async () => 45678;
  healthUrl = undefined;
  globalThis.fetch = (async () => new Response('ok')) as typeof fetch;
});
afterEach(async () => {
  _resetForTests();
  globalThis.fetch = originalFetch;
  for (const dir of temporaryWorkdirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test('different workdirs acquire independently on distinct ports and retain separate leases', async () => {
  const aDir = await mkdtemp(join(tmpdir(), 'runtime-workdir-a-'));
  const bDir = await mkdtemp(join(tmpdir(), 'runtime-workdir-b-'));
  temporaryWorkdirs.push(aDir, bDir);
  let port = 45678;
  allocate = async () => port++;
  const [a, b] = await Promise.all([
    acquireRuntimeServer(aDir, cfg),
    acquireRuntimeServer(bDir, cfg),
  ]);
  expect(a.ok && b.ok).toBe(true);
  if (!a.ok || !b.ok) throw new Error('acquisition failed');
  expect(a.port).not.toBe(b.port);
  expect(spawnCount).toBe(2);
  releaseRuntimeServer(a.lease);
  const bState = _debugSnapshotForTests().find((entry) => entry.key === normalizeWorkdirKey(bDir));
  expect(bState?.leases).toBe(1);
  expect(bState?.state).toBe('active');
  expect(stopCount).toBe(0);
});

function persistedServer() {
  return {
    key: normalizeWorkdirKey(process.cwd()),
    workdir: process.cwd(),
    state: 'active',
    configFingerprint: `${cfg.start}\u0000${cfg.url}\u0000${cfg.healthPath}`,
    port: 45678,
    baseUrl: 'http://127.0.0.1:45678',
    pid: 123,
    startedAt: new Date().toISOString(),
    identities: [{ pid: 123, parentPid: 1, birth: '100', command: 'owned' }],
  };
}

test('restart reuses a proven healthy server and persists discovered children', async () => {
  rows = [persistedServer()];
  extraProcesses = [{ pid: 124, parentPid: 123, birth: '101', command: 'child' }];
  expect((await acquireRuntimeServer(process.cwd(), cfg)).ok).toBe(true);
  expect(spawnCount).toBe(0);
  expect(stopCount).toBe(0);
  expect(rows[0].identities.map((p: { pid: number }) => p.pid)).toEqual([123, 124]);
});

test('restart removes a record only after identified processes and port are absent', async () => {
  rows = [persistedServer()];
  rootPresent = false;
  listenerOccupied = false;
  await recoverRuntimeServerRegistry();
  expect(_debugSnapshotForTests()).toEqual([]);
  expect(rows).toEqual([]);
  expect(spawnCount).toBe(0);
});

test('restart preserves unknown ownership without spawning or stopping anything', async () => {
  rows = [{ ...persistedServer(), identities: undefined, state: 'starting' }];
  expect((await acquireRuntimeServer(process.cwd(), cfg)).ok).toBe(false);
  expect(_debugSnapshotForTests()[0].state).toBe('quarantined');
  expect(rows[0].state).toBe('quarantined');
  expect(spawnCount).toBe(0);
  expect(stopCount).toBe(0);
});

test('restart preserves reused PID ownership without signalling the new process', async () => {
  rows = [persistedServer()];
  birth = '200';
  expect((await acquireRuntimeServer(process.cwd(), cfg)).ok).toBe(false);
  expect(rows[0].state).toBe('quarantined');
  expect(stopCount).toBe(0);
  expect(spawnCount).toBe(0);
});

test('concurrent consumers share one spawn and receive separate leases on its actual port', async () => {
  const [a, b] = await Promise.all([
    acquireRuntimeServer(process.cwd(), cfg),
    acquireRuntimeServer(process.cwd(), cfg),
  ]);
  expect(a.ok && b.ok).toBe(true);
  if (!a.ok || !b.ok) throw new Error('acquire failed');
  expect(a.port).toBe(b.port);
  expect(a.lease).not.toBe(b.lease);
  expect(spawnCount).toBe(1);
  releaseRuntimeServer(a.lease);
  releaseRuntimeServer(a.lease);
  expect(_debugSnapshotForTests()[0].leases).toBe(1);
});

test('localhost is normalized before the initial health check', async () => {
  const result = await acquireRuntimeServer(process.cwd(), {
    ...cfg,
    url: 'http://localhost:{port}',
  });
  expect(result.ok).toBe(true);
  expect(healthUrl).toBe('http://127.0.0.1:45678/');
});

test('last cancellation during port allocation releases the reservation without spawning', async () => {
  let finish!: (port: number) => void;
  allocate = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const controller = new AbortController();
  const pending = acquireRuntimeServer(process.cwd(), cfg, { signal: controller.signal });
  for (let i = 0; i < 100 && !finish; i++) await new Promise((r) => setTimeout(r, 1));
  expect(finish).toBeDefined();
  controller.abort();
  expect((await pending).ok).toBe(false);
  finish(45678);
  for (let i = 0; i < 100 && _debugSnapshotForTests().length; i++)
    await new Promise((r) => setTimeout(r, 1));
  expect(spawnCount).toBe(0);
  expect(stopCount).toBe(0);
  expect(rows).toEqual([]);
  expect(_debugSnapshotForTests()).toEqual([]);
  allocate = async () => 45678;
  expect((await acquireRuntimeServer(process.cwd(), cfg)).ok).toBe(true);
});

test('corrupt persisted state prevents any spawn', async () => {
  storeFailed = true;
  expect((await acquireRuntimeServer(process.cwd(), cfg)).ok).toBe(false);
  expect(spawnCount).toBe(0);
});

test('PID reuse during reacquisition holds the workdir without a replacement spawn', async () => {
  expect((await acquireRuntimeServer(process.cwd(), cfg)).ok).toBe(true);
  birth = '200';
  expect((await acquireRuntimeServer(process.cwd(), cfg)).ok).toBe(false);
  expect(_debugSnapshotForTests()[0].state).toBe('quarantined');
  expect(spawnCount).toBe(1);
});

test('one cancelled consumer does not cancel the other shared startup', async () => {
  let finish!: (healthy: boolean) => void;
  ready = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const controller = new AbortController();
  const a = acquireRuntimeServer(process.cwd(), cfg, { signal: controller.signal });
  const b = acquireRuntimeServer(process.cwd(), cfg);
  for (let i = 0; i < 20 && !finish; i++) await new Promise((r) => setTimeout(r, 1));
  expect(finish).toBeDefined();
  controller.abort();
  expect((await a).ok).toBe(false);
  finish(true);
  expect((await b).ok).toBe(true);
  expect(spawnCount).toBe(1);
  expect(_debugSnapshotForTests()[0].leases).toBe(1);
});

test('last cancellation cleans up startup and never leaks a success lease', async () => {
  let finish!: (healthy: boolean) => void;
  ready = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const controller = new AbortController();
  const result = acquireRuntimeServer(process.cwd(), cfg, { signal: controller.signal });
  for (let i = 0; i < 20 && !finish; i++) await new Promise((r) => setTimeout(r, 1));
  controller.abort();
  expect((await result).ok).toBe(false);
  finish(true);
  for (let i = 0; i < 20 && _debugSnapshotForTests().length; i++)
    await new Promise((r) => setTimeout(r, 1));
  expect(stopCount).toBe(1);
  expect(_debugSnapshotForTests()).toEqual([]);
});

test('startup timeout with unconfirmed termination blocks a replacement spawn', async () => {
  ready = async () => false;
  stopped = false;
  expect((await acquireRuntimeServer(process.cwd(), cfg)).ok).toBe(false);
  expect(_debugSnapshotForTests()[0].state).toBe('quarantined');
  expect((await acquireRuntimeServer(process.cwd(), cfg)).ok).toBe(false);
  expect(spawnCount).toBe(1);
});

test('active-record write failure triggers cleanup and keeps exclusion until durable removal', async () => {
  ready = async () => {
    storeFailed = true;
    return true;
  };
  expect((await acquireRuntimeServer(process.cwd(), cfg)).ok).toBe(false);
  expect(stopCount).toBe(1);
  expect(_debugSnapshotForTests()[0].state).toBe('quarantined');
  expect((await acquireRuntimeServer(process.cwd(), cfg)).ok).toBe(false);
  expect(spawnCount).toBe(1);
});

test('children born during health polling are recorded before startup finishes', async () => {
  let finish!: (healthy: boolean) => void;
  ready = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const starting = acquireRuntimeServer(process.cwd(), cfg);
  for (let i = 0; i < 20 && !finish; i++) await new Promise((r) => setTimeout(r, 1));
  extraProcesses = [{ pid: 124, parentPid: 123, birth: '101', command: 'late child' }];
  await new Promise((r) => setTimeout(r, 2700));
  expect(rows[0].state).toBe('starting');
  expect(rows[0].identities.map((p: { pid: number }) => p.pid)).toEqual([123, 124]);
  finish(true);
  expect((await starting).ok).toBe(true);
});
