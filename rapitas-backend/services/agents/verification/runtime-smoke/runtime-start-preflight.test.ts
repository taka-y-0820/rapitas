/**
 * runtime-start-preflight tests
 *
 * The start-script preflight and the harness-drift detector that turns
 * "worktree predates the runtime script" into a non-blocking skip.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  checkRuntimeStartScript,
  detectRuntimeHarnessDrift,
  hasRuntimeStartScript,
  parseRuntimeStartScript,
} from './runtime-start-preflight';

const START = 'cd rapitas-frontend && npm run dev:runtime -- -p {port}';

function checkout(scripts: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'rapitas-preflight-'));
  mkdirSync(path.join(root, 'rapitas-frontend'));
  writeFileSync(
    path.join(root, 'rapitas-frontend', 'package.json'),
    JSON.stringify({ name: 'x', scripts }),
  );
  return root;
}

describe('parseRuntimeStartScript', () => {
  test('parses the cd + package-manager form and leaves other syntax alone', () => {
    expect(parseRuntimeStartScript(START)).toEqual({
      dir: 'rapitas-frontend',
      script: 'dev:runtime',
    });
    expect(parseRuntimeStartScript('pnpm run dev')).toEqual({ dir: '.', script: 'dev' });
    expect(parseRuntimeStartScript('node server.js')).toBeNull();
    expect(parseRuntimeStartScript('npm run a && npm run b')).toBeNull();
  });
});

describe('hasRuntimeStartScript / checkRuntimeStartScript', () => {
  test('reports presence, absence, and unknown (unreadable manifest)', async () => {
    const withScript = checkout({ 'dev:runtime': 'next dev' });
    const without = checkout({ dev: 'next dev' });
    expect(await hasRuntimeStartScript(START, withScript)).toBe(true);
    expect(await hasRuntimeStartScript(START, without)).toBe(false);
    expect(await hasRuntimeStartScript(START, path.join(without, 'nope'))).toBeNull();
    expect(await hasRuntimeStartScript('node server.js', without)).toBeNull();
    await expect(checkRuntimeStartScript(START, without)).rejects.toThrow(
      'missing script "dev:runtime"',
    );
    await expect(checkRuntimeStartScript(START, withScript)).resolves.toBeUndefined();
  });
});

describe('detectRuntimeHarnessDrift (tasks 901/905)', () => {
  test('flags a worktree that lacks a script the main checkout has', async () => {
    const base = checkout({ 'dev:runtime': 'next dev' });
    const worktree = checkout({ dev: 'next dev' });
    const reason = await detectRuntimeHarnessDrift(START, worktree, base);
    expect(reason).toContain('dev:runtime');
    expect(reason).toContain('ハーネス差分');
  });

  test('is silent when the worktree has the script, when the base lacks it too, or when unknown', async () => {
    const base = checkout({ 'dev:runtime': 'next dev' });
    const upToDate = checkout({ 'dev:runtime': 'next dev' });
    const neither = checkout({ dev: 'next dev' });
    expect(await detectRuntimeHarnessDrift(START, upToDate, base)).toBeNull();
    // Base also lacks it → a real config problem, not drift; the preflight
    // failure path keeps ownership.
    expect(await detectRuntimeHarnessDrift(START, neither, checkout({ dev: 'x' }))).toBeNull();
    expect(await detectRuntimeHarnessDrift(START, neither, null)).toBeNull();
    // Verifying the main checkout itself is never drift.
    expect(await detectRuntimeHarnessDrift(START, neither, neither)).toBeNull();
    expect(await detectRuntimeHarnessDrift('node server.js', neither, base)).toBeNull();
  });
});
