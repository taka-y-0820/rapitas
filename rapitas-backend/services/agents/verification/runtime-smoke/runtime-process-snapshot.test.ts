import { expect, test } from 'bun:test';
import {
  ownsRuntimePort,
  parseWindowsRuntimeSnapshot,
  parseLinuxRuntimeStat,
  parseLinuxRuntimeListeners,
} from './runtime-process-snapshot';

test('Windows snapshot preserves exact creation ticks and listener protection', () => {
  const snapshot = parseWindowsRuntimeSnapshot(
    JSON.stringify({
      processes: [{ pid: 12, parentPid: 1, birth: '639245658220001234', command: 'server' }],
      protectedPids: [12],
      listeners: [{ port: 3001, pid: 12 }],
    }),
  );
  expect(snapshot.processes[0].birth).toBe('639245658220001234');
  expect(snapshot.protectedPids.has(12)).toBe(true);
});

test('missing protection data or creation identity rejects the whole snapshot', () => {
  expect(() => parseWindowsRuntimeSnapshot('{"processes":[]}')).toThrow();
  expect(() =>
    parseWindowsRuntimeSnapshot(
      JSON.stringify({
        processes: [{ pid: 12, parentPid: 1, birth: '', command: 'server' }],
        protectedPids: [],
      }),
    ),
  ).toThrow();
});

test('Linux stat parser handles parentheses inside the process name', () => {
  const fields = ['S', '9', ...Array(17).fill('0'), '123456'];
  expect(parseLinuxRuntimeStat(`12 (name (with) spaces) ${fields.join(' ')}`, 'server')).toEqual({
    pid: 12,
    parentPid: 9,
    birth: '123456',
    command: 'server',
  });
});

test('a port is usable only when every listener belongs to a verified process', () => {
  const identity = { pid: 12, parentPid: 1, birth: '100', command: 'server' };
  const snapshot = {
    processes: [identity],
    protectedPids: new Set<number>(),
    listeners: [{ port: 4444, pid: 12 }],
  };
  expect(ownsRuntimePort(snapshot, [identity], 4444)).toBe(true);
  expect(
    ownsRuntimePort({ ...snapshot, listeners: [{ port: 4444, pid: 99 }] }, [identity], 4444),
  ).toBe(false);
  expect(ownsRuntimePort({ ...snapshot, listeners: [] }, [identity], 4444)).toBe(false);
  expect(ownsRuntimePort({ ...snapshot, listeners: undefined }, [identity], 4444)).toBe(false);
});

test('Linux listener parsing handles IPv6, shared sockets and unidentified owners', () => {
  expect(
    parseLinuxRuntimeListeners(
      'LISTEN 0 511 [::]:4444 [::]:* users:(("node",pid=12,fd=1),("node",pid=13,fd=1))\nLISTEN 0 10 127.0.0.1:3001 0.0.0.0:*',
    ),
  ).toEqual([
    { port: 4444, pid: 12 },
    { port: 4444, pid: 13 },
    { port: 3001, pid: 0 },
  ]);
  expect(() => parseLinuxRuntimeListeners('unexpected output')).toThrow();
});
