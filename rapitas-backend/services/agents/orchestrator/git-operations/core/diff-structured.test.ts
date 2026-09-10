// @ts-nocheck — Loosely-typed mock setup; types are not the concern of this test file.
/**
 * diff-structured.test
 *
 * getDiff の phantom ディレクトリガードを検証する。
 * 存在しない cwd を渡した場合、cmd.exe を spawn せず即 [] を返し、
 * logger.warn のみ出力すること（logger.error は出さない）を保証する。
 */
import { mock, describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Logger 呼び出しキャプチャ用コンテナ — mock.module の factory がクロージャで参照する
// ---------------------------------------------------------------------------

const warnCalls = [];
const errorCalls = [];

// ---------------------------------------------------------------------------
// Module mocks — dynamic import より前に登録する必要がある
// NOTE: 全エクスポートをミラーすること（process-global のため汚染を最小化）
// ---------------------------------------------------------------------------

mock.module('../../../../../config/logger', () => ({
  getBackendLogFilePath: (_stamp) => '/test/logs/backend.log',
  logger: {
    warn: () => {},
    error: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: (_b) => ({}),
  },
  createLogger: (_name) => ({
    warn: (...args) => {
      warnCalls.push(args);
    },
    error: (...args) => {
      errorCalls.push(args);
    },
    info: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: (_b) => ({}),
  }),
}));

// ---------------------------------------------------------------------------
// Dynamic import AFTER mocks are registered
// ---------------------------------------------------------------------------

const { getDiff } = await import('./diff-structured');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getDiff — phantom directory guard', () => {
  beforeEach(() => {
    warnCalls.length = 0;
    errorCalls.length = 0;
  });

  // Merged from 3 separate re-invocations of the same call into one test: each
  // originally re-ran getDiff() with an identical phantom path just to check a
  // different facet (return value / warn-not-error / warn payload shape) of the
  // same side effect — one call, multiple assertions, is equivalent and cheaper.
  test('phantom path → returns [], logs only warn (never error), tagging workingDirectory', async () => {
    const path = 'C:\\nonexistent\\phantom';
    const result = await getDiff(path, () => false);
    expect(result).toEqual([]);
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    expect(errorCalls.length).toBe(0);
    expect(warnCalls[0]?.[0]).toMatchObject({ workingDirectory: path });
  });

  test('empty string → returns []', async () => {
    const result = await getDiff('', () => false);
    expect(result).toEqual([]);
  });
});

// Real git repo fixtures (no mocking) — getDiff has no injection point for the
// git commands themselves, only for the pathExists check, so these exercise
// the real `exec` calls end to end.
describe('getDiff — untracked files (real git repo)', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'getdiff-test-'));
    execSync('git init -q', { cwd: repoDir });
    execSync('git config user.email "test@example.com"', { cwd: repoDir });
    execSync('git config user.name "Test"', { cwd: repoDir });
    writeFileSync(join(repoDir, 'README.md'), 'initial\n');
    execSync('git add README.md', { cwd: repoDir });
    execSync('git commit -q -m "initial"', { cwd: repoDir });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  // Regression (task 504): a genuinely new, substantial untracked file was
  // reported as additions=0/deletions=0 with an empty patch — indistinguishable
  // from a truly empty file — because `git diff <ref> -- <file>` yields nothing
  // for a file git has never tracked. The adversarial diff-review judge read
  // this as "the implementation is empty" and blocked a fully working PR.
  test('reports real line counts and a synthetic patch for an untracked file, not 0/0/empty', async () => {
    writeFileSync(join(repoDir, 'newfile.go'), 'package main\n\nfunc main() {}\n');
    const result = await getDiff(repoDir);
    const entry = result.find((f) => f.filename === 'newfile.go');
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('added');
    expect(entry?.additions).toBe(3);
    expect(entry?.deletions).toBe(0);
    expect(entry?.patch).toContain('+package main');
    expect(entry?.patch).toContain('+func main() {}');
    expect(entry?.patch).toContain('new file mode');
  });

  test('does not count a phantom extra line for a file with a trailing newline', async () => {
    writeFileSync(join(repoDir, 'a.txt'), 'line1\nline2\n');
    const result = await getDiff(repoDir);
    const entry = result.find((f) => f.filename === 'a.txt');
    expect(entry?.additions).toBe(2);
  });

  test('counts the final line correctly when the file has no trailing newline', async () => {
    writeFileSync(join(repoDir, 'b.txt'), 'line1\nline2');
    const result = await getDiff(repoDir);
    const entry = result.find((f) => f.filename === 'b.txt');
    expect(entry?.additions).toBe(2);
  });
});

