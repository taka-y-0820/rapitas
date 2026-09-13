/**
 * verification-job-runner.test
 *
 * Unit tests for the fast/slow split: beginVerificationRun records a start
 * event and returns a runId without running the gate; runVerificationGateAndRecord
 * runs the gate and records completed/failed/unverifiable finish events.
 * Also covers computeVerificationCacheKey's real-git regressions (moved here
 * unchanged from workflow-handlers-verification.test.ts — task 899 moved the
 * function, not its logic).
 */
import { describe, it, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const runGitCommandMock = mock(async (args: string[]) => {
  if (args[0] === 'rev-parse') return 'head-1';
  if (args[0] === 'diff') return '';
  if (args[0] === 'ls-files') return '';
  return '';
});
mock.module('../github/git-exec', () => ({ runGitCommand: runGitCommandMock }));

const findUniqueMock = mock(async () => ({
  title: 'Feature',
  description: '',
  acceptanceCriteria: null,
}));
mock.module('../../config', () => ({
  prisma: { task: { findUnique: findUniqueMock } },
}));

mock.module('../../config/logger', () => ({
  createLogger: () => ({ info: mock(() => {}), warn: mock(() => {}), debug: mock(() => {}) }),
}));

const runAutomatedVerificationMock = mock(
  async (): Promise<{ ok: boolean; summary: string; checks: unknown[] }> => ({
    ok: true,
    summary: 'ok',
    checks: [],
  }),
);
const renderVerificationMarkdownMock = mock(() => '# 自動検証\nok');
mock.module('../agents/verification/automated-verifier', () => ({
  runAutomatedVerification: runAutomatedVerificationMock,
  renderVerificationMarkdown: renderVerificationMarkdownMock,
  looksLikeBugFixTask: () => false,
}));

const readWorkflowFileMock = mock(async (): Promise<string | null> => null);
mock.module('./workflow-file-utils', () => ({ readWorkflowFile: readWorkflowFileMock }));

const resolvePreferredBaseBranchMock = mock(async (): Promise<string | null> => 'develop');
mock.module('../task/task-resolver', () => ({
  resolvePreferredBaseBranch: resolvePreferredBaseBranchMock,
}));

const recordJobStartMock = mock(async () => {});
const recordJobFinishMock = mock(async () => {});
mock.module('./verification-job-store', () => ({
  recordJobStart: recordJobStartMock,
  recordJobFinish: recordJobFinishMock,
}));

const { beginVerificationRun, runVerificationGateAndRecord, computeVerificationCacheKey } =
  await import('./verification-job-runner');

beforeEach(() => {
  runGitCommandMock.mockClear();
  findUniqueMock.mockClear();
  runAutomatedVerificationMock.mockClear();
  renderVerificationMarkdownMock.mockClear();
  readWorkflowFileMock.mockClear();
  resolvePreferredBaseBranchMock.mockClear();
  recordJobStartMock.mockClear();
  recordJobFinishMock.mockClear();
  runGitCommandMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'rev-parse') return 'head-1';
    if (args[0] === 'diff') return '';
    if (args[0] === 'ls-files') return '';
    return '';
  });
  runAutomatedVerificationMock.mockImplementation(async () => ({
    ok: true,
    summary: 'ok',
    checks: [],
  }));
});

describe('beginVerificationRun', () => {
  it('runId を生成し recordJobStart を正しい引数で1回呼ぶ', async () => {
    const result = await beginVerificationRun(1, 'C:/wt/task-1');
    expect(typeof result.runId).toBe('string');
    expect(result.runId.length).toBeGreaterThan(0);
    expect(recordJobStartMock).toHaveBeenCalledTimes(1);
    expect(recordJobStartMock).toHaveBeenCalledWith(1, result.runId, expect.any(String), {
      operation: 'POST /workflow/tasks/1/run-verification',
      worktreePath: 'C:/wt/task-1',
      revision: 'head-1',
    });
    // The gate itself must NOT run in the fast path.
    expect(runAutomatedVerificationMock).not.toHaveBeenCalled();
  });
});

