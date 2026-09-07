import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import * as fs from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const realRename = fs.renameSync;
let failures = 0;
let calls = 0;
let code = 'EPERM';
mock.module('fs', () => ({
  ...fs,
  renameSync: (from: string, to: string) => {
    calls++;
    if (failures-- > 0) throw Object.assign(new Error('injected rename failure'), { code });
    return realRename(from, to);
  },
}));
const { writeAlphaLedger } = await import('./prompt-comparison-alpha-storage');
let directory: string;
let file: string;
beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), 'ledger-replace-'));
  file = join(directory, 'ledger.json');
  fs.writeFileSync(file, '{"generation":1}');
  failures = calls = 0;
  code = 'EPERM';
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

test.each(['EPERM', 'EACCES', 'EBUSY'])(
  'bounded Windows replacement retry handles %s',
  (errorCode) => {
    code = errorCode;
    failures = 2;
    const saved = writeAlphaLedger(file, { generation: 2 });
    expect(saved).toBe(process.platform === 'win32');
    expect(calls).toBe(process.platform === 'win32' ? 3 : 1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).generation).toBe(saved ? 2 : 1);
    expect(fs.readdirSync(directory)).toEqual(['ledger.json']);
  },
);

test('persistent denial preserves the original ledger and stops at the retry bound', () => {
  failures = 100;
  expect(writeAlphaLedger(file, { generation: 2 })).toBe(false);
  expect(calls).toBe(process.platform === 'win32' ? 11 : 1);
  expect(fs.readFileSync(file, 'utf8')).toBe('{"generation":1}');
  expect(fs.readdirSync(directory)).toEqual(['ledger.json']);
});

test('unrelated I/O errors are returned without retry or ledger deletion', () => {
  code = 'ENOSPC';
  failures = 1;
  expect(writeAlphaLedger(file, { generation: 2 })).toBe(false);
  expect(calls).toBe(1);
  expect(fs.readFileSync(file, 'utf8')).toBe('{"generation":1}');
  expect(fs.readdirSync(directory)).toEqual(['ledger.json']);
});
