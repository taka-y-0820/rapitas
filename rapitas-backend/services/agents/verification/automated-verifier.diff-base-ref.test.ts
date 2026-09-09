/**
 * automated-verifier.diff-base-ref.test
 *
 * diffBaseRef is a duplicate of diff-structured.ts's resolveBaseRef (same
 * develop→main→master guess, now also preferring an explicit
 * preferredBaseBranch first). Separated from automated-verifier.test.ts,
 * which is pure-function-only — this exercises real git subprocess calls
 * against a throwaway repo, same as diff-structured.test.ts's equivalent
 * suite.
 *
 * Regression (task 506): a stale/divergent 'develop' branch made the
 * guess-only order land on an ancient common ancestor, pulling unrelated
 * pre-existing commits into "this task's changed files" — which this file's
 * getAllChangedFiles/getChangedCodeFiles feed into HARD gates (tamperCheck,
 * lint, typecheck), so a wrong base here can false-block a task on files the
 * agent never touched, not just add noise to an LLM judge prompt.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

// Real Git subprocesses can exceed Bun's 5s default under Windows suite load.
// Keep assertions intact and let subprocess work finish before fixture cleanup.
const GIT_TEST_TIMEOUT_MS = 30_000;
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { diffBaseRef } from './automated-verifier';

describe('diffBaseRef — preferredBaseBranch overrides the develop/main/master guess', () => {
  let repoDir: string;
  let mainTrackSha: string;

  function run(cmd: string): string {
    return execSync(cmd, { cwd: repoDir }).toString().trim();
  }

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'diffbaseref-test-'));
    run('git init -q');
    run('git config user.email "test@example.com"');
    run('git config user.name "Test"');

    writeFileSync(join(repoDir, 'README.md'), 'initial\n');
    run('git add README.md');
    run('git commit -q -m "root"');

    // 'develop' branches off HERE and is never updated again (stale/frozen).
    run('git branch develop');

    // 'main' keeps moving after develop diverged.
    writeFileSync(join(repoDir, 'unrelated.txt'), 'unrelated\n');
    run('git add unrelated.txt');
    run('git commit -q -m "unrelated feature"');
    mainTrackSha = run('git rev-parse HEAD');
    run('git branch main-track');

    run('git checkout -q -b feature/task');
    writeFileSync(join(repoDir, 'task-change.txt'), 'task change\n');
    run('git add task-change.txt');
    run('git commit -q -m "task change"');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test(
    'without a preference, the develop guess resolves to the stale root commit',
    async () => {
      const base = await diffBaseRef(repoDir);
      const rootSha = run('git rev-list --max-parents=0 HEAD');
      expect(base).toBe(rootSha);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    'with preferredBaseBranch="main-track", resolves to the actual fork point',
    async () => {
      const base = await diffBaseRef(repoDir, 'main-track');
      expect(base).toBe(mainTrackSha);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    'an unsafe/malformed preferredBaseBranch is ignored, falling back to the guess',
    async () => {
      const base = await diffBaseRef(repoDir, '; rm -rf /');
      const rootSha = run('git rev-list --max-parents=0 HEAD');
      expect(base).toBe(rootSha);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe('diffBaseRef — local base branch AHEAD of origin (unpushed self-dev commits)', () => {
  let repoDir: string;

  function run(cmd: string): string {
    return execSync(cmd, { cwd: repoDir }).toString().trim();
  }

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'diffbaseref-ahead-'));
    run('git init -q -b develop');
    run('git config user.email "test@example.com"');
    run('git config user.name "Test"');

    writeFileSync(join(repoDir, 'README.md'), 'initial\n');
    run('git add README.md');
    run('git commit -q -m "root"');
    // origin/develop is frozen HERE (last pushed state).
    run('git update-ref refs/remotes/origin/develop HEAD');

    // develop then accumulates UNPUSHED local commits (self-dev pattern).
    writeFileSync(join(repoDir, 'unpushed.txt'), 'unpushed work\n');
    run('git add unpushed.txt');
    run('git commit -q -m "unpushed self-dev commit"');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test(
    'resolves to the LOCAL develop tip, not the stale origin merge-base',
    async () => {
      // Task worktree branch is cut from the LOCAL develop tip.
      const localTip = run('git rev-parse develop');
      run('git checkout -q -b feature/task');
      writeFileSync(join(repoDir, 'task-change.txt'), 'task change\n');
      run('git add task-change.txt');
      run('git commit -q -m "task change"');

      // Origin-first resolution would return the root commit and pull the
      // unpushed commit into "this task's diff" — the true fork point is the
      // local tip.
      const base = await diffBaseRef(repoDir, 'develop');
      expect(base).toBe(localTip);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  test(
    'picks the newer fork point even when origin has diverged commits of its own',
    async () => {
      // origin/develop moves independently (divergence): point it at a commit
      // that is NOT on local develop's history.
      run('git checkout -q -b origin-track HEAD~1');
      writeFileSync(join(repoDir, 'origin-only.txt'), 'origin only\n');
      run('git add origin-only.txt');
      run('git commit -q -m "origin-only commit"');
      run('git update-ref refs/remotes/origin/develop HEAD');
      run('git checkout -q develop');

      run('git checkout -q -b feature/task2');
      writeFileSync(join(repoDir, 'task2.txt'), 'task2\n');
      run('git add task2.txt');
      run('git commit -q -m "task2 change"');

      // merge-base vs origin/develop = the root; vs local develop = the local
      // tip. The root is an ancestor of the local tip, so the newer (local)
      // base is the true fork point and must win — origin's diverged commit
      // never entered this branch's history.
      const localTip = run('git rev-parse develop~0');
      const base = await diffBaseRef(repoDir, 'develop');
      expect(base).toBe(localTip);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
