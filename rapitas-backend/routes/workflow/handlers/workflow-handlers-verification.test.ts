/**
 * workflow-handlers-verification.test
 *
 * Unit tests for the implementer self-verification endpoint handler:
 * invalid id, missing worktree, happy path, gate error, the per-task
 * in-flight guard (including the synchronous-reservation regression), and
 * the content-aware result cache (including real-git regressions for the
 * task 897 supervisor-found key-collision defect). Most collaborators are
 * mocked; the final describe block exercises real git subprocess calls
 * against a throwaway repo.
 */
import { describe, it, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// headCounter is bumped in beforeEach so every test gets a distinct HEAD by
// default — the cache is a module-level singleton shared across all `it()`
// blocks in this file, so without this, an earlier test's cached entry for
// the same taskId would silently serve stale results here.
let headCounter = 0;
// gitDiffOutput is the canned `git diff HEAD` response. gitDiffSequence, when
// set, overrides it and returns successive values per call — used to
// simulate the worktree changing content BETWEEN the pre- and post-run key
// computations inside a single handleRunVerification invocation.
let gitDiffOutput = '';
let gitDiffSequence: string[] | null = null;
let diffCallCount = 0;
let gitUntrackedOutput = '';

const cannedRunGitCommand = async (args: string[]): Promise<string> => {
  if (args[0] === 'rev-parse') return `head-${headCounter}`;
  if (args[0] === 'diff') {
    if (gitDiffSequence) {
      const v = gitDiffSequence[Math.min(diffCallCount, gitDiffSequence.length - 1)];
      diffCallCount += 1;
      return v;
    }
    return gitDiffOutput;
  }
  if (args[0] === 'ls-files') return gitUntrackedOutput;
  return '';
};
const runGitCommandMock = mock(cannedRunGitCommand);
mock.module('../../../services/github/git-exec', () => ({
  runGitCommand: runGitCommandMock,
}));

const findFirstMock = mock(async (): Promise<unknown> => null);
const taskFindUniqueMock = mock(async (): Promise<unknown> => null);

mock.module('../../../config', () => ({
  prisma: {
    agentSession: { findFirst: findFirstMock },
    task: { findUnique: taskFindUniqueMock },
  },
}));

mock.module('../../../config/logger', () => ({
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

mock.module('../../../services/agents/verification/automated-verifier', () => ({
  runAutomatedVerification: runAutomatedVerificationMock,
  renderVerificationMarkdown: renderVerificationMarkdownMock,
  // Mirrors the real detector closely enough for the requireTests tests.
  looksLikeBugFixTask: (text: string | null | undefined) =>
    !!text && /(バグ|不具合|クラッシュ|\bbug\b|\bcrash\b)/i.test(text),
}));

const readWorkflowFileMock = mock(async (): Promise<string | null> => null);
mock.module('../../../services/workflow/workflow-file-utils', () => ({
  readWorkflowFile: readWorkflowFileMock,
}));

const resolvePreferredBaseBranchMock = mock(async (): Promise<string | null> => 'develop');
mock.module('../../../services/task/task-resolver', () => ({
  resolvePreferredBaseBranch: resolvePreferredBaseBranchMock,
}));

const { handleRunVerification, computeVerificationCacheKey } =
  await import('./workflow-handlers-verification');

function ctx(taskId: string) {
  return { params: { taskId }, set: {} as { status?: number | string } };
}

beforeEach(() => {
  findFirstMock.mockClear();
  taskFindUniqueMock.mockClear();
  runAutomatedVerificationMock.mockClear();
  renderVerificationMarkdownMock.mockClear();
  readWorkflowFileMock.mockClear();
  resolvePreferredBaseBranchMock.mockClear();
  runGitCommandMock.mockClear();
  // A prior test (e.g. the git-unavailable case) may have overridden the
  // implementation via mockImplementation, which mockClear() does NOT undo —
  // without this reset, that override silently leaks into every later test
  // in the file (observed: made the mid-run-change regression below pass
  // even with the before/after comparison it's meant to guard removed,
  // because the leaked "always throw" implementation disabled caching
  // entirely regardless of the fix under test).
  runGitCommandMock.mockImplementation(cannedRunGitCommand);
  headCounter += 1;
  gitDiffOutput = '';
  gitDiffSequence = null;
  diffCallCount = 0;
  gitUntrackedOutput = '';
  findFirstMock.mockImplementation(async () => ({ worktreePath: 'C:/wt/task-1' }));
  taskFindUniqueMock.mockImplementation(async () => null);
  runAutomatedVerificationMock.mockImplementation(async () => ({
    ok: true,
    summary: 'ok',
    checks: [],
  }));
});

describe('handleRunVerification', () => {
  it('rejects a non-numeric task id with 400', async () => {
    const c = ctx('abc');
    const res = await handleRunVerification(c);
    expect(c.set.status).toBe(400);
    expect(res).toMatchObject({ success: false });
  });

  it('returns 404 when the task has no worktree session', async () => {
    findFirstMock.mockImplementation(async () => null);
    const c = ctx('7');
    const res = await handleRunVerification(c);
    expect(c.set.status).toBe(404);
    expect(res).toMatchObject({ success: false });
  });

  it('runs the gate on the worktree and returns the measured result', async () => {
    readWorkflowFileMock.mockImplementation(async () => '# plan');
    const c = ctx('7');
    const res = await handleRunVerification(c);
    expect(res).toMatchObject({ success: true, ok: true, summary: 'ok' });
    expect(runAutomatedVerificationMock).toHaveBeenCalledWith(
      'C:/wt/task-1',
      expect.objectContaining({ planContent: '# plan', preferredBaseBranch: 'develop', taskId: 7 }),
    );
    expect(renderVerificationMarkdownMock).toHaveBeenCalledTimes(1);
  });

  it('forces requireTests and passes criteria/taskText for a bug-fix task', async () => {
    taskFindUniqueMock.mockImplementation(async () => ({
      title: '保存時にクラッシュするバグの修正',
      description: '## 受入基準\n- `services/foo/bar.ts` の修正で再現テストが通る',
      acceptanceCriteria: null,
    }));
    const res = await handleRunVerification(ctx('7'));
    expect(res).toMatchObject({ success: true, ok: true });
    expect(runAutomatedVerificationMock).toHaveBeenCalledWith(
      'C:/wt/task-1',
      expect.objectContaining({
        requireTests: true,
        acceptanceCriteria: ['`services/foo/bar.ts` の修正で再現テストが通る'],
        taskText: expect.stringContaining('保存時にクラッシュするバグの修正'),
      }),
    );
  });

  it('does not force requireTests for a non-bug-fix task', async () => {
    taskFindUniqueMock.mockImplementation(async () => ({
      title: '新しいダッシュボード widget を追加する',
      description: '説明のみ（受入基準の見出しなし）',
      acceptanceCriteria: null,
    }));
    await handleRunVerification(ctx('7'));
    expect(runAutomatedVerificationMock).toHaveBeenCalledWith(
      'C:/wt/task-1',
      expect.objectContaining({ requireTests: false }),
    );
    // No criteria resolvable → the option is omitted (acceptance stays fail-open).
    const opts = (runAutomatedVerificationMock.mock.calls[0] as unknown[])[1] as Record<
      string,
      unknown
    >;
    expect(opts.acceptanceCriteria).toBeUndefined();
  });

  it('runs the gate with defaults when the task row cannot be loaded', async () => {
    taskFindUniqueMock.mockImplementation(async () => {
      throw new Error('db down');
    });
    const res = await handleRunVerification(ctx('7'));
    expect(res).toMatchObject({ success: true, ok: true });
    expect(runAutomatedVerificationMock).toHaveBeenCalledWith(
      'C:/wt/task-1',
      expect.objectContaining({ requireTests: false }),
    );
  });

  it('passes a failing gate result through as ok:false (not an error)', async () => {
    runAutomatedVerificationMock.mockImplementation(async () => ({
      ok: false,
      summary: 'lint failed',
      checks: [{ name: 'lint', ok: false }],
    }));
    const res = await handleRunVerification(ctx('7'));
    expect(res).toMatchObject({ success: true, ok: false, summary: 'lint failed' });
  });

  it('returns 500 when the gate itself throws, and releases the in-flight slot', async () => {
    runAutomatedVerificationMock.mockImplementation(async () => {
      throw new Error('boom');
    });
    const c = ctx('7');
    const res = await handleRunVerification(c);
    expect(c.set.status).toBe(500);
    expect(res).toMatchObject({ success: false });
    // Slot released — a follow-up run must reach the gate again.
    runAutomatedVerificationMock.mockImplementation(async () => ({
      ok: true,
      summary: 'ok',
      checks: [],
    }));
    const res2 = await handleRunVerification(ctx('7'));
    expect(res2).toMatchObject({ success: true, ok: true });
  });

  it('rejects a concurrent run for the same task with 429', async () => {
    let release: (() => void) | undefined;
    runAutomatedVerificationMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, summary: 'ok', checks: [] });
        }),
    );
    const first = handleRunVerification(ctx('9'));
    // Give the first call a tick to acquire the slot before the second tries.
    await new Promise((r) => setTimeout(r, 10));
    const c2 = ctx('9');
    const res2 = await handleRunVerification(c2);
    expect(c2.set.status).toBe(429);
    expect(res2).toMatchObject({ success: false });
    release?.();
    const res1 = await first;
    expect(res1).toMatchObject({ success: true, ok: true });
  });

  describe('回帰(task897 監督差戻し): inFlight の同期予約', () => {
    it('session読み取りが保留中でも同一taskへの2件目は即429（awaitより前にinFlight予約）', async () => {
      // Every findFirstMock invocation gets its own resolver pushed here —
      // if the admission guard regresses and a 2nd request slips through to
      // its own session lookup, that lookup would otherwise hang forever
      // (only the LAST resolver would ever be reachable), turning a logic
      // regression into a test timeout instead of a clean assertion failure.
      const releaseSessions: Array<() => void> = [];
      findFirstMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseSessions.push(() => resolve({ worktreePath: 'C:/wt/task-1' }));
          }),
      );
      const first = handleRunVerification(ctx('55'));
      // A pending session lookup used to leave inFlight.add unreached until
      // AFTER this await resolved — a concurrent request in that window was
      // wrongly admitted (no 429). This tick proves the reservation already
      // happened before the session promise settles.
      await new Promise((r) => setTimeout(r, 5));
      const c2 = ctx('55');
      const res2 = await handleRunVerification(c2);
      expect(c2.set.status).toBe(429);
      expect(res2).toMatchObject({ success: false });
      // Only ONE session lookup should ever have been started — the second
      // request must be rejected by the inFlight guard before it reaches
      // this await at all.
      expect(findFirstMock).toHaveBeenCalledTimes(1);
      releaseSessions.forEach((release) => release());
      const res1 = await first;
      expect(res1).toMatchObject({ success: true });
    });

    it('404(worktreeなし)応答の直後は同一taskへの再要求が429で固着しない', async () => {
      findFirstMock.mockImplementation(async () => null);
      const c1 = ctx('56');
      const res1 = await handleRunVerification(c1);
      expect(c1.set.status).toBe(404);
      expect(res1).toMatchObject({ success: false });

      findFirstMock.mockImplementation(async () => ({ worktreePath: 'C:/wt/task-1' }));
      const c2 = ctx('56');
      const res2 = await handleRunVerification(c2);
      expect(c2.set.status).toBeUndefined();
      expect(res2).toMatchObject({ success: true });
    });
  });

  describe('result cache (content-aware identity)', () => {
    it('returns the cached result without re-running the gate when the identity is unchanged', async () => {
      const c1 = ctx('101');
      const res1 = await handleRunVerification(c1);
      expect(res1).toMatchObject({ success: true, ok: true, cached: false });
      expect(runAutomatedVerificationMock).toHaveBeenCalledTimes(1);

      const c2 = ctx('101');
      const res2 = await handleRunVerification(c2);
      expect(res2).toMatchObject({ success: true, ok: true, cached: true });
      // Gate was not invoked again — the cached response was served instead.
      expect(runAutomatedVerificationMock).toHaveBeenCalledTimes(1);
    });

    it('re-runs the gate when HEAD changes between requests', async () => {
      await handleRunVerification(ctx('102'));
      expect(runAutomatedVerificationMock).toHaveBeenCalledTimes(1);

      headCounter += 1; // simulate a new commit landing in the worktree
      const res2 = await handleRunVerification(ctx('102'));
      expect(res2).toMatchObject({ success: true, cached: false });
      expect(runAutomatedVerificationMock).toHaveBeenCalledTimes(2);
    });

    it('re-runs the gate when tracked working-tree content changes between requests', async () => {
      gitDiffOutput = 'diff --git a/x b/x\n-old\n+v1\n';
      await handleRunVerification(ctx('103'));
      expect(runAutomatedVerificationMock).toHaveBeenCalledTimes(1);

      // Same status-visible "M x" line in real git terms, but the actual
      // content differs — this is the task 897 supervisor-found collision
      // class (`git status --porcelain` alone cannot distinguish these).
      gitDiffOutput = 'diff --git a/x b/x\n-old\n+v2\n';
      const res2 = await handleRunVerification(ctx('103'));
      expect(res2).toMatchObject({ success: true, cached: false });
      expect(runAutomatedVerificationMock).toHaveBeenCalledTimes(2);
    });

    it('never caches and always re-runs when git is unavailable (fail-safe)', async () => {
      runGitCommandMock.mockImplementation(async () => {
        throw new Error('git not found');
      });
      await handleRunVerification(ctx('104'));
      await handleRunVerification(ctx('104'));
      expect(runAutomatedVerificationMock).toHaveBeenCalledTimes(2);
    });

    it('回帰(task897): 検証実行中に内容が変化した場合は結果を保存しない', async () => {
      // keyBefore is computed from the first `diff` call ('diff-before'),
      // keyAfter from the second ('diff-after') — simulating the implementer
      // editing the worktree WHILE the gate (which can take minutes) was
      // still running. Because they mismatch, the result must NOT be cached
      // under keyBefore.
      gitDiffSequence = ['diff-before', 'diff-after'];
      const res1 = await handleRunVerification(ctx('105'));
      expect(res1).toMatchObject({ success: true, cached: false });
      expect(runAutomatedVerificationMock).toHaveBeenCalledTimes(1);

      // This request's own before/after pair is stable and IDENTICAL to
      // request 1's keyBefore ('diff-before', same HEAD, same task inputs).
      // If request 1 had wrongly cached under keyBefore, this would be a
      // cache hit (cached:true, gate not re-invoked). It must instead be a
      // miss — proving request 1's mismatched pass was never stored.
      gitDiffSequence = null;
      gitDiffOutput = 'diff-before';
      const res2 = await handleRunVerification(ctx('105'));
      expect(res2).toMatchObject({ success: true, cached: false });
      expect(runAutomatedVerificationMock).toHaveBeenCalledTimes(2);
    });

    it('回帰(task897 監督差戻し): 検証実行中にDB側のplan内容が変わった場合は結果を保存しない', async () => {
      // Request 1: buildCacheInputs' plan read returns 'plan v1' the FIRST
      // time (before the gate runs) and 'plan v2' the SECOND time (after) —
      // simulating a plan.md edit landing in the DB while the gate (which can
      // take minutes) was still running. Rehashing the SAME in-memory
      // `cacheInputsBefore` object would never observe this; only a genuine
      // re-fetch does.
      readWorkflowFileMock.mockImplementationOnce(async () => 'plan v1');
      readWorkflowFileMock.mockImplementationOnce(async () => 'plan v2');
      const res1 = await handleRunVerification(ctx('106'));
      expect(res1).toMatchObject({ success: true, cached: false });
      expect(runAutomatedVerificationMock).toHaveBeenCalledTimes(1);

      // Request 2 has a STABLE 'plan v1' identity for both its own before
      // and after reads — deliberately identical to request 1's keyBefore.
      // If request 1 had wrongly cached under that keyBefore (ignoring the
      // after-mismatch), this would be a cache hit. It must instead re-run
      // the gate, proving request 1's mismatched pass was never stored.
      readWorkflowFileMock.mockImplementationOnce(async () => 'plan v1');
      readWorkflowFileMock.mockImplementationOnce(async () => 'plan v1');
      const res2 = await handleRunVerification(ctx('106'));
      expect(res2).toMatchObject({ success: true, cached: false });
      expect(runAutomatedVerificationMock).toHaveBeenCalledTimes(2);
    });
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
    runGitCommandMock.mockImplementation(cannedRunGitCommand);
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
