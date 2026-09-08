/**
 * GitOperations — Pull Request Merge
 *
 * Auto-merges a PR (squash or merge strategy by commit count) and
 * best-effort syncs the local checkout post-merge.
 * Not responsible for creating the PR or reverting changes.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../../../../../config/logger';
import {
  isPrimaryWorkTree,
  findConflictingWorktreeForBranch,
  recoverFromUnresolvedMerge,
} from '../worktree/worktree-guard';
import { isHeadBehindError, isAlreadyUpToDate } from '../../../../github/gh-retry';
import { ghPath } from './gh-cli-path';

// NOTE: execFile (array-args, no shell) instead of exec (shell string) — branch
// names, base branches, and other caller-controlled values are passed as
// literal argv elements, so shell metacharacters in them can't be interpreted.
const execFileAsync = promisify(execFile);
const logger = createLogger('git-operations/pr-merge-ops');

// Local git reads/writes normally finish in well under a second; 60s leaves
// generous headroom while still bounding a lock-contention or auth-prompt
// hang so the implementer phase can't sit blocked past its wall-clock budget.
const GIT_OP_TIMEOUT_MS = 60_000;
// `gh` calls and `git pull` hit the network; 120s gives real requests
// headroom while still bounding a hang so the phase can't stall on it.
const GIT_SLOW_OP_TIMEOUT_MS = 120_000;

/** GitHub's authoritative view of one PR, as read (never mutated) by the recovery path. */
export interface AuthoritativeMergeState {
  /** PR number GitHub echoed back — compare against the requested number. / GitHubが返したPR番号 */
  number: number;
  /** `MERGED` / `OPEN` / `CLOSED`. / PRの状態 */
  state: string;
  /** ISO timestamp of the merge, or null when not merged. / マージ時刻（未マージなら null） */
  mergedAt: string | null;
  /** Base branch the PR targets. / PRのベースブランチ */
  baseRefName: string | null;
}

/**
 * Read GitHub's authoritative state for a PR WITHOUT merging anything.
 *
 * The merge path confirms its own merge inline (see {@link mergePullRequest});
 * this is the separate read-only use case — "is this PR already merged?" — that
 * the auto-merge recovery path needs before it may complete a task whose local
 * completion write was lost. Local DB rows and logs are not evidence of a merge;
 * this call is.
 *
 * @param workingDirectory - A checkout of the PR's repository (scopes the gh call). / 対象リポジトリのチェックアウト
 * @param prNumber - PR number to read. / 読み取るPR番号
 * @returns GitHub's state, or null when gh failed or the payload was unusable. / 取得結果（失敗時 null）
 */
export async function readAuthoritativeMergeState(
  workingDirectory: string,
  prNumber: number,
  repository?: string,
): Promise<AuthoritativeMergeState | null> {
  try {
    const { stdout } = await execFileAsync(
      ghPath(),
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'number,state,mergedAt,baseRefName',
        ...(repository ? ['--repo', repository] : []),
      ],
      { cwd: workingDirectory, encoding: 'utf8', timeout: GIT_SLOW_OP_TIMEOUT_MS },
    );
    const parsed = JSON.parse(stdout) as Partial<AuthoritativeMergeState>;
    if (typeof parsed.number !== 'number' || typeof parsed.state !== 'string') return null;
    return {
      number: parsed.number,
      state: parsed.state,
      mergedAt: typeof parsed.mergedAt === 'string' ? parsed.mergedAt : null,
      baseRefName: typeof parsed.baseRefName === 'string' ? parsed.baseRefName : null,
    };
  } catch (err) {
    logger.warn(
      { err, workingDirectory, prNumber },
      '[readAuthoritativeMergeState] Could not read the PR state from GitHub',
    );
    return null;
  }
}

/**
 * Auto-merge a pull request.
 * Uses squash merge when commit count >= threshold, otherwise merge commit.
 *
 * @param workingDirectory - Repository directory / リポジトリのディレクトリ
 * @param prNumber - PR number to merge / マージするPR番号
 * @param commitThreshold - Minimum commit count for squash strategy (default 5) / squash戦略に切り替えるコミット数の閾値
 * @param baseBranch - Branch to check out after merge (default 'master') / マージ後にチェックアウトするブランチ
 * @returns Result with success flag and merge strategy used / 成功フラグと使用したマージ戦略を含む結果
 */
