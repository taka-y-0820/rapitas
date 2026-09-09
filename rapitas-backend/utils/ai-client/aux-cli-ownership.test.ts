import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile, unlink, rmdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  observeProcess,
  parseLinuxIdentity,
  type ObservationDependencies,
  createOwnershipRegistry,
  canReconcileOwnership,
  type OwnershipRecord,
} from './aux-cli-ownership';

const rootIdentity = { pid: 42, birth: 'native:root', pgid: 42 };
const childIdentity = { pid: 43, birth: 'native:child', pgid: 42 };
const owned: OwnershipRecord = {
  executionToken: 'owned',
  status: 'unresolved',
  root: rootIdentity,
  descendants: [childIdentity],
  fullyEnumerated: false,
};

test('root absence or reuse cannot override a living or unknown child', () => {
  for (const rootActual of [
    { kind: 'absent' as const },
    { kind: 'present' as const, identity: { ...rootIdentity, birth: 'new-process' } },
  ]) {
    for (const childActual of [
      { kind: 'present' as const, identity: childIdentity },
      { kind: 'unknown' as const, reason: 'OS unavailable' },
    ]) {
      expect(
        canReconcileOwnership(owned, {
          fullyEnumerated: true,
          scopeEmpty: true,
          observations: [
            { expected: rootIdentity, actual: rootActual },
            { expected: childIdentity, actual: childActual },
          ],
        }),
      ).toBe(false);
    }
  }
});

test('complete absence evidence is required for all recorded identities and scope', () => {
  const observations = [rootIdentity, childIdentity].map((expected) => ({
    expected,
    actual: { kind: 'absent' as const },
  }));
  expect(
    canReconcileOwnership(owned, { fullyEnumerated: true, scopeEmpty: true, observations }),
  ).toBe(true);
  expect(
    canReconcileOwnership(owned, { fullyEnumerated: false, scopeEmpty: true, observations }),
  ).toBe(false);
  expect(
    canReconcileOwnership(owned, { fullyEnumerated: true, scopeEmpty: false, observations }),
  ).toBe(false);
  expect(
    canReconcileOwnership(owned, {
      fullyEnumerated: true,
      scopeEmpty: true,
      observations: observations.slice(0, 1),
    }),
  ).toBe(false);
  expect(
    canReconcileOwnership(
      { ...owned, root: null },
      { fullyEnumerated: true, scopeEmpty: true, observations },
    ),
  ).toBe(false);
});

test('reconciliation preserves other runs and reparented descendants durably', async () => {
  await withRegistry(async (path) => {
    const registry = createOwnershipRegistry(path);
    await registry.recordLaunchIntent('owned');
    await registry.confirmOwnership('owned', rootIdentity);
    await registry.recordDescendants('owned', [childIdentity], true);
    await registry.recordDescendants('owned', [], false);
    await registry.recordLaunchIntent('other');
    await registry.markStopping('owned');
    expect(
      await registry.reconcile('owned', async () => {
        throw new Error('OS failed');
      }),
    ).toBe(false);
    let rows = await createOwnershipRegistry(path).snapshot();
    expect(rows.find((row) => row.executionToken === 'owned')?.descendants).toEqual([
      childIdentity,
    ]);
    expect(rows.find((row) => row.executionToken === 'owned')?.status).toBe('unresolved');
    expect(
      await registry.reconcile('owned', async () => ({
        fullyEnumerated: true,
        scopeEmpty: true,
        observations: [rootIdentity, childIdentity].map((expected) => ({
          expected,
          actual: { kind: 'absent' as const },
        })),
      })),
    ).toBe(true);
    rows = await createOwnershipRegistry(path).snapshot();
    expect(rows.map((row) => row.executionToken)).toEqual(['other']);
    expect(rows[0].status).toBe('intent');
  });
});

async function withRegistry(action: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'rapitas-ownership-test-'));
  try {
    await action(join(directory, 'registry.json'));
  } finally {
    // Only files created in this freshly allocated test directory are removed.
    for (const name of await readdir(directory)) await unlink(join(directory, name));
    await rmdir(directory);
  }
}

