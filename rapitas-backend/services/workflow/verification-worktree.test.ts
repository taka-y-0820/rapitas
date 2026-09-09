import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isVerificationWorktreeRoot } from './verification-worktree';

test('accepts a Git root but rejects a leftover nested worktree directory and missing paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verification-root-'));
  try {
    execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
    const stale = join(root, '.worktrees', 'deleted-task');
    await mkdir(stale, { recursive: true });
    expect(await isVerificationWorktreeRoot(root)).toBe(true);
    expect(await isVerificationWorktreeRoot(stale)).toBe(false);
    expect(await isVerificationWorktreeRoot(join(root, 'missing'))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
