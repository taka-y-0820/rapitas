/**
 * branch-pr-ops テスト
 *
 * createPullRequest の push 堅牢化を検証: origin のブランチが分岐している
 * (過去実行の `feature/implement-task` 等と衝突) 場合に、force-push せず
 * コミット一意のブランチへ push し直して PR 作成まで到達すること。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Scripted exec: maps a matched command substring → stdout, or throws when the
// value is an Error. Records every issued command for assertions.
let calls: string[] = [];
let callOpts: Array<{ cmd: string; opts: { timeout?: number } }> = [];
let script: Array<{ match: RegExp; result: string | Error }> = [];
// Controls the return value of the mocked findConflictingWorktreeForBranch.
let conflictingWorktreePath: string | null = null;
// Captures runGhCommandWithBody calls for pr create assertions.
let ghClientCalls: Array<{ args: string[]; body: string | undefined; cwd: string | undefined }> =
  [];
// Return value for runGhCommandWithBody when called for pr create.
let ghClientPrCreateResult = '';

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

// NOTE: branch-pr-ops.ts was migrated from exec(shell string) to execFile(file, args[])
// to close a shell-injection vector (branch/base names interpolated into a shell
// string). This mock joins file+args back into a "cmd" string so the existing
// script regexes/assertions below (matched against the pre-migration shell strings)
// keep working unchanged.
// NOTE: Mirror ALL child_process exports (both specifiers) — bun mock.module is
// process-global, so any sibling module in the same test process that imports
// the shell-string `exec` (e.g. repository-setup.ts, worktree-preflight.ts) would
// fail to resolve if this mock omitted it.
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
  // promisify(execFile) calls execFile(file, args, options, callback); resolve {stdout,stderr}.
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
// NOTE: worktree-guard is mocked entirely to prevent calls to execGitReadonly / child_process
// (real git). Guard behaviour is tested separately in worktree-guard.test.ts.
// findConflictingWorktreeForBranch reads conflictingWorktreePath so each test can control it.
mock.module('../worktree/worktree-guard', () => ({
  isPrimaryWorkTree: async () => false,
  ensureNotPrimaryWorkTree: async () => {},
  findConflictingWorktreeForBranch: async () => conflictingWorktreePath,
  recoverFromUnresolvedMerge: async () => false,
}));
// NOTE: gh-client is mocked so that runGhCommandWithBody does not invoke the real
// gh binary. Its result is configurable per-test via ghWithBodyResult.
// ghClientCalls is also populated (as {args, body, cwd}) for assertions using .args notation.
mock.module('../../../../github/gh-client', () => ({
  runGhCommandWithBody: async (
    baseArgs: string[],
    body: string | undefined,
    cwd: string | undefined,
  ): Promise<string> => {
    ghWithBodyCalls.push({ baseArgs, body, cwd });
    ghClientCalls.push({ args: baseArgs, body, cwd });
    if (ghWithBodyResult instanceof Error) throw ghWithBodyResult;
    return ghWithBodyResult;
  },
}));

const { createPullRequest, createBranch, mergePullRequest, FOREIGN_PR_ERROR_PREFIX } =
  await import('./branch-pr-ops');

const rejected = () =>
  new Error(
    'Command failed: git push -u origin feature/implement-task\n ! [rejected] feature/implement-task -> feature/implement-task (non-fast-forward)',
  );

beforeEach(() => {
  calls = [];
  callOpts = [];
  script = [];
  conflictingWorktreePath = null;
  ghWithBodyCalls = [];
  ghWithBodyResult = '';
  ghClientCalls = [];
  ghClientPrCreateResult = '';
});

describe('createPullRequest — push 分岐耐性', () => {
  test('origin が分岐していたらコミット一意ブランチへ push し直して PR 作成すること', async () => {
    ghWithBodyResult = 'https://github.com/x/y/pull/42';
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git branch --show-current/, result: 'feature/implement-task\n' },
      { match: /git push -u origin feature\/implement-task$/, result: rejected() },
      { match: /git rev-parse --short HEAD/, result: 'abc1234\n' },
      { match: /git branch -M feature\/implement-task-abc1234/, result: '' },
      { match: /git push -u origin feature\/implement-task-abc1234$/, result: '' },
      { match: /pr list --head/, result: '' },
    ];

    const res = await createPullRequest('/repo', 'タイトル', '本文');

    expect(res.success).toBe(true);
    expect(res.prNumber).toBe(42);
    // 一意ブランチへリネームして push したこと（force-push していないこと）
    expect(calls.some((c) => /git branch -M feature\/implement-task-abc1234/.test(c))).toBe(true);
    expect(calls.some((c) => /git push -u origin feature\/implement-task-abc1234$/.test(c))).toBe(
      true,
    );
    expect(calls.some((c) => /--force/.test(c))).toBe(false);
    // PR は一意ブランチ head で探索されること
    expect(calls.some((c) => /pr list --head feature\/implement-task-abc1234/.test(c))).toBe(true);
  });

  test('push が成功すれば元のブランチのまま PR 作成すること', async () => {
    ghWithBodyResult = 'https://github.com/x/y/pull/7';
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git branch --show-current/, result: 'feature/add-foo\n' },
      { match: /git push -u origin feature\/add-foo$/, result: '' },
      { match: /pr list --head/, result: '' },
    ];

    const res = await createPullRequest('/repo', 't', 'b');

    expect(res.success).toBe(true);
    expect(res.prNumber).toBe(7);
    expect(calls.some((c) => /git branch -M/.test(c))).toBe(false); // リネームしない
  });

  test('既存PRを再利用する際、ベースが target と違えば retarget すること (#172 回帰)', async () => {
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git branch --show-current/, result: 'chore/update-refactor\n' },
      { match: /git push -u origin chore\/update-refactor$/, result: '' },
      // 既存PR #172 は base=main で開かれている（タイトルマーカーは自タスクと一致）
      {
        match: /pr list --head chore\/update-refactor/,
        result: JSON.stringify({
          number: 172,
          url: 'https://x/pull/172',
          baseRefName: 'main',
          title: '[Task-172] t',
        }),
      },
      { match: /pr edit 172 --base develop/, result: '' },
    ];

    const res = await createPullRequest('/repo', '[Task-172] t', 'b');

    expect(res.success).toBe(true);
    expect(res.prNumber).toBe(172);
    // main -> develop へ retarget したこと
    expect(calls.some((c) => /pr edit 172 --base develop/.test(c))).toBe(true);
    // 再利用なので runGhCommandWithBody の pr create は呼ばれないこと
    expect(ghClientCalls.some((c) => c.args[0] === 'pr' && c.args[1] === 'create')).toBe(false);
  });

  test('既存PRのベースが既に target と同じなら retarget しないこと', async () => {
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git branch --show-current/, result: 'feature/x-y\n' },
      { match: /git push -u origin feature\/x-y$/, result: '' },
      {
        match: /pr list --head feature\/x-y/,
        result: JSON.stringify({
          number: 9,
          url: 'https://x/pull/9',
          baseRefName: 'develop',
          title: '[Task-9] t',
        }),
      },
    ];

    const res = await createPullRequest('/repo', '[Task-9] t', 'b');

    expect(res.success).toBe(true);
    expect(res.prNumber).toBe(9);
    expect(calls.some((c) => /pr edit/.test(c))).toBe(false);
  });

  test('既存PRのnumberが0の場合は再利用せずpr createすること（0のfalsy挙動を固定）', async () => {
    // NOTE: `if (pr.number && pr.url)` は 0 が JavaScript で falsy になるため
    //       再利用パスに入らず gh pr create へフォールスルーする現挙動を固定する。
    //       GitHub PR #0 は実在しないため実害ゼロだが、将来同様の truthy チェックが
    //       増えた際の回帰検知点として意図的にテストする。
    ghWithBodyResult = 'https://github.com/x/y/pull/99';
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git branch --show-current/, result: 'feature/pr-zero\n' },
      { match: /git push -u origin feature\/pr-zero$/, result: '' },
      // pr.number = 0 → if (0 && url) = false → 再利用をスキップして pr create へ
      {
        match: /pr list --head feature\/pr-zero/,
        result: JSON.stringify({ number: 0, url: 'https://x/pull/0', baseRefName: 'develop' }),
      },
    ];

    const res = await createPullRequest('/repo', 't', 'b');

    expect(res.success).toBe(true);
    expect(res.prNumber).toBe(99);
    // 0 は falsy のため再利用をスキップし、runGhCommandWithBody 経由で新規作成されること
    expect(ghWithBodyCalls.some((c) => c.baseArgs.includes('create'))).toBe(true);
  });

  test('既存PRのタイトルマーカーが自タスクと不一致なら再利用せず pr create も試みずエラーを返すこと (task 541)', async () => {
    // 実インシデント再現: 停止済み旧セッションの同名ブランチに task 538 の PR #340 が
    // 開いたまま残っており、task 539 がそれを自分の PR として誤採用した。
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git branch --show-current/, result: 'feature/implement-task\n' },
      { match: /git push -u origin feature\/implement-task$/, result: '' },
      {
        match: /pr list --head feature\/implement-task/,
        result: JSON.stringify({
          number: 340,
          url: 'https://x/pull/340',
          baseRefName: 'develop',
          title: '[Task-538] 他タスクのPR',
        }),
      },
    ];

    const res = await createPullRequest('/repo', '[Task-539] 自タスクのタイトル', 'b');

    expect(res.success).toBe(false);
    expect(res.error?.startsWith(FOREIGN_PR_ERROR_PREFIX)).toBe(true);
    expect(res.foreignPrDetected).toEqual({ prNumber: 340, prUrl: 'https://x/pull/340' });
    // gh pr create を試みないこと（同一 head の重複 PR は GitHub 仕様上作れない）
    expect(ghWithBodyCalls).toHaveLength(0);
    // retarget も行わないこと（他タスクの PR に触らない）
    expect(calls.some((c) => /pr edit/.test(c))).toBe(false);
  });

  test('既存PRのタイトルにマーカーが無い場合も再利用を拒否すること (task 541)', async () => {
    // 手動で作られたマーカー無し PR をブランチ名一致だけで奪わない（安全側）。
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git branch --show-current/, result: 'feature/manual-branch\n' },
      { match: /git push -u origin feature\/manual-branch$/, result: '' },
      {
        match: /pr list --head feature\/manual-branch/,
        result: JSON.stringify({
          number: 77,
          url: 'https://x/pull/77',
          baseRefName: 'develop',
          title: 'manual hotfix without marker',
        }),
      },
    ];

    const res = await createPullRequest('/repo', '[Task-541] mine', 'b');

    expect(res.success).toBe(false);
    expect(res.error?.startsWith(FOREIGN_PR_ERROR_PREFIX)).toBe(true);
    expect(res.foreignPrDetected).toEqual({ prNumber: 77, prUrl: 'https://x/pull/77' });
    expect(ghWithBodyCalls).toHaveLength(0);
  });

  test('指定された base がリポジトリに存在しなければ自動検出へフォールバックすること (task 485 回帰)', async () => {
    // theme.defaultBranch='develop' を明示指定したが、外部リポジトリに develop が
    // 無いケース。存在しない base を gh に渡すと "Base sha can't be blank / No
    // commits between" で失敗するため、main へフォールバックすること。
    ghWithBodyResult = 'https://github.com/x/y/pull/13';
    script = [
      // develop はローカルにもリモートにも存在しない（デフォルトの空 stdout に任せる）
      { match: /git branch --list main/, result: 'main\n' },
      { match: /git branch --show-current/, result: 'feature/implement-uiux\n' },
      { match: /git push -u origin feature\/implement-uiux$/, result: '' },
      { match: /pr list --head/, result: '' },
    ];

    const res = await createPullRequest('/repo', 't', 'b', 'develop');

    expect(res.success).toBe(true);
    expect(res.prNumber).toBe(13);
    const create = ghWithBodyCalls.find((c) => c.baseArgs.includes('create'));
    expect(create).toBeDefined();
    const baseIdx = create!.baseArgs.indexOf('--base');
    expect(create!.baseArgs[baseIdx + 1]).toBe('main');
  });

  test('指定された base が存在すればそのまま使うこと', async () => {
    ghWithBodyResult = 'https://github.com/x/y/pull/14';
    script = [
      { match: /git branch --list release/, result: 'release\n' },
      { match: /git branch --show-current/, result: 'feature/z\n' },
      { match: /git push -u origin feature\/z$/, result: '' },
      { match: /pr list --head/, result: '' },
    ];

    const res = await createPullRequest('/repo', 't', 'b', 'release');

    expect(res.success).toBe(true);
    const create = ghWithBodyCalls.find((c) => c.baseArgs.includes('create'));
    const baseIdx = create!.baseArgs.indexOf('--base');
    expect(create!.baseArgs[baseIdx + 1]).toBe('release');
  });

  test('git push には長めのタイムアウトが設定されること (#809)', async () => {
    ghWithBodyResult = 'https://github.com/x/y/pull/8';
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git branch --show-current/, result: 'feature/timeout-check\n' },
      { match: /git push -u origin feature\/timeout-check$/, result: '' },
      { match: /pr list --head/, result: '' },
    ];

    await createPullRequest('/repo', 't', 'b');

    const pushCall = callOpts.find((c) => /^git push -u origin/.test(c.cmd));
    expect(pushCall?.opts.timeout).toBe(120_000);
  });

  test('分岐以外の push 失敗 (認証等) は PR 失敗として返すこと', async () => {
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git branch --show-current/, result: 'feature/add-foo\n' },
      {
        match: /git push -u origin feature\/add-foo$/,
        result: new Error('fatal: Authentication failed'),
      },
    ];

    const res = await createPullRequest('/repo', 't', 'b');

    expect(res.success).toBe(false);
    expect(res.error).toContain('Authentication failed');
    expect(calls.some((c) => /git branch -M/.test(c))).toBe(false);
  });
});

describe('createPullRequest — runGhCommandWithBody 呼び出し内容の検証', () => {
  test('title と base が配列要素として正確に渡ること（シェルエスケープ不要）', async () => {
    const titleWithSpecialChars = 'Fix: handle "quotes" and \\backslash in title';
    ghWithBodyResult = 'https://github.com/x/y/pull/10';
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git branch --show-current/, result: 'feature/special\n' },
      { match: /git push -u origin feature\/special$/, result: '' },
      { match: /pr list --head/, result: '' },
    ];

    const res = await createPullRequest('/repo', titleWithSpecialChars, 'body');

    expect(res.success).toBe(true);
    expect(ghWithBodyCalls).toHaveLength(1);
    const call = ghWithBodyCalls[0];
    // タイトルはそのまま配列要素として渡ること（シェルエスケープ不要）
    expect(call.baseArgs).toContain(titleWithSpecialChars);
    expect(call.baseArgs).toContain('create');
    expect(call.baseArgs).toContain('--base');
    expect(call.baseArgs).toContain('develop');
    expect(call.cwd).toBe('/repo');
  });

  test('日本語ボディが文字化けなく runGhCommandWithBody に渡ること', async () => {
    const japaneseBody = '## 概要\n\nこのPRは日本語のボディを含む。改行も正しく扱われること。';
    ghWithBodyResult = 'https://github.com/x/y/pull/11';
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git branch --show-current/, result: 'feature/jp\n' },
      { match: /git push -u origin feature\/jp$/, result: '' },
      { match: /pr list --head/, result: '' },
    ];

    const res = await createPullRequest('/repo', 'JP title', japaneseBody);

    expect(res.success).toBe(true);
    expect(ghWithBodyCalls[0].body).toBe(japaneseBody);
  });

  test('空ボディが runGhCommandWithBody に正しく渡ること', async () => {
    ghWithBodyResult = 'https://github.com/x/y/pull/12';
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git branch --show-current/, result: 'feature/empty-body\n' },
      { match: /git push -u origin feature\/empty-body$/, result: '' },
      { match: /pr list --head/, result: '' },
    ];

    const res = await createPullRequest('/repo', 'title', '');

    expect(res.success).toBe(true);
    expect(ghWithBodyCalls[0].body).toBe('');
  });

  test('PR 再利用パスでは runGhCommandWithBody が呼ばれないこと', async () => {
    script = [
      { match: /git branch --list develop/, result: 'develop\n' },
      { match: /git branch --show-current/, result: 'feature/reuse\n' },
      { match: /git push -u origin feature\/reuse$/, result: '' },
      {
        match: /pr list --head feature\/reuse/,
        result: JSON.stringify({
          number: 55,
          url: 'https://x/pull/55',
          baseRefName: 'develop',
          title: '[Task-55] t',
        }),
      },
    ];

    const res = await createPullRequest('/repo', '[Task-55] t', 'b');

    expect(res.success).toBe(true);
    expect(res.prNumber).toBe(55);
    // 既存PR再利用なので runGhCommandWithBody は呼ばれないこと
    expect(ghWithBodyCalls).toHaveLength(0);
  });
});

describe('createBranch — worktree使用中チェック', () => {
  // NOTE: findConflictingWorktreeForBranch is fully mocked via worktree-guard mock.
  // Each test controls the return value through conflictingWorktreePath.

  test('別worktreeで使用中のブランチはcheckoutせずfalseを返すこと', async () => {
    conflictingWorktreePath = '/other-wt';
    script = [
      { match: /git branch --list chore\/update-refactor$/, result: 'chore/update-refactor\n' },
    ];

    const result = await createBranch('/working-dir', 'chore/update-refactor');

    expect(result).toBe(false);
    // checkout を試みないこと
    expect(calls.some((c) => /git checkout chore\/update-refactor$/.test(c))).toBe(false);
  });

  test('自分自身が同ブランチ上にある場合はcheckoutを続行してtrueを返すこと', async () => {
    // conflictingWorktreePath = null (デフォルト) → 競合なし → checkout 続行
    script = [
      { match: /git branch --list feature\/mine$/, result: 'feature/mine\n' },
      { match: /git checkout feature\/mine$/, result: '' },
    ];

    const result = await createBranch('/working-dir', 'feature/mine');

    expect(result).toBe(true);
    // 自分自身が使用中でも checkout を実行すること
    expect(calls.some((c) => /git checkout feature\/mine$/.test(c))).toBe(true);
  });

  test('どのworktreeも対象ブランチを使用していなければcheckoutを実行してtrueを返すこと', async () => {
    // conflictingWorktreePath = null (デフォルト) → 競合なし
    script = [
      { match: /git branch --list feature\/other$/, result: 'feature/other\n' },
      { match: /git checkout feature\/other$/, result: '' },
    ];

    const result = await createBranch('/working-dir', 'feature/other');

    expect(result).toBe(true);
    expect(calls.some((c) => /git checkout feature\/other$/.test(c))).toBe(true);
  });

  test('findConflictingWorktreeForBranch がnullを返す場合（list失敗fail-safe含む）checkoutを試みること', async () => {
    // conflictingWorktreePath = null はworktree list失敗時のfail-safe戻り値と同等
    script = [
      { match: /git branch --list feature\/list-fail$/, result: 'feature/list-fail\n' },
      { match: /git checkout feature\/list-fail$/, result: '' },
    ];

    const result = await createBranch('/working-dir', 'feature/list-fail');

    expect(result).toBe(true);
    // null 返却後も checkout を実行していること
    expect(calls.some((c) => /git checkout feature\/list-fail$/.test(c))).toBe(true);
  });

  test('git checkout には短めのタイムアウトが設定されること (#809)', async () => {
    script = [
      {
        match: /git branch --list feature\/checkout-timeout$/,
        result: 'feature/checkout-timeout\n',
      },
      { match: /git checkout feature\/checkout-timeout$/, result: '' },
    ];

    await createBranch('/working-dir', 'feature/checkout-timeout');

    const checkoutCall = callOpts.find((c) =>
      /^git checkout feature\/checkout-timeout$/.test(c.cmd),
    );
    expect(checkoutCall?.opts.timeout).toBe(60_000);
  });

  test('新規ブランチ作成（-b）は worktree チェックなしで実行されること（回帰確認）', async () => {
    script = [
      { match: /git branch --list feature\/new-branch$/, result: '' }, // 存在しない
      { match: /git checkout -b feature\/new-branch$/, result: '' },
    ];

    const result = await createBranch('/working-dir', 'feature/new-branch');

    expect(result).toBe(true);
    expect(calls.some((c) => /git checkout -b feature\/new-branch$/.test(c))).toBe(true);
    // 新規ブランチは使用中チェック不要なので worktree prune/list を child_process 経由では呼ばないこと
    expect(calls.some((c) => /worktree/.test(c))).toBe(false);
  });
});

describe('mergePullRequest — worktree使用中チェック', () => {
  test('baseBranchが別worktreeで使用中の場合syncをスキップしてsuccess:trueを返すこと', async () => {
    conflictingWorktreePath = '/other-wt';
    script = [
      { match: /pr view \d+ --json commits/, result: '3\n' },
      {
        match: /pr view \d+ --json number,state,mergedAt,baseRefName/,
        result: JSON.stringify({
          number: 1,
          state: 'MERGED',
          mergedAt: '2026-09-09T00:00:00Z',
          baseRefName: 'develop',
        }),
      },
      { match: /pr merge \d+ --merge --delete-branch/, result: '' },
    ];

    const result = await mergePullRequest('/working-dir', 1, 5, 'develop');

    expect(result.success).toBe(true);
    expect(result.mergeStrategy).toBe('merge');
    // checkout は実行されないこと
    expect(calls.some((c) => /git checkout develop$/.test(c))).toBe(false);
    expect(calls.some((c) => /git pull$/.test(c))).toBe(false);
  });

  test('baseBranchが未使用の場合はcheckout+pullを実行してsuccess:trueを返すこと', async () => {
    // conflictingWorktreePath = null (デフォルト) → 競合なし
    script = [
      { match: /pr view \d+ --json commits/, result: '3\n' },
      {
        match: /pr view \d+ --json number,state,mergedAt,baseRefName/,
        result: JSON.stringify({
          number: 1,
          state: 'MERGED',
          mergedAt: '2026-09-09T00:00:00Z',
          baseRefName: 'develop',
        }),
      },
      { match: /pr merge \d+ --merge --delete-branch/, result: '' },
      { match: /git checkout develop$/, result: '' },
      { match: /git pull$/, result: '' },
    ];

    const result = await mergePullRequest('/working-dir', 1, 5, 'develop');

    expect(result.success).toBe(true);
    expect(calls.some((c) => /git checkout develop$/.test(c))).toBe(true);
    expect(calls.some((c) => /git pull$/.test(c))).toBe(true);
  });

  test('post-merge の checkout は短め、pull は長めのタイムアウトになること (#809)', async () => {
    script = [
      { match: /pr view \d+ --json commits/, result: '3\n' },
      {
        match: /pr view \d+ --json number,state,mergedAt,baseRefName/,
        result: JSON.stringify({
          number: 1,
          state: 'MERGED',
          mergedAt: '2026-09-09T00:00:00Z',
          baseRefName: 'develop',
        }),
      },
      { match: /pr merge \d+ --merge --delete-branch/, result: '' },
      { match: /git checkout develop$/, result: '' },
      { match: /git pull$/, result: '' },
    ];

    await mergePullRequest('/working-dir', 1, 5, 'develop');

    const checkoutCall = callOpts.find((c) => /^git checkout develop$/.test(c.cmd));
    const pullCall = callOpts.find((c) => /^git pull$/.test(c.cmd));
    expect(checkoutCall?.opts.timeout).toBe(60_000);
    expect(pullCall?.opts.timeout).toBe(120_000);
  });
});
