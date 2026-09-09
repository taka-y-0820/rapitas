import { expect, test } from 'bun:test';
import { mkdtemp, readdir, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAuxCliRecovery, inspectAuxCliRecovery } from './aux-cli-recovery';
import {
  canReconcileOwnership,
  createOwnershipRegistry,
  type OwnershipRecord,
} from './aux-cli-ownership';

const record: OwnershipRecord = {
  executionToken: 'owned',
  ownershipScope: 'windows-job',
  status: 'unresolved',
  root: { pid: 41, birth: 'windows:1000', pgid: null },
  descendants: [{ pid: 42, birth: 'windows:1001', pgid: null }],
  fullyEnumerated: false,
};

test('Linux scope observation failure cannot discharge absent process identities', async () => {
  const linux: OwnershipRecord = {
    ...record,
    ownershipScope: 'linux-cgroup',
    linuxScope: {
      path: '/sys/fs/cgroup/delegated/rapitas-aux-owned',
      boot: 'boot',
      device: '1',
      inode: '2',
    },
  };
  for (const state of [
    { kind: 'unknown' as const, reason: 'permission denied' },
    { kind: 'present' as const, populated: true },
  ]) {
    const evidence = await inspectAuxCliRecovery(linux, {
      process: async () => ({ kind: 'absent' }),
      job: async () => {
        throw new Error('Windows scope must not be queried');
      },
      linuxScope: async () => state,
    });
    expect(canReconcileOwnership(linux, evidence)).toBe(false);
  }
});

test('missing job cannot discharge an unknown or still-live recorded child', async () => {
  for (const actual of [
    { kind: 'unknown' as const, reason: 'permission' },
    { kind: 'present' as const, identity: record.descendants[0] },
  ]) {
    const evidence = await inspectAuxCliRecovery(record, {
      process: async (pid) => (pid === 41 ? { kind: 'absent' } : actual),
      job: async () => ({ kind: 'absent' }),
    });
    expect(canReconcileOwnership(record, evidence)).toBe(false);
  }
});

test('unknown job query and legacy or unconfirmed records remain blocking', async () => {
  for (const row of [record, { ...record, ownershipScope: undefined }, { ...record, root: null }]) {
    const evidence = await inspectAuxCliRecovery(row, {
      process: async () => ({ kind: 'absent' }),
      job: async () => ({ kind: 'unknown', reason: 'query failed' }),
    });
    expect(canReconcileOwnership(row, evidence)).toBe(false);
  }
});

test('concurrent recovery shares observation and retries unresolved evidence on the next call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rapitas-aux-recovery-'));
  try {
    const registry = createOwnershipRegistry(join(directory, 'registry.json'));
    await registry.recordLaunchIntent(record.executionToken, 'windows-job');
    await registry.confirmOwnership(record.executionToken, record.root!);
    let observations = 0;
    let scopeEmpty = false;
    const recovery = createAuxCliRecovery(registry, async (row) => {
      observations++;
      return {
        fullyEnumerated: true,
        scopeEmpty,
        observations: [{ expected: row.root!, actual: { kind: 'absent' } }],
      };
    });
    const first = recovery.assertReady();
    expect(recovery.assertReady()).toBe(first);
    await expect(first).rejects.toThrow('recovery pending');
    expect(observations).toBe(1);
    expect(await registry.snapshot()).toHaveLength(1);
    scopeEmpty = true;
    await recovery.assertReady();
    expect(observations).toBe(2);
    expect(await registry.snapshot()).toEqual([]);
  } finally {
    for (const name of await readdir(directory)) await unlink(join(directory, name));
    await rmdir(directory);
  }
});