export async function mergePullRequest(
  workingDirectory: string,
  prNumber: number,
  commitThreshold: number = 5,
  baseBranch: string = 'master',
  canProceed?: () => Promise<boolean>,
): Promise<{
  success: boolean;
  mergeStrategy?: 'squash' | 'merge';
  error?: string;
  /**
   * The merge was blocked by a transient/recoverable condition (head branch
   * behind base — branch protection requires up-to-date). We updated the branch;
   * the caller should retry on a later poll (CI re-runs first). Not a failure.
   */
  retriable?: boolean;
}> {
  try {
    const { stdout } = await execFileAsync(
      ghPath(),
      ['pr', 'view', String(prNumber), '--json', 'commits', '--jq', '.commits | length'],
      { cwd: workingDirectory, encoding: 'utf8', timeout: GIT_SLOW_OP_TIMEOUT_MS },
    );
    const commitCount = parseInt(stdout.trim(), 10) || 1;
    const mergeStrategy = commitCount >= commitThreshold ? 'squash' : 'merge';
    const mergeFlag = mergeStrategy === 'squash' ? '--squash' : '--merge';

    if (canProceed && !(await canProceed()))
      return { success: false, error: 'Merge canceled before publication' };

    await execFileAsync(ghPath(), ['pr', 'merge', String(prNumber), mergeFlag, '--delete-branch'], {
      cwd: workingDirectory,
      encoding: 'utf8',
      timeout: GIT_SLOW_OP_TIMEOUT_MS,
    });

    const confirmation = await execFileAsync(
      ghPath(),
      ['pr', 'view', String(prNumber), '--json', 'number,state,mergedAt,baseRefName'],
      { cwd: workingDirectory, encoding: 'utf8', timeout: GIT_SLOW_OP_TIMEOUT_MS },
    );
    const actual = JSON.parse(confirmation.stdout);
    if (
      actual.number !== prNumber ||
      actual.baseRefName !== baseBranch ||
      actual.state !== 'MERGED' ||
      typeof actual.mergedAt !== 'string' ||
      !Number.isFinite(Date.parse(actual.mergedAt))
    ) {
      return {
        success: false,
        retriable: true,
        error: 'GitHub has not confirmed the requested PR merge',
      };
    }
    if (canProceed && !(await canProceed()))
      return { success: false, error: 'Task stopped after merge; local follow-up skipped' };

    // Post-merge local sync. On the PRIMARY checkout this `git checkout` + pull
    // would switch the developer's branch and could clobber uncommitted work —
    // skip it there (the merge already landed on GitHub). Only sync worktrees.
    if (await isPrimaryWorkTree(workingDirectory)) {
      logger.warn(
        { workingDirectory },
        '[mergeBranch] primary working tree — skipping local checkout+pull sync to protect developer work',
      );
    } else {
      // NOTE: `baseBranch` (e.g. develop) may already be checked out by another
      // worktree. `git checkout` would fail with `fatal: ... already used by
      // worktree` — skip sync in that case. The merge already landed on GitHub;
      // the local sync is a best-effort convenience only.
      const syncConflictPath = await findConflictingWorktreeForBranch(workingDirectory, baseBranch);
      if (syncConflictPath) {
        logger.warn(
          { workingDirectory, baseBranch, conflictPath: syncConflictPath },
          '[mergePullRequest] baseBranch is already used by another worktree — skipping local checkout+pull sync',
        );
      } else {
        // task 743: unlike createBranch/commitChanges/createCommit, this
        // post-merge checkout was never guarded against a leftover unresolved
        // MERGE_HEAD/CHERRY_PICK_HEAD — self-heal first so it doesn't fail
        // with git's "you need to resolve your current index first".
        await recoverFromUnresolvedMerge(workingDirectory);
        await execFileAsync('git', ['checkout', baseBranch], {
          cwd: workingDirectory,
          timeout: GIT_OP_TIMEOUT_MS,
        });
        await execFileAsync('git', ['pull'], {
          cwd: workingDirectory,
          timeout: GIT_SLOW_OP_TIMEOUT_MS,
        });
      }
    }

    return { success: true, mergeStrategy };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Branch protection requires the head branch to be up to date with base.
    // Update it (merge base into the PR head on GitHub) so CI re-runs; the
    // caller (AutoMergeWatcher) retries the merge once checks are green again.
    if (isHeadBehindError(msg)) {
      try {
        if (canProceed && !(await canProceed()))
          return { success: false, error: 'Merge canceled before branch update' };
        await execFileAsync(ghPath(), ['pr', 'update-branch', String(prNumber)], {
          cwd: workingDirectory,
          encoding: 'utf8',
          timeout: GIT_SLOW_OP_TIMEOUT_MS,
        });
        return {
          success: false,
          retriable: true,
          error: 'head branch was behind base; updated branch — will retry after CI re-runs',
        };
      } catch (updErr) {
        const um = updErr instanceof Error ? updErr.message : String(updErr);
        // Already up to date (race) — just retry the merge next tick.
        if (isAlreadyUpToDate(um)) {
          return {
            success: false,
            retriable: true,
            error: 'branch already up to date; will retry',
          };
        }
        return { success: false, error: `update-branch failed: ${um}` };
      }
    }
    return { success: false, error: msg };
  }
}