describe('runVerificationGateAndRecord', () => {
  it('正常系で recordJobFinish に status:completed, ok:true を渡す', async () => {
    const { cacheInputsBefore, keyBefore } = await beginVerificationRun(2, 'C:/wt/task-2');
    await runVerificationGateAndRecord(2, 'run-x', 'C:/wt/task-2', cacheInputsBefore, keyBefore);
    expect(recordJobFinishMock).toHaveBeenCalledTimes(1);
    const [taskId, runId, outcome] = recordJobFinishMock.mock.calls[0] as [
      number,
      string,
      { status: string; ok?: boolean; unverifiable?: boolean },
    ];
    expect(taskId).toBe(2);
    expect(runId).toBe('run-x');
    expect(outcome).toMatchObject({ status: 'completed', ok: true, unverifiable: false });
  });

  it('runAutomatedVerification が例外を投げた場合 status:failed で記録する', async () => {
    runAutomatedVerificationMock.mockImplementation(async () => {
      throw new Error('gate crashed');
    });
    const { cacheInputsBefore, keyBefore } = await beginVerificationRun(3, 'C:/wt/task-3');
    await runVerificationGateAndRecord(3, 'run-y', 'C:/wt/task-3', cacheInputsBefore, keyBefore);
    expect(recordJobFinishMock).toHaveBeenCalledTimes(1);
    const [, , outcome] = recordJobFinishMock.mock.calls[0] as [
      number,
      string,
      { status: string; error?: string },
    ];
    expect(outcome).toMatchObject({ status: 'failed', error: 'gate crashed' });
  });

  it('実行中に keyBefore と keyAfter が変わると unverifiable:true, ok:false で記録する', async () => {
    let diffCall = 0;
    runGitCommandMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') return 'head-1';
      if (args[0] === 'diff') {
        diffCall += 1;
        return diffCall === 1 ? 'diff-before' : 'diff-after';
      }
      if (args[0] === 'ls-files') return '';
      return '';
    });
    const { cacheInputsBefore, keyBefore } = await beginVerificationRun(4, 'C:/wt/task-4');
    await runVerificationGateAndRecord(4, 'run-z', 'C:/wt/task-4', cacheInputsBefore, keyBefore);
    expect(recordJobFinishMock).toHaveBeenCalledTimes(1);
    const [, , outcome] = recordJobFinishMock.mock.calls[0] as [
      number,
      string,
      { status: string; ok?: boolean; unverifiable?: boolean },
    ];
    expect(outcome).toMatchObject({ status: 'completed', ok: false, unverifiable: true });
  });
});

describe('beginVerificationRun (タスク行が取得できない場合)', () => {
  it('タスク行が存在しない(null)場合は例外を投げ、recordJobStart を呼ばない', async () => {
    findUniqueMock.mockImplementationOnce(async () => null);
    await expect(beginVerificationRun(13, 'C:/wt/task-13')).rejects.toThrow();
    expect(recordJobStartMock).not.toHaveBeenCalled();
  });

  it('タスク行取得が失敗(throw)した場合も例外を投げる', async () => {
    findUniqueMock.mockImplementationOnce(async () => {
      throw new Error('database unavailable');
    });
    await expect(beginVerificationRun(14, 'C:/wt/task-14')).rejects.toThrow();
    expect(recordJobStartMock).not.toHaveBeenCalled();
  });
});

