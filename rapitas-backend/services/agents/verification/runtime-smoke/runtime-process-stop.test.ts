import { expect, test } from 'bun:test';
import { stopRuntimeProcesses, type RuntimeStopDependencies } from './runtime-process-stop';
import type { RuntimeProcessIdentity } from './runtime-process-identity';

const root: RuntimeProcessIdentity = { pid: 10, parentPid: 1, birth: '100', command: 'owned' };
const child: RuntimeProcessIdentity = { pid: 11, parentPid: 10, birth: '101', command: 'child' };
function fixture(rows: RuntimeProcessIdentity[]) {
  let time = 0;
  const killed: number[] = [];
  const deps: RuntimeStopDependencies = {
    snapshot: async () => ({ processes: rows, protectedPids: new Set() }),
    terminate: async (p) => {
      killed.push(p.pid);
    },
    wait: async () => {
      time += 10;
    },
    now: () => time,
  };
  return { deps, killed };
}

test('successful signal without exit remains held', async () => {
  const { deps } = fixture([root]);
  expect((await stopRuntimeProcesses([root], async () => {}, 20, deps)).stopped).toBe(false);
});

test('exit must be observed after signal and captured children persisted before stopping', async () => {
  const { deps, killed } = fixture([root, child]);
  let snapshotCount = 0;
  let persisted: RuntimeProcessIdentity[] = [];
  deps.snapshot = async () => ({
    processes: snapshotCount++ === 0 ? [root, child] : [],
    protectedPids: new Set(),
  });
  deps.terminate = async (p) => {
    expect(persisted).toEqual([root, child]);
    killed.push(p.pid);
  };
  const result = await stopRuntimeProcesses(
    [root],
    async (rows) => {
      persisted = rows;
    },
    20,
    deps,
  );
  expect(result.stopped).toBe(true);
  expect(killed).toEqual([10, 11]);
});

test('persistence failure does not prevent stopping a positively identified process', async () => {
  const { deps, killed } = fixture([root]);
  deps.snapshot = async () => ({
    processes: killed.length ? [] : [root],
    protectedPids: new Set(),
  });
  const result = await stopRuntimeProcesses(
    [root],
    async () => {
      throw new Error('disk failure');
    },
    20,
    deps,
  );
  expect(result.stopped).toBe(true);
  expect(result.reason).toContain('disk failure');
  expect(killed).toEqual([root.pid]);
});

test('reused child prevents even the root from being stopped', async () => {
  const { deps, killed } = fixture([root, { ...child, birth: '200' }]);
  expect((await stopRuntimeProcesses([root, child], async () => {}, 20, deps)).stopped).toBe(false);
  expect(killed).toEqual([]);
});

test('snapshot failure cannot be interpreted as successful termination', async () => {
  const { deps, killed } = fixture([]);
  deps.snapshot = async () => {
    throw new Error('OS unavailable');
  };
  expect((await stopRuntimeProcesses([root], async () => {}, 20, deps)).stopped).toBe(false);
  expect(killed).toEqual([]);
});

test('child disappearing after root stop is confirmed by a fresh snapshot', async () => {
  const { deps } = fixture([root, child]);
  let signals = 0;
  deps.terminate = async () => {
    if (++signals === 2) throw new Error('child already exited');
  };
  deps.snapshot = async () => ({
    processes: signals === 0 ? [root, child] : [],
    protectedPids: new Set(),
  });
  expect((await stopRuntimeProcesses([root, child], async () => {}, 20, deps)).stopped).toBe(true);
});

test('signal failure with a surviving child stays held', async () => {
  const { deps } = fixture([root, child]);
  let signals = 0;
  deps.terminate = async () => {
    if (++signals === 2) throw new Error('access denied');
  };
  deps.snapshot = async () => ({
    processes: signals === 0 ? [root, child] : [child],
    protectedPids: new Set(),
  });
  const result = await stopRuntimeProcesses([root, child], async () => {}, 20, deps);
  expect(result.stopped).toBe(false);
  expect(result.reason).toContain('access denied');
});

test('one vanished child does not leave other verified siblings running', async () => {
  const sibling = { ...child, pid: 12 };
  const { deps, killed } = fixture([root, child, sibling]);
  deps.snapshot = async () => ({
    processes: killed.includes(sibling.pid) ? [] : [root, child, sibling],
    protectedPids: new Set(),
  });
  deps.terminate = async (identity) => {
    if (identity.pid === child.pid) throw new Error('child already exited');
    killed.push(identity.pid);
  };
  expect(
    (await stopRuntimeProcesses([root, child, sibling], async () => {}, 20, deps)).stopped,
  ).toBe(true);
  expect(killed).toEqual([root.pid, sibling.pid]);
});
