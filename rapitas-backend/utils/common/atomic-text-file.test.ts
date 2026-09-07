import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import * as promises from 'fs/promises';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const realRename = promises.rename;
let failures = 0;
let calls = 0;
let code = 'EPERM';
mock.module('fs/promises', () => ({
  ...promises,
  rename: async (from: string, to: string) => {
    calls++;
    if (failures-- > 0) throw Object.assign(new Error('injected replacement failure'), { code });
    await realRename(from, to);
  },
}));
const { writeAtomicTextFile } = await import('./atomic-text-file');
let directory: string;
let file: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'atomic-log-'));
  file = join(directory, 'execution.log');
  writeFileSync(file, 'previous complete log');
  failures = calls = 0;
  code = 'EPERM';
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

test('complete text replaces the previous log and no temporary remains', async () => {
  await writeAtomicTextFile(file, 'next complete log');
  expect(readFileSync(file, 'utf8')).toBe('next complete log');
  expect(readdirSync(directory)).toEqual(['execution.log']);
});
test.each(['EPERM', 'EACCES', 'EBUSY'])(
  'Windows transient %s is retried without losing the old log',
  async (errorCode) => {
    code = errorCode;
    failures = 2;
    if (process.platform === 'win32') {
      await writeAtomicTextFile(file, 'next complete log');
      expect(calls).toBe(3);
      expect(readFileSync(file, 'utf8')).toBe('next complete log');
    } else {
      await expect(writeAtomicTextFile(file, 'next complete log')).rejects.toThrow();
      expect(calls).toBe(1);
    }
    expect(readdirSync(directory)).toEqual(['execution.log']);
  },
);
test.each(['EPERM', 'ENOSPC'])(
  'persistent %s preserves the original bytes and cleans the temporary',
  async (errorCode) => {
    code = errorCode;
    failures = 100;
    await expect(writeAtomicTextFile(file, 'incomplete replacement')).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe('previous complete log');
    expect(calls).toBe(process.platform === 'win32' && code === 'EPERM' ? 11 : 1);
    expect(readdirSync(directory)).toEqual(['execution.log']);
  },
);