describe('computeVerificationCacheKey (実git回帰: task897 監督差戻し)', () => {
  let repoDir: string;
  const realRunGitCommand = async (args: string[], cwd?: string): Promise<string> =>
    execFileSync('git', args, { cwd: cwd ?? repoDir, encoding: 'utf8' }).trim();

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'selfverify-cachekey-'));
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    writeFileSync(join(repoDir, 'app.txt'), 'initial\n');
    execFileSync('git', ['add', 'app.txt'], { cwd: repoDir });
    execFileSync('git', ['commit', '-q', '-m', 'root'], { cwd: repoDir });
    runGitCommandMock.mockImplementation(realRunGitCommand);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test('同一 dirty tracked ファイルの再編集で key が変わる（監督実測: git status --porcelain だけでは不変だった）', async () => {
    writeFileSync(join(repoDir, 'app.txt'), 'edit A\n');
    const keyA = await computeVerificationCacheKey({ worktreePath: repoDir, requireTests: false });
    writeFileSync(join(repoDir, 'app.txt'), 'edit B\n');
    const keyB = await computeVerificationCacheKey({ worktreePath: repoDir, requireTests: false });
    expect(keyA).not.toBeNull();
    expect(keyB).not.toBeNull();
    expect(keyA).not.toBe(keyB);
  });

  test('未追跡ファイルの内容変更で key が変わり、同一内容の再計算では不変', async () => {
    writeFileSync(join(repoDir, 'new.txt'), 'v1\n');
    const key1 = await computeVerificationCacheKey({ worktreePath: repoDir, requireTests: false });
    const key1Again = await computeVerificationCacheKey({
      worktreePath: repoDir,
      requireTests: false,
    });
    expect(key1).not.toBeNull();
    expect(key1).toBe(key1Again);

    writeFileSync(join(repoDir, 'new.txt'), 'v2\n');
    const key2 = await computeVerificationCacheKey({ worktreePath: repoDir, requireTests: false });
    expect(key2).not.toBe(key1);
  });

  test('クリーンな worktree なら2回の呼び出しで同一 key（非null）を返す', async () => {
    const keyA = await computeVerificationCacheKey({ worktreePath: repoDir, requireTests: false });
    const keyB = await computeVerificationCacheKey({ worktreePath: repoDir, requireTests: false });
    expect(keyA).not.toBeNull();
    expect(keyA).toBe(keyB);
  });

  test('未追跡合計サイズが安全弁の上限を超えると null を返す（キャッシュ回避）', async () => {
    writeFileSync(join(repoDir, 'big.bin'), Buffer.alloc(1024, 1));
    const prevLimit = process.env.RAPITAS_SELFVERIFY_MAX_UNTRACKED_BYTES;
    process.env.RAPITAS_SELFVERIFY_MAX_UNTRACKED_BYTES = '100';
    try {
      const key = await computeVerificationCacheKey({
        worktreePath: repoDir,
        requireTests: false,
      });
      expect(key).toBeNull();
    } finally {
      if (prevLimit === undefined) delete process.env.RAPITAS_SELFVERIFY_MAX_UNTRACKED_BYTES;
      else process.env.RAPITAS_SELFVERIFY_MAX_UNTRACKED_BYTES = prevLimit;
    }
  });

  test('検証入力（planContent等）が変われば同一worktreeでも key が変わる', async () => {
    const keyA = await computeVerificationCacheKey({
      worktreePath: repoDir,
      requireTests: false,
      planContent: 'plan A',
    });
    const keyB = await computeVerificationCacheKey({
      worktreePath: repoDir,
      requireTests: false,
      planContent: 'plan B',
    });
    expect(keyA).not.toBe(keyB);
  });

  test('回帰(task897 監督差戻し): 未追跡ファイルのフレーミング衝突 — 単一ファイル(NUL区切りを内容に含む)と複数ファイルで key が一致しない', async () => {
    // A single untracked file 'a' containing the raw bytes x\0b\0y reduces,
    // under the old `relPath + NUL + content + NUL` concatenation scheme, to
    // the exact same byte stream as two untracked files a='x' and b='y'
    // (both are `a\0x\0b\0y\0`) — reconfirmed against this file's own prior
    // implementation before this fix (both hashed to `c8d9a2ee...`).
    writeFileSync(join(repoDir, 'a'), Buffer.from([0x78, 0x00, 0x62, 0x00, 0x79]));
    const keySingleFileWithEmbeddedNuls = await computeVerificationCacheKey({
      worktreePath: repoDir,
      requireTests: false,
    });

    unlinkSync(join(repoDir, 'a'));
    writeFileSync(join(repoDir, 'a'), 'x');
    writeFileSync(join(repoDir, 'b'), 'y');
    const keyTwoFiles = await computeVerificationCacheKey({
      worktreePath: repoDir,
      requireTests: false,
    });

    expect(keySingleFileWithEmbeddedNuls).not.toBeNull();
    expect(keyTwoFiles).not.toBeNull();
    expect(keySingleFileWithEmbeddedNuls).not.toBe(keyTwoFiles);
  });

  test('回帰(task897 監督差戻し): 未追跡パスにシンボリックリンクが含まれる場合は null を返す（キャッシュ回避）', async () => {
    writeFileSync(join(repoDir, 'target.txt'), 'target content\n');
    // target.txt itself stays untracked too — only the link's presence
    // should matter, not whether the target is tracked.
    symlinkSync(join(repoDir, 'target.txt'), join(repoDir, 'link.txt'), 'file');
    const key = await computeVerificationCacheKey({ worktreePath: repoDir, requireTests: false });
    expect(key).toBeNull();
  });
});
