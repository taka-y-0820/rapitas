/**
 * scope-check.test
 *
 * Unit tests for the plan-scope enforcement's pure core: parsing plan.md for
 * file/directory tokens, and evaluating a changed-file list against them.
 * Real regression history here (see docs/memory "scope-check false positive"):
 * a matcher that is too loose lets sprawl through; one that is too strict
 * hard-blocks legitimate work. No mocking needed — both functions are pure.
 */
import { describe, it, expect } from 'bun:test';
import { parsePlanFiles, evaluateScopeCheck } from './scope-check';

describe('parsePlanFiles', () => {
  it('recognizes explicitly planned hidden files without allowing unrelated root files', () => {
    const files = parsePlanFiles('Edit `.gitignore`, `.npmrc`, and `config/.env.example`.');
    expect(files).toContain('.gitignore');
    expect(files).toContain('.npmrc');
    expect(files).toContain('config/.env.example');
    expect(files).not.toContain('/');
    expect(evaluateScopeCheck(['.gitignore'], files).ok).toBe(true);
    expect(evaluateScopeCheck(['unplanned.ts'], files).ok).toBe(false);
    expect(parsePlanFiles('Ignore `.` and `..`')).toEqual([]);
  });
  it('extracts a bare backtick-quoted file path', () => {
    const plan = 'Edit `services/foo/bar.ts` to add the new field.';
    expect(parsePlanFiles(plan)).toContain('services/foo/bar.ts');
  });

  it('adds the parent directory of a captured file path', () => {
    const plan = 'Edit `services/foo/bar.ts`.';
    const files = parsePlanFiles(plan);
    expect(files).toContain('services/foo/');
  });

  it('strips a trailing :line or :line:col suffix', () => {
    const plan = 'See `src/app.ts:42` and `src/other.ts:10:5` for context.';
    const files = parsePlanFiles(plan);
    expect(files).toContain('src/app.ts');
    expect(files).toContain('src/other.ts');
    expect(files).not.toContain('src/app.ts:42');
  });

  it('normalizes backslashes to forward slashes', () => {
    const plan = 'Touch `services\\foo\\bar.ts`.';
    expect(parsePlanFiles(plan)).toContain('services/foo/bar.ts');
  });

  it('captures a directory token ending in a slash', () => {
    const plan = 'This plan touches everything under `services/memory/`.';
    expect(parsePlanFiles(plan)).toContain('services/memory/');
  });

  it('extracts a path embedded in a command/sentence token via separator pieces', () => {
    const plan = 'Run `bun test services/foo/bar.test.ts` after editing.';
    const files = parsePlanFiles(plan);
    expect(files).toContain('services/foo/bar.test.ts');
    // The command word itself ("bun"/"test") must not be captured as a path.
    expect(files).not.toContain('bun');
    expect(files).not.toContain('test');
  });

  it('does NOT mistake a bare filename inside prose for a path (no separator)', () => {
    // "foo bar.ts" is multi-word prose; "bar.ts" alone has no '/' so it is
    // rejected by the requireSeparator rule for multi-word tokens.
    const plan = 'Update `foo bar.ts` carefully.';
    expect(parsePlanFiles(plan)).toEqual([]);
  });

  it('accepts a single-word bare filename token (no separator required)', () => {
    const plan = 'Update `TaskCard.tsx` to fix the bug.';
    expect(parsePlanFiles(plan)).toContain('TaskCard.tsx');
  });

  it('ignores a token with no extension and no trailing slash (not path-like)', () => {
    const plan = 'Run `npm` for this.';
    const files = parsePlanFiles(plan);
    expect(files).toEqual([]);
  });

  it('treats a dotted single-word token as a file (e.g. `console.log`) — same as any bare filename', () => {
    // The parser cannot distinguish "a file literally named console.log" from a
    // JS API reference; it is intentionally permissive for bare single-word
    // tokens (multi-word prose is what requireSeparator protects against).
    const plan = 'Check `console.log` output.';
    expect(parsePlanFiles(plan)).toContain('console.log');
  });

  it('de-duplicates repeated paths across the document', () => {
    const plan = 'Touch `a/b/c.ts`. Also touch `a/b/c.ts` again.';
    const files = parsePlanFiles(plan);
    expect(files.filter((f) => f === 'a/b/c.ts')).toHaveLength(1);
  });

  it('returns an empty array for prose-only plans (no backtick tokens)', () => {
    expect(parsePlanFiles('This plan has no code references at all.')).toEqual([]);
  });
});

