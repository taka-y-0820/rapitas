/**
 * execution/research-diff-revert
 *
 * Detects and reverts any code changes a research-mode agent made
 * (tracked diff or untracked files) — research must not modify code.
 * Only reverts inside an isolated worktree, never the main checkout.
 * Separated from research-phase-handler.ts to keep each file under 500 lines.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../../../../config/logger';
import { isIsolatedWorktree } from './research-output-utils';
import { getTaskExecutionCancellationVersion } from '../../../../services/agents/task-execution-lock';

// Async git so the post-execution revert never blocks the single-threaded event
// loop. Synchronous execSync('git reset/clean', timeout 30s) here would freeze
// ALL HTTP requests (e.g. the UI's GET /tasks/:id) for up to 30s when a git op
// is slow/locked.
const execAsync = promisify(exec);

const log = createLogger('routes:agent-execution:research-diff-revert');

/**
 * Inspect the execution directory for changes a research-mode agent made and
 * hard-revert them when the directory is an isolated worktree. Uses
 * `git diff --quiet` — exits 0 when the working tree is clean, 1 when there
 * are tracked-file changes — plus a separate untracked-files check (not
 * covered by --quiet). Any diff is treated as a sandbox escape.
 *
 * @param executionDir - Directory the agent executed in / エージェントの実行ディレクトリ
 * @param taskIdNum - Task ID for logging / ログ用タスクID
 * @returns true when a revert was performed / リバートを実行した場合true
 */
export async function revertResearchDiffIfDirty(
  executionDir: string,
  taskIdNum: number,
): Promise<boolean> {
  const version = getTaskExecutionCancellationVersion(taskIdNum);
  const current = () => getTaskExecutionCancellationVersion(taskIdNum) === version;
  let revertedDiff = false;
  try {
    let isClean = true;
    try {
      // resolves when clean (exit 0), rejects (exit 1) when there is a diff
      await execAsync('git diff --quiet HEAD', { cwd: executionDir, timeout: 10000 });
    } catch {
      isClean = false;
    }
    if (!current()) return false;
    // Untracked files don't show up in diff --quiet, check separately.
    const { stdout: untracked } = await execAsync('git ls-files --others --exclude-standard', {
      cwd: executionDir,
      encoding: 'utf8',
      timeout: 10000,
    });
    if (!current()) return false;
    if (untracked.trim().length > 0) {
      isClean = false;
    }
    if (!isClean && !isIsolatedWorktree(executionDir)) {
      // The research phase runs in process.cwd() (the main checkout). NEVER
      // hard-reset it — that wipes the user's / platform's uncommitted work
      // (it has, in practice, eaten in-flight edits). Only worktrees are reset.
      log.warn(
        { taskId: taskIdNum, executionDir },
        '[API] Research produced changes in the main checkout — NOT reverting (would clobber uncommitted work)',
      );
    } else if (!isClean) {
      revertedDiff = true;
      await execAsync('git reset --hard HEAD', { cwd: executionDir, timeout: 30000 });
      if (!current()) return revertedDiff;
      await execAsync('git clean -fd', { cwd: executionDir, timeout: 30000 });
      log.warn(
        { taskId: taskIdNum, untrackedSize: untracked.length },
        '[API] Research mode produced code changes (git diff or untracked files) — reverted',
      );
    }
  } catch (revertErr) {
    log.warn(
      { err: revertErr, taskId: taskIdNum },
      '[API] Failed to inspect/revert worktree in research mode',
    );
  }
  return revertedDiff;
}
