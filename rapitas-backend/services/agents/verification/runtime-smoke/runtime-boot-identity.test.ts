import { expect, test } from 'bun:test';
import { isPriorRuntimeBoot, isRuntimeBootId } from './runtime-boot-identity';

test('only two valid boot observations from the same mechanism prove a change', () => {
  const a = 'linux:00000000-0000-0000-0000-000000000001';
  const b = 'linux:00000000-0000-0000-0000-000000000002';
  expect(isPriorRuntimeBoot(a, b)).toBe(true);
  expect(isPriorRuntimeBoot(a, a)).toBe(false);
  expect(isPriorRuntimeBoot(undefined, a)).toBe(false);
  expect(isPriorRuntimeBoot(a, undefined)).toBe(false);
  expect(isPriorRuntimeBoot('linux:bad', b)).toBe(false);
  expect(isPriorRuntimeBoot(a, 'windows-event12:1:100')).toBe(false);
  expect(isPriorRuntimeBoot('windows-event12:1:100', 'windows-event12:2:200')).toBe(true);
  for (const value of [
    '',
    'windows-event12:0:100',
    'windows-event12:1:bad',
    'linux:' + '-'.repeat(36),
  ]) {
    expect(isRuntimeBootId(value)).toBe(false);
  }
});