describe('evaluateScopeCheck', () => {
  it('returns null (not applicable) when the plan has no parseable paths — fail-open', () => {
    const result = evaluateScopeCheck(['services/foo.ts'], []);
    expect(result).toBeNull();
  });

  it('passes when every changed file matches a plan path exactly', () => {
    const result = evaluateScopeCheck(['services/foo.ts'], ['services/foo.ts']);
    expect(result).toEqual({
      name: 'scope',
      ran: true,
      ok: true,
      errorCount: 0,
      details: 'scope: all changes are within the plan',
    });
  });

  it('passes when a changed file lives under a plan directory prefix', () => {
    const result = evaluateScopeCheck(['services/memory/foo.ts'], ['services/memory/']);
    expect(result!.ok).toBe(true);
  });

  it('passes when a changed file matches by basename against a bare-filename plan token', () => {
    const result = evaluateScopeCheck(['src/components/TaskCard.tsx'], ['TaskCard.tsx']);
    expect(result!.ok).toBe(true);
  });

  it('passes when a changed file matches a plan path as a path suffix (different depth)', () => {
    // Plan wrote a package-relative path; the changed file is repo-relative.
    const result = evaluateScopeCheck(
      ['rapitas-backend/services/foo/bar.ts'],
      ['services/foo/bar.ts'],
    );
    expect(result!.ok).toBe(true);
  });

  it('fails when a changed file is outside every plan path/directory', () => {
    const result = evaluateScopeCheck(
      ['services/foo.ts', 'services/unrelated.ts'],
      ['services/foo.ts'],
    );
    expect(result!.ok).toBe(false);
    expect(result!.errorCount).toBe(1);
    expect(result!.details).toContain('services/unrelated.ts');
    expect(result!.name).toBe('scope');
    expect(result!.offendingFiles).toEqual(['services/unrelated.ts']);
  });

  it('does not set offendingFiles on a passing check', () => {
    const result = evaluateScopeCheck(['services/foo.ts'], ['services/foo.ts']);
    expect(result!.ok).toBe(true);
    expect(result!.offendingFiles).toBeUndefined();
  });

  it('never flags allowlisted lockfiles even when absent from the plan', () => {
    const result = evaluateScopeCheck(
      ['services/foo.ts', 'bun.lock', 'package-lock.json'],
      ['services/foo.ts'],
    );
    expect(result!.ok).toBe(true);
    expect(result!.errorCount).toBe(0);
  });

  it('does not confuse a directory prefix with an unrelated file sharing a substring', () => {
    // "services/memory/" must not match "services/memory-extra.ts" (segment-safe).
    const result = evaluateScopeCheck(['services/memory-extra.ts'], ['services/memory/']);
    expect(result!.ok).toBe(false);
  });

  it('caps the offending-file list in details to 40 entries', () => {
    const changed = Array.from({ length: 50 }, (_, i) => `services/extra-${i}.ts`);
    const result = evaluateScopeCheck(changed, ['services/foo.ts']);
    expect(result!.errorCount).toBe(50);
    expect(result!.details.split('\n').filter((l) => l.startsWith('services/extra-'))).toHaveLength(
      40,
    );
    expect(result!.offendingFiles).toHaveLength(40);
  });

  it('normalizes backslashes on the changed-file side too', () => {
    const result = evaluateScopeCheck(['services\\foo.ts'], ['services/foo.ts']);
    expect(result!.ok).toBe(true);
  });
});