// Regression (task 506): a stale/divergent 'develop' branch made the
// develop→main→master GUESS land on an ancient common ancestor, pulling
// unrelated commits merged into the real base branch since into "this task's
// diff" — misread as scope creep / tampering by downstream reviewers.
// preferredBaseBranch (the worktree's ACTUAL fork point, e.g.
// AgentExecutionConfig.targetBranch) must be tried BEFORE the guess.
describe('getDiff — preferredBaseBranch overrides the develop/main/master guess', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'getdiff-basebranch-test-'));
    const run = (cmd) => execSync(cmd, { cwd: repoDir });
    run('git init -q');
    run('git config user.email "test@example.com"');
    run('git config user.name "Test"');

    // Root commit — shared ancestor of every branch below.
    writeFileSync(join(repoDir, 'README.md'), 'initial\n');
    run('git add README.md');
    run('git commit -q -m "root"');

    // 'develop' branches off HERE and is never updated again (stale/frozen).
    run('git branch develop');

    // 'main' keeps moving: two unrelated commits land on it AFTER develop
    // diverged — simulating other features merged while develop went stale.
    writeFileSync(join(repoDir, 'unrelated-feature-b.txt'), 'feature B\n');
    run('git add unrelated-feature-b.txt');
    run('git commit -q -m "unrelated feature B"');
    writeFileSync(join(repoDir, 'unrelated-feature-c.txt'), 'feature C\n');
    run('git add unrelated-feature-c.txt');
    run('git commit -q -m "unrelated feature C"');
    run('git branch main-track'); // capture "main"'s tip without renaming HEAD

    // The task's own branch is cut from main-track (i.e. real 'main'), then
    // gets ONE real change.
    run('git checkout -q -b feature/task');
    writeFileSync(join(repoDir, 'task-change.txt'), 'the actual task change\n');
    run('git add task-change.txt');
    run('git commit -q -m "task change"');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test('without preferredBaseBranch, the develop guess pulls in unrelated pre-existing commits', async () => {
    const result = await getDiff(repoDir);
    const filenames = result.map((f) => f.filename);
    // The bug: merge-base against stale 'develop' lands at the root, so both
    // "unrelated" commits (never touched by this task) leak into the diff.
    expect(filenames).toContain('unrelated-feature-b.txt');
    expect(filenames).toContain('unrelated-feature-c.txt');
    expect(filenames).toContain('task-change.txt');
  });

  test('with preferredBaseBranch="main-track", only the task\'s own change is in the diff', async () => {
    const result = await getDiff(repoDir, undefined, 'main-track');
    const filenames = result.map((f) => f.filename);
    expect(filenames).toEqual(['task-change.txt']);
    expect(filenames).not.toContain('unrelated-feature-b.txt');
    expect(filenames).not.toContain('unrelated-feature-c.txt');
  });

  test('an unsafe/malformed preferredBaseBranch is ignored, falling back to the guess', async () => {
    const result = await getDiff(repoDir, undefined, '; rm -rf /');
    const filenames = result.map((f) => f.filename);
    // Falls through to the develop guess (same as the no-preference case) —
    // proves the malformed value never reached the shell-interpolated git call.
    expect(filenames).toContain('unrelated-feature-b.txt');
  });
});

// Regression (task 516): origin/<preferredBaseBranch> AHEAD of the bare local
// branch of the same name — e.g. two PRs merge into the real base branch
// (f6499a25/#323, 058cca2d/#333) while the worktree's shared .git carries a
// stale local ref for it. resolveBaseRef must pick origin's newer merge-base
// so those already-merged commits are excluded from "this task's diff" and
// never misread as scope creep. Mirrors automated-verifier.ts's diffBaseRef
// equivalent suite.
describe('getDiff — origin AHEAD of local (task 516: previously-merged commits excluded)', () => {
  let repoDir: string;
  let originTipSha: string;

  function run(cmd: string): string {
    return execSync(cmd, { cwd: repoDir }).toString().trim();
  }

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'getdiff-origin-ahead-'));
    run('git init -q -b trunk');
    run('git config user.email "test@example.com"');
    run('git config user.name "Test"');

    writeFileSync(join(repoDir, 'README.md'), 'initial\n');
    run('git add README.md');
    run('git commit -q -m "root"');
    // The local 'develop' ref is frozen HERE — never fetched/updated again.
    run('git branch develop');

    // 'trunk' (standing in for the real remote-tracked history) keeps moving:
    // two merged PRs land after the local 'develop' ref went stale (standing
    // in for f6499a25/#323 and 058cca2d/#333).
    writeFileSync(join(repoDir, 'pr-323-backend.txt'), 'pr 323\n');
    run('git add pr-323-backend.txt');
    run('git commit -q -m "PR #323"');
    writeFileSync(join(repoDir, 'pr-333-button.txt'), 'pr 333\n');
    run('git add pr-333-button.txt');
    run('git commit -q -m "PR #333"');
    originTipSha = run('git rev-parse HEAD');
    // origin/develop is refreshed to the true, current tip — the local
    // 'develop' branch above never advances past the root commit.
    run('git update-ref refs/remotes/origin/develop HEAD');

    run('git checkout -q -b feature/task516');
    writeFileSync(join(repoDir, 'task-change.txt'), 'the actual task change\n');
    run('git add task-change.txt');
    run('git commit -q -m "task change"');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test('resolves to the origin tip, excluding already-merged PRs from the diff', async () => {
    const result = await getDiff(repoDir, undefined, 'develop');
    const filenames = result.map((f) => f.filename);
    expect(filenames).toEqual(['task-change.txt']);
    expect(filenames).not.toContain('pr-323-backend.txt');
    expect(filenames).not.toContain('pr-333-button.txt');
  });

  test('sanity: merge-base against origin/develop is indeed the origin tip', () => {
    const base = run('git merge-base feature/task516 origin/develop');
    expect(base).toBe(originTipSha);
  });
});

