import { expect, mock, test } from 'bun:test';

// Pure lifecycle tests never address a real PID.
mock.module('../../services/agents/process-tree-kill', () => ({
  captureDescendants: () => new Set(),
}));
mock.module('../../services/agents/agent-process-tracker', () => ({
  killProcessTreeSafely: () => false,
  registerProcess: () => {},
  unregisterProcess: () => {},
}));
const { createAuxCliCleanup } = await import('./aux-cli-cleanup');

test('keeps a surviving grandchild tracked and blocks the next request until it exits', () => {
  const live = new Set([101, 102]);
  const tracked = new Set<number>();
  const cleanup = createAuxCliCleanup({
    capture: () => new Set([102]),
    kill: (pid, targets) => {
      expect(targets).toEqual(new Set([102, 101]));
      live.delete(pid);
    },
    alive: (pid) => live.has(pid),
    track: (pid) => {
      tracked.add(pid);
    },
    untrack: (pid) => {
      tracked.delete(pid);
    },
  });
  expect(cleanup.stop({ pid: 101, kill: mock(() => true) })).toBe(false);
  expect(tracked).toEqual(new Set([102]));
  expect(() => cleanup.assertReady()).toThrow('102');
  live.delete(102);
  expect(() => cleanup.assertReady()).not.toThrow();
  expect(tracked.size).toBe(0);
});

test('a failed kill retains every live target and does not authorize another call', () => {
  const cleanup = createAuxCliCleanup({
    capture: () => new Set([202]),
    kill: () => {},
    alive: () => true,
    track: () => {},
    untrack: () => {
      throw new Error('must remain tracked');
    },
  });
  expect(cleanup.stop({ pid: 201, kill: mock(() => true) })).toBe(false);
  expect(() => cleanup.assertReady()).toThrow('cleanup pending');
});

test('successful tree termination releases the guard', () => {
  let live = true;
  const cleanup = createAuxCliCleanup({
    capture: () => new Set([302]),
    kill: () => {
      live = false;
    },
    alive: () => live,
    track: () => {},
    untrack: () => {},
  });
  expect(cleanup.stop({ pid: 301, kill: mock(() => true) })).toBe(true);
  expect(() => cleanup.assertReady()).not.toThrow();
});