test('concurrent durable intents survive reload without lost updates', async () => {
  await withRegistry(async (path) => {
    const first = createOwnershipRegistry(path);
    const second = createOwnershipRegistry(path);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? first : second).recordLaunchIntent(`run-${index}`),
      ),
    );
    await first.confirmOwnership('run-0', { pid: 42, birth: 'native:42', pgid: null });
    const rows = await createOwnershipRegistry(path).snapshot();
    expect(rows).toHaveLength(12);
    expect(rows.find((row) => row.executionToken === 'run-0')?.status).toBe('active');
    expect(rows.filter((row) => row.status === 'intent')).toHaveLength(11);
  });
});

test('corruption remains blocking across restart and is not overwritten', async () => {
  await withRegistry(async (path) => {
    await writeFile(path, '{broken');
    const registry = createOwnershipRegistry(path);
    await expect(registry.recordLaunchIntent('new')).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('{broken');
    await expect(createOwnershipRegistry(path).snapshot()).rejects.toThrow();
    await unlink(path);
    await expect(registry.snapshot()).rejects.toThrow();
  });
});

test('disappearance after initialization cannot silently reset ownership', async () => {
  await withRegistry(async (path) => {
    const registry = createOwnershipRegistry(path);
    await registry.recordLaunchIntent('pending');
    await unlink(path);
    await expect(registry.recordLaunchIntent('replacement')).rejects.toThrow();
    await expect(createOwnershipRegistry(path).snapshot()).rejects.toThrow('missing');
  });
});

const stat = (ticks: string) =>
  `42 (a name ) with spaces) S 1 42 ${Array(16).fill('0').join(' ')} ${ticks}`;
const linux: ObservationDependencies = {
  platform: 'linux',
  read: async (path) => (path.endsWith('boot_id') ? 'boot-a' : stat('99999999999999991')),
  windows: async () => {
    throw new Error('wrong platform');
  },
};

describe('auxiliary process identity observations', () => {
  test('preserves native ticks and parses command parentheses', () => {
    const first = parseLinuxIdentity(42, stat('99999999999999991'), 'boot-a');
    const second = parseLinuxIdentity(42, stat('99999999999999992'), 'boot-a');
    expect(first.pgid).toBe(42);
    expect(first.birth).not.toBe(second.birth);
    expect(first.birth).not.toBe(parseLinuxIdentity(42, stat('99999999999999991'), 'boot-b').birth);
  });
  test('missing process is absent; missing boot identity is unknown', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    expect(
      (
        await observeProcess(42, {
          ...linux,
          read: async () => {
            throw missing;
          },
        })
      ).kind,
    ).toBe('unknown');
    expect(
      (
        await observeProcess(42, {
          ...linux,
          read: async (path) => {
            if (path.endsWith('boot_id')) return 'boot';
            throw missing;
          },
        })
      ).kind,
    ).toBe('absent');
  });
  test('permission and malformed output cannot authorize absence', async () => {
    expect(
      (
        await observeProcess(42, {
          ...linux,
          read: async () => {
            throw new Error('denied');
          },
        })
      ).kind,
    ).toBe('unknown');
    expect((await observeProcess(42, { ...linux, read: async () => 'broken' })).kind).toBe(
      'unknown',
    );
  });
  test('Windows retains ticks as strings and distinguishes failed query from absent', async () => {
    const deps = {
      ...linux,
      platform: 'win32' as const,
      windows: async () => '{"pid":42,"birth":"638929123456789123"}',
    };
    expect(await observeProcess(42, deps)).toEqual({
      kind: 'present',
      identity: { pid: 42, birth: 'windows:638929123456789123', pgid: null },
    });
    expect(await observeProcess(42, { ...deps, windows: async () => 'null' })).toEqual({
      kind: 'absent',
    });
    expect((await observeProcess(42, { ...deps, windows: async () => '' })).kind).toBe('unknown');
  });
  test('invalid PID never reaches OS command', async () => {
    expect((await observeProcess(-1, linux)).kind).toBe('unknown');
  });
});
