/**
 * acceptance-test-guard.test
 *
 * Guards the credibility of the fail-to-pass metric: if an implementing agent
 * can edit the tests it is graded by, "acceptance rate" measures nothing. The
 * cases pin both directions (violation detected / clean run allowed) plus the
 * path-normalisation this comparison depends on, since git reports POSIX
 * separators while a Windows worktree may not.
 */
import { describe, it, expect } from 'bun:test';
import {
  ACCEPTANCE_TEST_MODIFIED_REASON,
  checkAcceptanceTestsUntouched,
  normalizePath,
  parseProtectedTestFiles,
} from './acceptance-test-guard';

const protectedFiles = [
  'rapitas-backend/services/foo/foo.test.ts',
  'rapitas-frontend/src/components/Bar.test.tsx',
];

describe('checkAcceptanceTestsUntouched', () => {
  it('passes when no protected test was changed', () => {
    const result = checkAcceptanceTestsUntouched(protectedFiles, [
      'rapitas-backend/services/foo/foo.ts',
    ]);
    expect(result.ok).toBe(true);
    expect(result.violatedFiles).toEqual([]);
  });

  it('fails and names the file when a protected test was changed', () => {
    const result = checkAcceptanceTestsUntouched(protectedFiles, [
      'rapitas-backend/services/foo/foo.ts',
      'rapitas-backend/services/foo/foo.test.ts',
    ]);
    expect(result.ok).toBe(false);
    expect(result.violatedFiles).toEqual(['rapitas-backend/services/foo/foo.test.ts']);
    expect(result.reason).toBe(ACCEPTANCE_TEST_MODIFIED_REASON);
  });

  it('reports every violated file, not just the first', () => {
    const result = checkAcceptanceTestsUntouched(protectedFiles, protectedFiles);
    expect(result.violatedFiles).toHaveLength(2);
  });

  it('detects a violation reported with backslash separators', () => {
    const result = checkAcceptanceTestsUntouched(protectedFiles, [
      'rapitas-backend\\services\\foo\\foo.test.ts',
    ]);
    expect(result.ok).toBe(false);
  });

  it('passes when there are no protected tests at all', () => {
    expect(checkAcceptanceTestsUntouched([], ['anything.ts']).ok).toBe(true);
  });

  it('does not match a different test file with a similar name', () => {
    const result = checkAcceptanceTestsUntouched(protectedFiles, [
      'rapitas-backend/services/foo/foo.integration.test.ts',
    ]);
    expect(result.ok).toBe(true);
  });
});

describe('normalizePath', () => {
  it('converts backslashes and strips a ./ prefix', () => {
    expect(normalizePath('./a\\b\\c.test.ts')).toBe('a/b/c.test.ts');
  });
});

describe('parseProtectedTestFiles', () => {
  it('parses a JSON string array', () => {
    expect(parseProtectedTestFiles('["a.test.ts","b.test.ts"]')).toEqual([
      'a.test.ts',
      'b.test.ts',
    ]);
  });

  it('drops non-string entries', () => {
    expect(parseProtectedTestFiles('["a.test.ts",42,null]')).toEqual(['a.test.ts']);
  });

  it('returns an empty array for malformed JSON instead of throwing', () => {
    expect(parseProtectedTestFiles('{not json')).toEqual([]);
  });

  it('returns an empty array when the JSON is not an array', () => {
    expect(parseProtectedTestFiles('{"a":1}')).toEqual([]);
  });
});
