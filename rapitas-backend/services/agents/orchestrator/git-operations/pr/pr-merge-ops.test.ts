/**
 * pr-merge-ops — readAuthoritativeMergeState ユニットテスト (task 895)
 *
 * 「既にマージ済みか」を GitHub に直接確認する読み取り専用APIが、MERGED /
 * OPEN / gh実行失敗 / 壊れたJSON をそれぞれ正しく返すことを検証する。
 * マージ操作を行わないこと（gh の引数が pr view のみ）も確認する。
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

mock.module('../../../../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

type ExecArgs = { file: string; args: string[] };
const execCalls: ExecArgs[] = [];
let execFixture: { stdout: string } | Error = { stdout: '' };
mock.module('child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void,
  ) => {
    execCalls.push({ file, args });
    if (execFixture instanceof Error) cb(execFixture);
    else cb(null, { stdout: execFixture.stdout, stderr: '' });
  },
}));

mock.module('../worktree/worktree-guard', () => ({
  isPrimaryWorkTree: () => Promise.resolve(false),
  findConflictingWorktreeForBranch: () => Promise.resolve(null),
  recoverFromUnresolvedMerge: () => Promise.resolve(),
}));
mock.module('../../../../github/gh-retry', () => ({
  isHeadBehindError: () => false,
  isAlreadyUpToDate: () => false,
}));
mock.module('./gh-cli-path', () => ({ ghPath: () => 'gh' }));

const { readAuthoritativeMergeState } = await import('./pr-merge-ops');

beforeEach(() => {
  execCalls.length = 0;
});

describe('readAuthoritativeMergeState', () => {
  test('supervisor: explicit repository survives an unrelated fallback cwd', async () => {
    execFixture = { stdout: JSON.stringify({ number: 621, state: 'OPEN' }) };
    await readAuthoritativeMergeState('C:\\unrelated', 621, 'acme/repo');
    expect(execCalls[0]!.args.slice(-2)).toEqual(['--repo', 'acme/repo']);
  });
  test('MERGED の PR は state と mergedAt を返す', async () => {
    execFixture = {
      stdout: JSON.stringify({
        number: 621,
        state: 'MERGED',
        mergedAt: '2026-09-08T02:27:44Z',
        baseRefName: 'develop',
      }),
    };

    const result = await readAuthoritativeMergeState('C:\\repo', 621);

    expect(result).toEqual({
      number: 621,
      state: 'MERGED',
      mergedAt: '2026-09-08T02:27:44Z',
      baseRefName: 'develop',
    });
  });

  test('読み取り専用: gh pr view のみを実行し、merge 系サブコマンドを呼ばない', async () => {
    execFixture = { stdout: JSON.stringify({ number: 621, state: 'OPEN', mergedAt: null }) };

    await readAuthoritativeMergeState('C:\\repo', 621);

    expect(execCalls.length).toBe(1);
    expect(execCalls[0]!.args.slice(0, 2)).toEqual(['pr', 'view']);
    expect(execCalls[0]!.args).not.toContain('merge');
  });

  test('OPEN の PR は state=OPEN / mergedAt=null を返す', async () => {
    execFixture = {
      stdout: JSON.stringify({
        number: 621,
        state: 'OPEN',
        mergedAt: null,
        baseRefName: 'develop',
      }),
    };

    const result = await readAuthoritativeMergeState('C:\\repo', 621);

    expect(result?.state).toBe('OPEN');
    expect(result?.mergedAt).toBeNull();
  });

  test('gh 実行失敗時は null', async () => {
    execFixture = new Error('gh: not authenticated');
    expect(await readAuthoritativeMergeState('C:\\repo', 621)).toBeNull();
  });

  test('JSONが壊れている / 必須フィールド欠落なら null', async () => {
    execFixture = { stdout: 'not json' };
    expect(await readAuthoritativeMergeState('C:\\repo', 621)).toBeNull();
    execFixture = { stdout: JSON.stringify({ state: 'MERGED' }) };
    expect(await readAuthoritativeMergeState('C:\\repo', 621)).toBeNull();
  });
});