// Regression (task 516, real staleness — not simulated via `update-ref`):
// nothing in the verification pipeline ever runs `git fetch` against the
// worktree (ci_repair reuses the SAME worktree call after call; `gh pr merge`
// lands PRs via the GitHub API, never touching local remote-tracking refs).
// resolveBaseRef must refresh `origin/<preferredBaseBranch>` itself before
// comparing merge-bases, or a worktree that sat through PR #323/#333 merging
// upstream keeps computing merge-base against the pre-merge tip forever, and
// those already-merged commits bleed into "this task's diff" as false scope
// creep — the exact task-511 self-repair-loop symptom this task reports.
describe('getDiff — resolveBaseRef fetches origin/<branch> itself (task 516: no external fetch)', () => {
  let remoteDir: string;
  let repoDir: string;
  let rootSha: string;

  function runIn(dir: string, cmd: string): string {
    return execSync(cmd, { cwd: dir }).toString().trim();
  }

  // Multiple real Git repositories need more than 5s under Windows suite load.
  beforeEach(() => {
    remoteDir = mkdtempSync(join(tmpdir(), 'getdiff-remote-'));
    runIn(remoteDir, 'git init -q -b develop');
    runIn(remoteDir, 'git config user.email "test@example.com"');
    runIn(remoteDir, 'git config user.name "Test"');
    writeFileSync(join(remoteDir, 'README.md'), 'initial\n');
    runIn(remoteDir, 'git add README.md');
    runIn(remoteDir, 'git commit -q -m "root"');
    rootSha = runIn(remoteDir, 'git rev-parse HEAD');

    // Clone — this worktree's origin/develop and local develop both start at
    // the root commit, exactly as if the task's worktree was cut before any
    // of the PRs below existed.
    repoDir = mkdtempSync(join(tmpdir(), 'getdiff-clone-'));
    rmSync(repoDir, { recursive: true, force: true });
    execSync(`git clone -q "${remoteDir}" "${repoDir}"`);
    runIn(repoDir, 'git config user.email "test@example.com"');
    runIn(repoDir, 'git config user.name "Test"');

    // The remote keeps moving: two PRs merge into the real develop
    // (f6499a25/#323, 058cca2d/#333) AFTER this worktree was cloned.
    writeFileSync(join(remoteDir, 'pr-323-backend.txt'), 'pr 323\n');
    runIn(remoteDir, 'git add pr-323-backend.txt');
    runIn(remoteDir, 'git commit -q -m "PR #323"');
    writeFileSync(join(remoteDir, 'pr-333-button.txt'), 'pr 333\n');
    runIn(remoteDir, 'git add pr-333-button.txt');
    runIn(remoteDir, 'git commit -q -m "PR #333"');

    // Build the task branch AS IF it had already been synced with develop's
    // new tip (e.g. via `gh pr update-branch`, which merges on GitHub's side
    // — a one-time raw fetch stands in for however that merge commit reached
    // this worktree's own branch history).
    runIn(repoDir, 'git fetch -q origin develop');
    runIn(repoDir, 'git checkout -q -b feature/task516 origin/develop');
    writeFileSync(join(repoDir, 'task-change.txt'), 'the actual task change\n');
    runIn(repoDir, 'git add task-change.txt');
    runIn(repoDir, 'git commit -q -m "task change"');

    // Reset BOTH local refs back to stale (root) — simulating that nothing in
    // the verification pipeline has independently refreshed origin/develop
    // since the worktree was cloned. Only resolveBaseRef's own fetch (inside
    // getDiff, called below) may bring it forward again.
    runIn(repoDir, `git update-ref refs/remotes/origin/develop ${rootSha}`);
  }, 30_000);

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  });

  test('refreshes the stale origin/develop ref itself and excludes already-merged PRs', async () => {
    const result = await getDiff(repoDir, undefined, 'develop');
    const filenames = result.map((f) => f.filename);
    expect(filenames).toEqual(['task-change.txt']);
    expect(filenames).not.toContain('pr-323-backend.txt');
    expect(filenames).not.toContain('pr-333-button.txt');
  });

  test('sanity: without a fresh fetch, local refs are still frozen at root', () => {
    const originDevelop = runIn(repoDir, 'git rev-parse refs/remotes/origin/develop');
    const localDevelop = runIn(repoDir, 'git rev-parse develop');
    expect(originDevelop).toBe(rootSha);
    expect(localDevelop).toBe(rootSha);
  });
});
