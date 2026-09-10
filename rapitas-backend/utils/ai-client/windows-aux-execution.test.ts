import { expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOwnershipRegistry } from './aux-cli-ownership';
import { createWindowsAuxExecutionManager } from './windows-aux-execution';

test('new admission does not recover an execution while its local finish is pending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rapitas-aux-finish-'));
  let release!: () => void;
  const finishing = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const registry = createOwnershipRegistry(join(directory, 'registry.json'));
    let inspected = 0;
    const manager = createWindowsAuxExecutionManager(
      {
        ...registry,
        markStopping: async (token) => {
          entered();
          await finishing;
          await registry.markStopping(token);
        },
      },
      {
        observe: async (pid) => ({
          kind: 'present',
          identity: { pid, birth: 'windows:1000', pgid: null },
        }),
        stopJob: async () => {},
        inspect: async (record) => {
          inspected++;
          return {
            fullyEnumerated: true,
            scopeEmpty: true,
            observations: record.root
              ? [{ expected: record.root, actual: { kind: 'absent' } }]
              : [],
          };
        },
      },
    );
    const launch = await manager.reserve('fixture', directory, {});
    await launch.attach({ pid: 42, exitCode: 0, signalCode: null } as ChildProcess);
    const done = launch.finish();
    await started;
    try {
      await manager.reserve('next fixture', directory, {});
      expect(inspected).toBe(0);
      expect(await registry.snapshot()).toHaveLength(2);
    } finally {
      release();
      await done;
    }
    expect(inspected).toBe(1);
  } finally {
    release();
    for (const name of await readdir(directory)) await unlink(join(directory, name));
    await rmdir(directory);
  }
});

for (const failure of ['persistence', 'termination'] as const) {
  test(`failed ${failure} still retains a hold and blocks the next admission`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rapitas-aux-lifecycle-'));
    try {
      const registry = createOwnershipRegistry(join(directory, 'registry.json'));
      let handleStops = 0;
      let jobStops = 0;
      const manager = createWindowsAuxExecutionManager(
        {
          ...registry,
          markStopping:
            failure === 'persistence'
              ? async () => {
                  throw new Error('disk failed');
                }
              : registry.markStopping,
        },
        {
          observe: async (pid) => ({
            kind: 'present',
            identity: { pid, birth: 'windows:1000', pgid: null },
          }),
          stopJob: async () => {
            jobStops++;
            if (failure === 'termination') throw new Error('stop failed');
          },
          inspect: async () => ({ fullyEnumerated: false, scopeEmpty: false, observations: [] }),
        },
      );
      const launch = await manager.reserve('fixture', directory, {});
      expect((await registry.snapshot())[0].status).toBe('intent');
      await launch.attach({
        pid: 42,
        exitCode: null,
        signalCode: null,
        kill: () => {
          handleStops++;
          return true;
        },
      } as unknown as ChildProcess);
      await expect(launch.stop()).rejects.toThrow(
        failure === 'persistence' ? 'disk failed' : 'stop failed',
      );
      expect(handleStops).toBe(1);
      expect(jobStops).toBe(1);
      expect(await registry.snapshot()).toHaveLength(1);
      await expect(manager.reserve('another', directory, {})).rejects.toThrow('recovery pending');
      expect(await registry.snapshot()).toHaveLength(1);
    } finally {
      for (const name of await readdir(directory)) await unlink(join(directory, name));
      await rmdir(directory);
    }
  });
}
