/**
 * branch-pr-ops テスト（merge / revert / ensurePrBase の分岐）
 *
 * branch-pr-ops.test.ts が createPullRequest の push 分岐耐性を中心に検証するのに
 * 対し、このファイルは以下の未検証だった分岐をロックする:
 *  - revertChanges: PRIMARY working tree では絶対に破壊的git操作(reset/checkout/clean)
 *    を実行しないこと（過去に developer の未コミット作業を壊した実障害の再発防止）。
 *  - mergePullRequest: コミット数によるsquash/mergeの戦略選択。
 *  - mergePullRequest: "head behind base" (ブランチ保護) を retriable として扱い、
 *    force-merge の代わりに update-branch を叩くこと。
 *  - mergePullRequest: update-branch が「既に最新」を返すレースも retriable として
 *    扱うこと（失敗として握りつぶさない）。
 *  - createPullRequest 経由の ensurePrBase: 新規作成直後にbaseがずれていた場合の
 *    自動retarget。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

let calls: string[] = [];
let callOpts: Array<{ cmd: string; opts: { timeout?: number } }> = [];
let script: Array<{ match: RegExp; result: string | Error }> = [];
// Controls the return value of the mocked isPrimaryWorkTree.
let primaryWorkTree = false;

function runScripted(cmd: string, opts?: { timeout?: number }): { stdout: string; stderr: string } {
  calls.push(cmd);
  if (opts) callOpts.push({ cmd, opts });
  for (const s of script) {
    if (s.match.test(cmd)) {
      if (s.result instanceof Error) throw s.result;
      return { stdout: s.result, stderr: '' };
    }
  }
  if (cmd.includes('--json number,state,mergedAt,baseRefName'))
    return {
      stdout: JSON.stringify({
        number: 42,
        state: 'MERGED',
        mergedAt: '2026-09-08T00:00:00Z',
        baseRefName: 'develop',
      }),
      stderr: '',
    };
  return { stdout: '', stderr: '' };
}

// Mirrors the execFile(file, args[]) -> joined "cmd" string approach used by
// branch-pr-ops.test.ts, so scripted regexes read naturally.
const execFileMockImpl = (
  file: string,
  args: unknown,
  _opts: unknown,
  cb?: (e: Error | null, r?: unknown) => void,
) => {
  const argv = Array.isArray(args) ? (args as string[]) : [];
  const callback = (typeof _opts === 'function' ? _opts : cb) as (
    e: Error | null,
    r?: unknown,
  ) => void;
  const opts = typeof _opts === 'function' ? undefined : (_opts as { timeout?: number });
  const cmd = [file, ...argv].join(' ');
  try {
    callback(null, runScripted(cmd, opts));
  } catch (err) {
    callback(err as Error);
  }
};
const execMockImpl = (cmd: string, _opts: unknown, cb?: (e: Error | null, r?: unknown) => void) => {
  const callback = (typeof _opts === 'function' ? _opts : cb) as (
    e: Error | null,
    r?: unknown,
  ) => void;
  try {
    callback(null, runScripted(cmd));
  } catch (err) {
    callback(err as Error);
  }
};
mock.module('child_process', () => ({
  execFile: execFileMockImpl,
  exec: execMockImpl,
}));
mock.module('node:child_process', () => ({
  execFile: execFileMockImpl,
  exec: execMockImpl,
}));
mock.module('../../../../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}));
// NOTE: Unlike branch-pr-ops.test.ts (which pins isPrimaryWorkTree to always
// false), this file needs BOTH branches — revertChanges' primary-tree refusal
// is the exact invariant under test — so isPrimaryWorkTree reads a mutable
// module-level flag the tests can flip per-case.
// NOTE: Mirror ALL worktree-guard exports (not just the ones this file uses) —
// bun's mock.module is process-global, so an incomplete mock here silently
// breaks worktree-guard.test.ts (which imports the REAL module) when both
// files run in the same `bun test` process. isBackendPrimaryCheckout is
// unused by branch-pr-ops.ts but must still be present on the mock.
mock.module('../worktree/worktree-guard', () => ({
  isPrimaryWorkTree: async () => primaryWorkTree,
  ensureNotPrimaryWorkTree: async () => {},
  isBackendPrimaryCheckout: async () => primaryWorkTree,
  findConflictingWorktreeForBranch: async () => null,
  // NOTE: Recorded into `calls` (same array as executed git commands) so tests
  // can assert this ran BEFORE the post-merge `git checkout` — task 743 added
  // this call to close the one unguarded checkout path (see below).
  recoverFromUnresolvedMerge: async () => {
    calls.push('recoverFromUnresolvedMerge');
    return false;
  },
}));
mock.module('../../../../github/gh-client', () => ({
  runGhCommandWithBody: async (): Promise<string> => 'https://github.com/x/y/pull/99',
}));

const { revertChanges, mergePullRequest, createPullRequest } = await import('./branch-pr-ops');

beforeEach(() => {
  calls = [];
  callOpts = [];
  script = [];
  primaryWorkTree = false;
});

describe('revertChanges — PRIMARY working tree guard', () => {
  test('refuses to run destructive git commands on the PRIMARY working tree, returns false', async () => {
    primaryWorkTree = true;

    const result = await revertChanges('/repo/primary');

    expect(result).toBe(false);
    // The whole point of the guard: none of the destructive commands may run.
    expect(calls.some((c) => /^git reset/.test(c))).toBe(false);
    expect(calls.some((c) => /^git checkout -- \./.test(c))).toBe(false);
    expect(calls.some((c) => /^git clean/.test(c))).toBe(false);
  });

  test('runs reset + checkout + clean (excluding .worktrees/.agent-pids) on a non-primary worktree', async () => {
    primaryWorkTree = false;

    const result = await revertChanges('/repo/.worktrees/task-1');

    expect(result).toBe(true);
    expect(calls.some((c) => /^git reset HEAD$/.test(c))).toBe(true);
    expect(calls.some((c) => /^git checkout -- \.$/.test(c))).toBe(true);
    const cleanCall = calls.find((c) => c.startsWith('git clean'));
    expect(cleanCall).toBeDefined();
    expect(cleanCall).toContain('-fd');
    expect(cleanCall).toContain('-e .worktrees');
    expect(cleanCall).toContain('-e .agent-pids');
  });

  test('the reset/checkout/clean sequence carries a timeout so a hang cannot block the phase (#809)', async () => {
    primaryWorkTree = false;

    await revertChanges('/repo/.worktrees/task-3');

    const resetCall = callOpts.find((c) => /^git reset HEAD$/.test(c.cmd));
    const checkoutCall = callOpts.find((c) => /^git checkout -- \.$/.test(c.cmd));
    const cleanCall = callOpts.find((c) => c.cmd.startsWith('git clean'));
    expect(resetCall?.opts.timeout).toBe(60_000);
    expect(checkoutCall?.opts.timeout).toBe(60_000);
    expect(cleanCall?.opts.timeout).toBe(60_000);
  });

  test('a mid-sequence git failure on a non-primary worktree returns false (not throw)', async () => {
    primaryWorkTree = false;
    script = [{ match: /^git checkout -- \./, result: new Error('checkout failed') }];

    const result = await revertChanges('/repo/.worktrees/task-2');

    expect(result).toBe(false);
  });
});

describe('mergePullRequest — squash vs merge commit-count threshold', () => {
  test.each([
    { number: 42, state: 'OPEN', mergedAt: null, baseRefName: 'develop' },
    { number: 99, state: 'MERGED', mergedAt: '2026-09-08T00:00:00Z', baseRefName: 'develop' },
    { number: 42, state: 'MERGED', mergedAt: null, baseRefName: 'develop' },
  ])('does not trust CLI success without the requested merge evidence: %j', async (actual) => {
    script = [
      { match: /--json number,state,mergedAt,baseRefName/, result: JSON.stringify(actual) },
    ];
    expect((await mergePullRequest('/repo', 42, 5, 'develop')).success).toBe(false);
    expect(calls.some((c) => c.startsWith('git checkout'))).toBe(false);
  });
  test('does not publish after the stop guard rejects', async () => {
    expect((await mergePullRequest('/repo', 42, 5, 'develop', async () => false)).success).toBe(
      false,
    );
    expect(calls.some((c) => /pr merge|pr update-branch/.test(c))).toBe(false);
  });
  test('uses --squash when commit count >= threshold', async () => {
    script = [
      { match: /pr view 42 --json commits/, result: '6' },
      { match: /pr merge 42/, result: '' },
    ];

    const result = await mergePullRequest('/repo', 42, 5, 'develop');

    expect(result).toEqual({ success: true, mergeStrategy: 'squash' });
    expect(calls.some((c) => /pr merge 42 --squash --delete-branch/.test(c))).toBe(true);
  });

  test('uses --merge when commit count is below threshold', async () => {
    script = [
      { match: /pr view 42 --json commits/, result: '2' },
      { match: /pr merge 42/, result: '' },
    ];

    const result = await mergePullRequest('/repo', 42, 5, 'develop');

    expect(result).toEqual({ success: true, mergeStrategy: 'merge' });
    expect(calls.some((c) => /pr merge 42 --merge --delete-branch/.test(c))).toBe(true);
    expect(calls.some((c) => /--squash/.test(c))).toBe(false);
  });

  test('an unparsable commit count falls back to 1 (merge strategy), not a crash', async () => {
    script = [
      { match: /pr view 42 --json commits/, result: 'not-a-number' },
      { match: /pr merge 42/, result: '' },
    ];

    const result = await mergePullRequest('/repo', 42, 5, 'develop');

    expect(result.success).toBe(true);
    expect(result.mergeStrategy).toBe('merge');
  });
});

describe('mergePullRequest — branch-protection "head behind base" is retriable, not a hard failure', () => {
  test('when the merge is rejected as behind-base, updates the branch and reports retriable:true (no force-merge)', async () => {
    script = [
      { match: /pr view 42 --json commits/, result: '1' },
      {
        match: /pr merge 42/,
        result: new Error('GraphQL: Pull Request is not mergeable: the base branch was modified.'),
      },
      { match: /pr update-branch 42/, result: '' },
    ];

    const result = await mergePullRequest('/repo', 42, 5, 'develop');

    expect(result.success).toBe(false);
    expect(result.retriable).toBe(true);
    expect(calls.some((c) => /pr update-branch 42/.test(c))).toBe(true);
    // Must never force through a merge on a behind-base PR.
    expect(calls.some((c) => /--admin/.test(c))).toBe(false);
  });

  test('when update-branch races and reports already-up-to-date, still reports retriable:true (not a failure)', async () => {
    script = [
      { match: /pr view 42 --json commits/, result: '1' },
      {
        match: /pr merge 42/,
        result: new Error('Pull Request is not mergeable: not up to date with the base branch.'),
      },
      {
        match: /pr update-branch 42/,
        result: new Error('The branch is already up to date'),
      },
    ];

    const result = await mergePullRequest('/repo', 42, 5, 'develop');

    expect(result.success).toBe(false);
    expect(result.retriable).toBe(true);
    expect(result.error).toContain('will retry');
  });

  test('a genuine update-branch failure (not a race) is reported as a hard failure (no retriable flag)', async () => {
    script = [
      { match: /pr view 42 --json commits/, result: '1' },
      {
        match: /pr merge 42/,
        result: new Error('Pull Request is not mergeable: not up to date with the base branch.'),
      },
      { match: /pr update-branch 42/, result: new Error('network error: connection reset') },
    ];

    const result = await mergePullRequest('/repo', 42, 5, 'develop');

    expect(result.success).toBe(false);
    expect(result.retriable).toBeUndefined();
    expect(result.error).toContain('update-branch failed');
  });

  test('a non-behind-base merge failure (e.g. CI still pending) is a plain failure, not retriable', async () => {
    script = [
      { match: /pr view 42 --json commits/, result: '1' },
      { match: /pr merge 42/, result: new Error('Required status check is pending') },
    ];

    const result = await mergePullRequest('/repo', 42, 5, 'develop');

    expect(result.success).toBe(false);
    expect(result.retriable).toBeUndefined();
    expect(calls.some((c) => /pr update-branch/.test(c))).toBe(false);
  });
});

describe('mergePullRequest — post-merge local sync self-heals an unresolved index (task 743)', () => {
  test('calls recoverFromUnresolvedMerge before the post-merge checkout on a non-primary worktree', async () => {
    primaryWorkTree = false;
    script = [
      { match: /pr view 42 --json commits/, result: '1' },
      { match: /pr merge 42/, result: '' },
      { match: /^git checkout develop/, result: '' },
      { match: /^git pull/, result: '' },
    ];

    const result = await mergePullRequest('/repo/.worktrees/task-1', 42, 5, 'develop');

    expect(result.success).toBe(true);
    const recoverIndex = calls.indexOf('recoverFromUnresolvedMerge');
    const checkoutIndex = calls.findIndex((c) => /^git checkout develop/.test(c));
    // Before this fix, this path never called recoverFromUnresolvedMerge, so a
    // worktree left with an unresolved MERGE_HEAD/CHERRY_PICK_HEAD from a prior
    // failed merge would fail this checkout with git's "you need to resolve
    // your current index first" (the exact task-743 log). Asserting the call
    // happened, and happened before the checkout, locks the fix in place.
    expect(recoverIndex).toBeGreaterThanOrEqual(0);
    expect(checkoutIndex).toBeGreaterThanOrEqual(0);
    expect(recoverIndex).toBeLessThan(checkoutIndex);
  });

  test('skips recoverFromUnresolvedMerge on the PRIMARY working tree (sync itself is skipped)', async () => {
    primaryWorkTree = true;
    script = [
      { match: /pr view 42 --json commits/, result: '1' },
      { match: /pr merge 42/, result: '' },
    ];

    const result = await mergePullRequest('/repo', 42, 5, 'develop');

    expect(result.success).toBe(true);
    expect(calls.includes('recoverFromUnresolvedMerge')).toBe(false);
  });
});

describe('createPullRequest — ensurePrBase corrects a drifted base right after creation', () => {
  test('retargets the PR when gh created it against the wrong base (e.g. repo default) than requested', async () => {
    script = [
      { match: /branch --list develop/, result: '' },
      { match: /branch -r --list origin\/develop/, result: 'origin/develop' },
      { match: /branch --show-current/, result: 'feature/my-branch' },
      { match: /^git push -u origin feature\/my-branch$/, result: '' },
      { match: /pr list --head feature\/my-branch/, result: 'null' },
      // gh opened the PR against "main" instead of the requested "develop".
      { match: /pr view 99 --json baseRefName/, result: 'main' },
      { match: /pr edit 99 --base develop/, result: '' },
    ];

    const result = await createPullRequest('/repo', 'My PR', 'body');

    expect(result.success).toBe(true);
    expect(result.prNumber).toBe(99);
    expect(calls.some((c) => /pr edit 99 --base develop/.test(c))).toBe(true);
  });

  test('does not retarget when the created PR base already matches the intended target', async () => {
    script = [
      { match: /branch --list develop/, result: 'develop' },
      { match: /branch --show-current/, result: 'feature/my-branch' },
      { match: /^git push -u origin feature\/my-branch$/, result: '' },
      { match: /pr list --head feature\/my-branch/, result: 'null' },
      { match: /pr view 99 --json baseRefName/, result: 'develop' },
    ];

    const result = await createPullRequest('/repo', 'My PR', 'body');

    expect(result.success).toBe(true);
    expect(calls.some((c) => /pr edit 99 --base/.test(c))).toBe(false);
  });

  test('ensurePrBase の gh 呼び出しには長めのタイムアウトが設定されること (#809)', async () => {
    script = [
      { match: /branch --list develop/, result: '' },
      { match: /branch -r --list origin\/develop/, result: 'origin/develop' },
      { match: /branch --show-current/, result: 'feature/my-branch' },
      { match: /^git push -u origin feature\/my-branch$/, result: '' },
      { match: /pr list --head feature\/my-branch/, result: 'null' },
      { match: /pr view 99 --json baseRefName/, result: 'main' },
      { match: /pr edit 99 --base develop/, result: '' },
    ];

    await createPullRequest('/repo', 'My PR', 'body');

    const viewCall = callOpts.find((c) => /pr view 99 --json baseRefName/.test(c.cmd));
    const editCall = callOpts.find((c) => /pr edit 99 --base develop/.test(c.cmd));
    expect(viewCall?.opts.timeout).toBe(120_000);
    expect(editCall?.opts.timeout).toBe(120_000);
  });

  test('a failure verifying/correcting the base does not fail PR creation (best-effort)', async () => {
    script = [
      { match: /branch --list develop/, result: 'develop' },
      { match: /branch --show-current/, result: 'feature/my-branch' },
      { match: /^git push -u origin feature\/my-branch$/, result: '' },
      { match: /pr list --head feature\/my-branch/, result: 'null' },
      { match: /pr view 99 --json baseRefName/, result: new Error('gh: rate limited') },
    ];

    const result = await createPullRequest('/repo', 'My PR', 'body');

    expect(result.success).toBe(true);
    expect(result.prNumber).toBe(99);
  });
});
