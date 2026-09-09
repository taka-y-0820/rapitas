import { expect, test } from 'bun:test';
import {
  extendOwnedRuntimeTree,
  inspectOwnedRuntimeTree,
  type RuntimeProcessIdentity,
} from './runtime-process-identity';

const root: RuntimeProcessIdentity = {
  pid: 100,
  parentPid: 1,
  birth: '1000',
  command: 'owned shell',
};
const child: RuntimeProcessIdentity = {
  pid: 101,
  parentPid: 100,
  birth: '1001',
  command: 'owned server',
};

test('a reused root cannot authorize its new children', () => {
  const reused = { ...root, birth: '2000' };
  expect(extendOwnedRuntimeTree([root], [reused, child])).toEqual([root]);
  expect(inspectOwnedRuntimeTree([root], [reused], new Set()).safe).toBe(false);
});

test('a reused child blocks a stop even when the original root still exists', () => {
  expect(
    inspectOwnedRuntimeTree([root, child], [root, { ...child, birth: '2001' }], new Set()),
  ).toEqual({
    safe: false,
    alive: [],
    reason: 'identity-mismatch',
  });
});

test('captured orphans can extend their own live lineage after root exit', () => {
  const grandchild = { pid: 102, parentPid: 101, birth: '1002', command: 'worker' };
  const owned = extendOwnedRuntimeTree([root, child], [child, grandchild]);
  expect(owned).toEqual([root, child, grandchild]);
  expect(inspectOwnedRuntimeTree(owned, [child, grandchild], new Set()).alive).toEqual([
    child,
    grandchild,
  ]);
});

test('snapshot failure differs from verified absence; protected child blocks all targets', () => {
  expect(inspectOwnedRuntimeTree([root], null, new Set()).safe).toBe(false);
  expect(inspectOwnedRuntimeTree([root], [], new Set())).toEqual({ safe: true, alive: [] });
  expect(inspectOwnedRuntimeTree([root, child], [root, child], new Set([child.pid])).safe).toBe(
    false,
  );
});

test('same-workdir unrelated process is never adopted without lineage', () => {
  const external = { pid: 200, parentPid: 1, birth: '1003', command: 'owned server same-workdir' };
  expect(extendOwnedRuntimeTree([root], [root, external])).toEqual([root]);
});

test('a stale parent id on an older process does not establish ownership', () => {
  expect(extendOwnedRuntimeTree([root], [root, { ...child, birth: '999' }])).toEqual([root]);
});
