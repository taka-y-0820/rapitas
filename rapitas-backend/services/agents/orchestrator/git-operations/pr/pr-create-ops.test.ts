/**
 * pr-create-ops テスト
 *
 * createPullRequest の headBranch 明示解決を検証: セッションの branchName が
 * 渡された場合に checkout 状態 (`git branch --show-current`) を読まずそれを
 * head として使うこと、head==base のとき push/gh を呼ばず明示エラーを返すこと
 * (task 594 の head==base 事象の回帰防止)。push 堅牢化・PR再利用・task-identity
 * ガードは branch-pr-ops.test.ts が担当する。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Scripted exec: maps a matched command substring → stdout, or throws when the
// value is an Error. Records every issued command for assertions.
let calls: string[] = [];
let callOpts: Array<{ cmd: string; opts: { timeout?: number } }> = [];
let script: Array<{ match: RegExp; result: string | Error }> = [];

// Tracks calls to runGhCommandWithBody and controls its return value.
let ghWithBodyCalls: Array<{
  baseArgs: string[];
  body: string | undefined;
  cwd: string | undefined;
}> = [];
let ghWithBodyResult: string | Error = '';

function runScripted(cmd: string, opts?: { timeout?: number }): { stdout: string; stderr: string } {
  calls.push(cmd);
  if (opts) callOpts.push({ cmd, opts });
  for (const s of script) {
    if (s.match.test(cmd)) {
      if (s.result instanceof Error) throw s.result;
      return { stdout: s.result, stderr: '' };
    }
  }
  return { stdout: '', stderr: '' };
}

// NOTE: Mirror ALL child_process exports (both specifiers) — bun mock.module is
// process-global, so any sibling module in the same test process that imports
// the shell-string `exec` would fail to resolve if this mock omitted it.
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
// NOTE: gh-client is mocked so that runGhCommandWithBody does not invoke the
// real gh binary. Its result is configurable per-test via ghWithBodyResult.
mock.module('../../../../github/gh-client', () => ({
  runGhCommandWithBody: async (
    baseArgs: string[],
    body: string | undefined,
    cwd: string | undefined,
  ): Promise<string> => {
    ghWithBodyCalls.push({ baseArgs, body, cwd });
    if (ghWithBodyResult instanceof Error) throw ghWithBodyResult;
    return ghWithBodyResult;
  },
}));

const { createPullRequest } = await import('./pr-create-ops');

beforeEach(() => {
  calls = [];
  callOpts = [];
  script = [];
  ghWithBodyCalls = [];
  ghWithBodyResult = '';
});

describe('createPullRequest — headBranch 明示解決', () => {
  test('headBranch 指定時はそのブランチを head として push し --head に渡すこと（show-current を読まない）', async () => {
    ghWithBodyResult = 'https://github.com/x/y/pull/11';
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git push -u origin feature\/t594-add-accessible-stall-recovery$/, result: '' },
      { match: /pr list --head/, result: '' },
    ];

    const res = await createPullRequest(
      '/repo',
      '[Task-594] t',
      'b',
      'develop',
      'feature/t594-add-accessible-stall-recovery',
    );

    expect(res.success).toBe(true);
    expect(res.prNumber).toBe(11);
    // checkout 状態を一切読まないこと（task 594: fallback checkout が base を返す事象の遮断）
    expect(calls.some((c) => /branch --show-current/.test(c))).toBe(false);
    // push はセッションのブランチに対して行われること
    expect(
      calls.some((c) => /git push -u origin feature\/t594-add-accessible-stall-recovery$/.test(c)),
    ).toBe(true);
    // gh pr create は --head でセッションのブランチを明示すること
    expect(ghWithBodyCalls.length).toBe(1);
    const args = ghWithBodyCalls[0]!.baseArgs;
    const headFlag = args.indexOf('--head');
    expect(headFlag).toBeGreaterThan(-1);
    expect(args[headFlag + 1]).toBe('feature/t594-add-accessible-stall-recovery');
  });

  test('git push には長めのタイムアウト(120秒)が設定されること (#809)', async () => {
    ghWithBodyResult = 'https://github.com/x/y/pull/20';
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git push -u origin feature\/timeout-check$/, result: '' },
      { match: /pr list --head/, result: '' },
    ];

    await createPullRequest('/repo', 't', 'b', 'develop', 'feature/timeout-check');

    const pushCall = callOpts.find((c) =>
      /^git push -u origin feature\/timeout-check$/.test(c.cmd),
    );
    expect(pushCall?.opts.timeout).toBe(120_000);
  });

  test('headBranch === base のときは push/gh を一切呼ばず明示エラーを返すこと', async () => {
    script = [{ match: /git branch --list develop/, result: 'develop\n' }];

    const res = await createPullRequest('/repo', '[Task-594] t', 'b', 'develop', 'develop');

    expect(res.success).toBe(false);
    expect(res.error).toContain('develop');
    expect(res.error).toMatch(/head branch and base branch/);
    // push・gh コマンドが 1 回も実行されないこと
    expect(calls.some((c) => /git push/.test(c))).toBe(false);
    expect(calls.some((c) => /pr (list|create)/.test(c))).toBe(false);
    expect(ghWithBodyCalls.length).toBe(0);
    // このエラー文言が no-change 完了に誤分類されないこと (task 485 と同型の事故防止)
    expect(res.error).not.toMatch(
      /no commits between|nothing to commit|no changes added|変更がありません|差分がありません/i,
    );
  });

  test('headBranch 未指定時は従来どおり git branch --show-current にフォールバックすること', async () => {
    ghWithBodyResult = 'https://github.com/x/y/pull/12';
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git branch --show-current/, result: 'feature/legacy-caller\n' },
      { match: /git push -u origin feature\/legacy-caller$/, result: '' },
      { match: /pr list --head/, result: '' },
    ];

    const res = await createPullRequest('/repo', 't', 'b', 'develop');

    expect(res.success).toBe(true);
    expect(res.prNumber).toBe(12);
    expect(calls.some((c) => /branch --show-current/.test(c))).toBe(true);
    expect(calls.some((c) => /git push -u origin feature\/legacy-caller$/.test(c))).toBe(true);
    const args = ghWithBodyCalls[0]!.baseArgs;
    const headFlag = args.indexOf('--head');
    expect(args[headFlag + 1]).toBe('feature/legacy-caller');
  });

  test('checkout が base に落ちていても（show-current が base を返す）ガードで PR 作成を拒否すること', async () => {
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      // task 594 実測: worktree 消滅後の fallback checkout が base を返した
      { match: /git branch --show-current/, result: 'develop\n' },
    ];

    const res = await createPullRequest('/repo', 't', 'b', 'develop');

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/head branch and base branch/);
    expect(calls.some((c) => /git push/.test(c))).toBe(false);
    expect(ghWithBodyCalls.length).toBe(0);
  });
});

describe('createPullRequest — draft PR (task 874)', () => {
  test('draft:true のとき gh pr create に --draft を付与すること', async () => {
    ghWithBodyResult = 'https://github.com/x/y/pull/30';
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git push -u origin feature\/draft-check$/, result: '' },
      { match: /pr list --head/, result: '' },
    ];

    const res = await createPullRequest('/repo', 't', 'b', 'develop', 'feature/draft-check', true);

    expect(res.success).toBe(true);
    expect(ghWithBodyCalls[0]!.baseArgs).toContain('--draft');
  });

  test('draft 省略時は --draft を付与しないこと（既存動作の回帰確認）', async () => {
    ghWithBodyResult = 'https://github.com/x/y/pull/31';
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git push -u origin feature\/no-draft-check$/, result: '' },
      { match: /pr list --head/, result: '' },
    ];

    const res = await createPullRequest('/repo', 't', 'b', 'develop', 'feature/no-draft-check');

    expect(res.success).toBe(true);
    expect(ghWithBodyCalls[0]!.baseArgs).not.toContain('--draft');
  });
});
