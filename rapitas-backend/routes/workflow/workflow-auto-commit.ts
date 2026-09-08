/**
 * Workflow Auto Commit and PR
 *
 * Handles automatic git commit, pull request creation, merge, and worktree cleanup
 * triggered when verify.md is saved and the workflow reaches 'completed' status.
 * Not responsible for route definitions or file persistence.
 */

import { dirname, join } from 'path';
import { prisma, getProjectRoot } from '../../config';
import { AgentOrchestrator } from '../../services/agents/agent-orchestrator';
import { createLogger } from '../../config/logger';
import { logAutoCommit, logAutoPR } from './workflow-activity-logger';
import {
  runVerificationGate,
  recordUnknownVerdictMarker,
} from '../../services/agents/verification/verification-gate';
import type { VerificationVerdict } from '../../services/agents/verification/automated-verifier';
import { resolveAutomationPolicy } from '../../services/workflow/automation-policy';
import { linkAutoCreatedPr } from '../../services/github/pr-link';
import { resolveCommitCwd } from './commit-cwd';
import { FOREIGN_PR_ERROR_PREFIX } from '../../services/agents/orchestrator/git-operations/pr/branch-pr-ops';
import { notify } from '../../services/workflow/auto-merge-notify';
import {
  findOpenPrForTask,
  claimPrCreationLock,
  releasePrCreationLock,
} from '../../services/github/pr-duplicate-guard';
import { syncBaseIntoBranch, type BaseSyncResult } from '../../services/workflow/pre-pr-base-sync';
import { runGitCommand } from '../../services/github/git-exec';

const log = createLogger('routes:workflow:auto-commit');

export type AutoCommitPRResult = {
  requested?: {
    autoCommit: boolean;
    autoCreatePR: boolean;
    autoMergePR: boolean;
  };
  autoCommitResult?: {
    success: boolean;
    hash?: string;
    branch?: string;
    filesChanged?: number;
    error?: string;
  };
  autoPRResult?: { success: boolean; prUrl?: string; prNumber?: number; error?: string };
  /**
   * Pre-PR base-branch sync outcome (task 573 A). Kept as an INDEPENDENT field —
   * its detail must never be concatenated into the commit/PR error blob, or
   * merge wording could trip {@link isNoChangeCompletion} into a false
   * "no change" completion.
   */
  baseSyncResult?: BaseSyncResult;
  autoMergeResult?: {
    success: boolean;
    mergeStrategy?: string;
    error?: string;
    deferred?: boolean;
  };
  worktreeCleanupResult?: { success: boolean; worktreePath?: string; error?: string };
  /**
   * True when the automated verification gate blocked (the agent's changes have
   * new lint/type errors). The caller MUST NOT then mark the task completed —
   * the gate already set it `blocked`.
   */
  verificationBlocked?: boolean;
  error?: string;
};

/**
 * Commits on HEAD that the remote base does not have.
 *
 * Fails OPEN: when git cannot answer (no remote-tracking ref, not a repo) the
 * caller proceeds to the PR attempt, which decides for itself.
 *
 * @param cwd - Worktree or checkout to inspect. / 対象の作業ツリー
 * @param baseBranch - PR base branch name (remote-tracking `origin/<base>` is compared). / ベースブランチ
 * @returns Number of commits ahead, or null when unknown. / 先行コミット数（不明なら null）
 */
export async function countCommitsAhead(cwd: string, baseBranch: string): Promise<number | null> {
  try {
    const out = await runGitCommand(['rev-list', '--count', `origin/${baseBranch}..HEAD`], cwd);
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Classify whether a failed commit/PR outcome means "no change was needed"
 * (already implemented — safe to complete WITHOUT a PR) as opposed to a real
 * PR failure that must block. Shared by both verify-completion paths (HTTP
 * file-save handler and the CLI executor epilogue). Pure and unit-testable.
 *
 * Task 485 incident: `gh pr create` against a base branch that does not exist
 * in the repo also says "No commits between <base> and <head>" — a naive regex
 * match then completed a 261-line change with NO PR. Two guards close that:
 * a base-branch error is never no-change, and a commit that actually changed
 * files proves there WAS work to land.
 *
 * @param p.errorBlob - Concatenated commit/PR/step error messages. / エラー文字列連結
 * @param p.filesChanged - Files changed by the auto-commit (undefined = no commit made). / コミットの変更ファイル数
 * @returns True when completion-without-PR is justified. / PRなし完了が正当か
 */
export function isNoChangeCompletion(p: {
  errorBlob: string;
  filesChanged: number | undefined;
}): boolean {
  // A missing/invalid base produces "No commits between ..." too — that is a
  // PR-creation failure, not an already-implemented no-op.
  if (/base (?:sha|ref)|sha can't be blank|must be a branch/i.test(p.errorBlob)) return false;
  // The commit itself changed files: there IS work that failed to reach a PR.
  if (typeof p.filesChanged === 'number' && p.filesChanged > 0) return false;
  return (
    p.filesChanged === 0 ||
    /no commits between|nothing to commit|no changes added|変更がありません|差分がありません/i.test(
      p.errorBlob,
    )
  );
}

/**
 * Perform auto-commit, PR creation, optional merge, and worktree cleanup after verify.md is saved.
 *
 * @param taskId - Task ID that was completed / 完了したタスクID
 * @param verifyContent - Content of verify.md for PR body / PRボディ用verify.mdの内容
 * @returns Result object containing outcomes of each step / 各ステップの結果オブジェクト
 */
export async function performAutoCommitAndPR(
  taskId: number,
  verifyContent: string,
): Promise<AutoCommitPRResult> {
  const result: AutoCommitPRResult = {};

  try {
    const execConfig = await prisma.agentExecutionConfig.findUnique({ where: { taskId } });

    // Effective automation policy. An explicit per-task execConfig (saved by the
    // user in the UI) wins; otherwise fall back to the recommended default flow
    // (commit + PR, NO auto-merge) so an UNconfigured task's changes still reach
    // git via a reviewable PR instead of being stranded uncommitted in the
    // worktree. execConfig is only created on explicit user action, so "no row"
    // genuinely means "use the recommended default".
    const policy = await resolveAutomationPolicy(prisma, taskId);
    const autoCommit = execConfig ? execConfig.autoCommit : policy.autoCommit;
    const autoCreatePR = execConfig ? execConfig.autoCreatePR : policy.autoCreatePR;
    const autoMergePR = execConfig ? execConfig.autoMergePR : policy.autoMergePR;
    result.requested = { autoCommit, autoCreatePR, autoMergePR };

    if (!autoCommit && !autoCreatePR && !autoMergePR) return result;

    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        theme: true,
        developerModeConfig: {
          include: { agentSessions: { orderBy: { lastActivityAt: 'desc' }, take: 1 } },
        },
      },
    });

    if (!task) return result;
    // CRITICAL: explicit cwd → task worktree → theme dir (see commit-cwd.ts; task 774).
    const workingDirectory = await resolveCommitCwd(execConfig, task, taskId);
    if (!workingDirectory) {
      log.warn(`[workflow] Task ${taskId} rejected: workingDirectory not configured.`);
      return {
        ...result,
        error:
          'Task theme must have workingDirectory configured. Please set the working directory in theme settings.',
      };
    }

    // NOTE: Log warning when workingDirectory overlaps with rapitas project — allowed but flagged
    const projectRoot = getProjectRoot();
    if (
      workingDirectory === projectRoot ||
      workingDirectory.startsWith(join(projectRoot, 'rapitas-'))
    ) {
      log.warn(
        `[workflow] Task ${taskId}: workingDirectory overlaps with rapitas project (${workingDirectory}). Proceeding.`,
      );
    }

    const latestSession = task.developerModeConfig?.agentSessions?.[0];
    const branchName = latestSession?.branchName;
    const targetBranch =
      ((execConfig as Record<string, unknown> | null)?.targetBranch as string) ||
      task.theme?.defaultBranch ||
      'develop';

    // CRITICAL: git commit / push / PR commands MUST run inside the
    // per-task worktree, not the dev project root. Earlier code passed
    // `workingDirectory` (project root) to all git commands, which:
    //   - committed against whatever branch was checked out at the root
    //   - never touched the agent's actual changes (those live in the
    //     worktree on the task branch)
    //   - silently produced "no diff" or no-op commits
    // Fall back to `workingDirectory` only when no worktree exists, so
    // callers that already work without isolation keep functioning.
    const gitCwd = latestSession?.worktreePath || workingDirectory;
    if (latestSession?.worktreePath) {
      log.info(
        { taskId, worktreePath: latestSession.worktreePath, branchName },
        '[Workflow] Running git operations inside per-task worktree',
      );
    } else {
      log.warn(
        { taskId, workingDirectory, branchName },
        '[Workflow] No worktree on session — git operations will run on the dev project root (NOT isolated)',
      );
    }

    // Automated verification gate — do NOT auto-commit/PR if the agent
    // introduced new lint/type errors. Mirrors the post-execution-review gate so
    // BOTH auto-PR paths are protected (closes the verify.md-triggered gap).
    const gate = await runVerificationGate(taskId, gitCwd, latestSession?.id);
    if (!gate.ok) {
      log.error(
        { taskId, summary: gate.result?.summary },
        '[Workflow] Automated verification failed — aborting auto-commit/PR',
      );
      return {
        ...result,
        verificationBlocked: true,
        error: `自動検証に失敗しました（${gate.result?.summary ?? 'lint/型エラー'}）。auto-commit/PR を中止し、タスクをブロックしました。`,
      };
    }

    const orchestrator = AgentOrchestrator.getInstance(prisma);

    // Process autoCommit
    if (autoCommit) {
      try {
        if (branchName) {
          await orchestrator.createBranch(gitCwd, branchName);
        }
        const commitResult = await orchestrator.createCommit(
          gitCwd,
          `feat(task-${taskId}): ${task.title}`,
          targetBranch,
        );
        result.autoCommitResult = {
          success: true,
          hash: commitResult.hash,
          branch: commitResult.branch,
          filesChanged: commitResult.filesChanged,
        };
        log.info(`[Workflow] Auto-commit successful for task ${taskId}: ${commitResult.hash}`);
        await logAutoCommit(
          taskId,
          commitResult.hash,
          commitResult.branch,
          commitResult.filesChanged,
          commitResult.additions,
          commitResult.deletions,
          commitResult.alreadyCommitted,
        );
      } catch (commitError) {
        log.error({ err: commitError }, `[Workflow] Auto-commit failed for task ${taskId}`);
        result.autoCommitResult = {
          success: false,
          error: commitError instanceof Error ? commitError.message : String(commitError),
        };
      }
    }

    // Pre-PR base sync (task 573 A): pull origin/<base> into the task branch
    // BEFORE the PR exists, so drift conflicts are found and resolved while the
    // task context is at hand instead of surfacing as a post-merge conflict
    // task. Infra failures are fail-open ('skipped' → PR proceeds); only a real
    // unresolved conflict or a failed post-merge re-verification withholds the
    // PR. Runs BEFORE the PR-creation lock — the aux resolution + re-verify can
    // exceed the lock's 5-min staleness window.
    if (autoCreatePR && result.autoCommitResult?.success) {
      const baseSync = await syncBaseIntoBranch({
        gitCwd,
        baseBranch: targetBranch,
        taskId,
        sessionId: latestSession?.id,
      }).catch((err): BaseSyncResult => {
        log.warn({ err, taskId }, '[Workflow] base sync threw — treating as skipped (fail-open)');
        return { status: 'skipped', changedFiles: 0, conflicts: [], detail: String(err) };
      });
      result.baseSyncResult = baseSync;

      if (baseSync.status === 'conflict_unresolved' || baseSync.status === 'reverify_failed') {
        // Withhold the PR; keep the worktree (NO cleanup) as the backstop for
        // the existing conflict-task / AutoMergeWatcher defense line and for a
        // re-run. NOTE: result.error stays a FIXED sentence (no raw git/merge
        // output) so completion classification never misreads it.
        if (baseSync.status === 'reverify_failed') {
          result.verificationBlocked = true;
          result.error = `base(${targetBranch})取り込み後の再検証に失敗したため、auto-PRを中止しました。`;
        } else {
          result.error = `base(${targetBranch})とのマージ競合を自動解消できなかったため、auto-PRを中止しました。`;
        }
        await notify({
          taskId,
          type:
            baseSync.status === 'conflict_unresolved'
              ? 'base_sync_conflict_unresolved'
              : 'base_sync_reverify_failed',
          title:
            baseSync.status === 'conflict_unresolved'
              ? 'PR作成前のbase取り込みで競合を解消できませんでした'
              : 'base取り込み後の再検証に失敗しました',
          message:
            baseSync.status === 'conflict_unresolved'
              ? `タスク ${taskId}: ${baseSync.detail}。対象: ${baseSync.conflicts.join(', ').slice(0, 500)}。PRは作成していません。手動確認または再実行してください。`
              : `タスク ${taskId}: ${baseSync.detail}。PRは作成していません。`,
        });
        log.warn(
          { taskId, baseSync },
          '[Workflow] pre-PR base sync blocked PR creation (worktree preserved)',
        );
        return result;
      }
      log.info(
        { taskId, baseSync: { ...baseSync, conflicts: baseSync.conflicts.length } },
        '[Workflow] pre-PR base sync done',
      );
    }
    // A re-verify inside base sync reflects the branch's LATEST state, so it
    // takes precedence over the earlier gate result when both ran.
    const effectiveVerdict: VerificationVerdict = result.baseSyncResult?.verdict ?? gate.verdict;

    // Process autoCreatePR (only if autoCommit succeeded)
    if (autoCreatePR && !autoCommit) {
      result.autoPRResult = {
        success: false,
        error:
          'autoCreatePR requires autoCommit so the workflow can identify the branch to publish.',
      };
    }
    if (autoCreatePR && result.autoCommitResult?.success) {
      // One-open-PR-per-task guard: createPullRequest's own reuse check is
      // branch-scoped (gh pr list --head <branch>) and misses a task's real
      // open PR whenever this run lands on a DIFFERENT branch than the PR was
      // opened from (recreated worktree, diverged push renamed to
      // <branch>-<sha>). Claim the lock first so two concurrent auto-PR
      // attempts for this task can't both pass the check and each create one.
      const lockClaimed = await claimPrCreationLock(prisma, taskId);
      if (!lockClaimed) {
        log.info(
          `[Workflow] Task ${taskId}: another PR-creation attempt is already in flight — skipping`,
        );
        result.autoPRResult = {
          success: false,
          error: 'PR作成が別プロセスで進行中のためスキップしました',
        };
      } else {
        try {
          const existingOpenPr = await findOpenPrForTask(prisma, taskId);
          if (existingOpenPr) {
            log.info(
              `[Workflow] Task ${taskId} already has open PR #${existingOpenPr.prNumber} — reusing instead of creating a new one`,
            );
            result.autoPRResult = {
              success: true,
              prUrl: existingOpenPr.url,
              prNumber: existingOpenPr.prNumber,
            };
          } else {
            const prTitle = `[Task-${taskId}] ${task.title}`;
            const prBody = `## Summary\n\nAuto-generated PR for Task #${taskId}: ${task.title}\n\n## Verification Report\n\n${verifyContent}\n\n---\n🤖 Generated automatically by Rapitas AI Agent`;
            // Pass the session's branchName as the explicit PR head — gitCwd's
            // raw checkout can sit on the base branch when the worktree is gone
            // (task 594: head resolved to "develop" and PR creation failed with
            // head==base despite the session branch being pushed).
            // Ask git before asking GitHub. A branch with nothing ahead of the
            // base cannot become a PR; `gh pr create` reports that as a failure
            // and the gh client logs every failed command at ERROR — six times
            // in one day for no-change completions (tasks 699/700/707/735/736/
            // 739). The "No commits between" wording is kept on purpose: it is
            // what isNoChangeCompletion classifies, so the no-change path below
            // is unchanged; only the pointless gh call and its ERROR line go.
            const aheadOfBase = await countCommitsAhead(gitCwd, targetBranch);
            const prResult =
              aheadOfBase === 0
                ? {
                    success: false as const,
                    error: `No commits between ${targetBranch} and ${branchName ?? 'HEAD'} — nothing to publish (skipped before gh pr create)`,
                  }
                : await orchestrator.createPullRequest(
                    gitCwd,
                    prTitle,
                    prBody,
                    targetBranch,
                    branchName ?? undefined,
                    effectiveVerdict === 'unknown',
                  );
            result.autoPRResult = prResult;

            if (prResult.success) {
              log.info(`[Workflow] Auto-PR created for task ${taskId}: ${prResult.prUrl}`);
              await logAutoPR(taskId, task.title, prResult.prUrl, prResult.prNumber);
              // Persist + link the PR locally so the task's "PRを開く" button can
              // resolve task → local PR id. Without this the by-task lookup 404s and
              // the button silently does nothing.
              if (prResult.prNumber != null && prResult.prUrl) {
                await linkAutoCreatedPr(prisma, {
                  taskId,
                  prNumber: prResult.prNumber,
                  prUrl: prResult.prUrl,
                  title: prTitle,
                  headBranch: result.autoCommitResult?.branch ?? branchName ?? 'unknown',
                  baseBranch: targetBranch,
                  repositoryUrl: task.theme?.repositoryUrl,
                  workingDirectory: gitCwd,
                });
                if (effectiveVerdict === 'unknown') {
                  await recordUnknownVerdictMarker(taskId, gitCwd, 'workflow-auto-commit');
                }
              }
            } else {
              // NOTE (task 687): "no commits between" / "nothing to commit" is
              // an already-implemented no-op that verify-commit-pr-pipeline.ts
              // completes successfully via this SAME isNoChangeCompletion
              // classifier — logging it at ERROR filed the same benign outcome
              // as a recurring generic bug report. Only a genuine PR-creation
              // failure (auth, network, foreign-PR collision, etc.) is an
              // operational error worth ERROR severity.
              const benignNoChange = isNoChangeCompletion({
                errorBlob: prResult.error ?? '',
                filesChanged: result.autoCommitResult?.filesChanged,
              });
              // NOTE: pino's stdSerializers only special-case the `err` key —
              // `error:` silently dropped the failure reason from the log
              // (task 687), leaving log-health-check unable to diagnose repeats.
              const logPrOutcome = benignNoChange ? log.warn.bind(log) : log.error.bind(log);
              logPrOutcome(
                { err: new Error(prResult.error ?? 'unknown error') },
                benignNoChange
                  ? `[Workflow] Auto-PR skipped for task ${taskId}: already implemented, no changes to publish`
                  : `[Workflow] Auto-PR creation failed for task ${taskId}`,
              );
              // Task-identity mismatch (task 541): the branch's open PR belongs to
              // another task — surface it instead of a silent generic failure so
              // the user can resolve the stale branch/PR collision.
              if (prResult.error?.startsWith(FOREIGN_PR_ERROR_PREFIX)) {
                await notify({
                  taskId,
                  type: 'auto_pr_identity_mismatch',
                  title: '自動PR作成を中止しました',
                  message: `タスク ${taskId} のブランチには他タスクのPRが開いたまま残っているため、誤リンクを避けてPR作成を中止しました。${prResult.error}`,
                });
              }
            }
          }
        } catch (prError) {
          log.error({ err: prError }, `[Workflow] Auto-PR failed for task ${taskId}`);
          result.autoPRResult = {
            success: false,
            error: prError instanceof Error ? prError.message : String(prError),
          };
        } finally {
          await releasePrCreationLock(prisma, taskId);
        }
      }
    }

    // Process autoMergePR — DEFER the actual merge to the CI-gated AutoMergeWatcher.
    // The user requirement is "merge only when verification passes AND behaviour
    // is fine", so the merge must wait for the PR's GitHub CI to go green.
    // Merging inline here would skip that gate. The watcher derives eligibility
    // from task status + autoMergePR + the open linked PR, so nothing extra is
    // persisted; it merges on CI pass, or leaves the PR open on CI fail.
    if (autoMergePR && result.autoPRResult?.success && result.autoPRResult?.prNumber) {
      result.autoMergeResult = { success: false, deferred: true };
      log.info(
        `[Workflow] Auto-merge requested for task ${taskId} PR #${result.autoPRResult.prNumber} — deferred until CI passes`,
      );
    }

    // Clean up git worktree after commit/PR/merge is complete.
    // NOTE: baseDir is the worktree's parent repo, derived from worktreePath
    // (<root>/.worktrees/<name>). workingDirectory can BE the worktree since
    // resolveCommitCwd (task 774) — passing it tripped the removal guard.
    const worktreePath = latestSession?.worktreePath;
    if (worktreePath) {
      // NOTE: removeError stays undefined only on a confirmed removal — a refusal
      // (safety guard) and a thrown error both fall through to the same failure
      // branch, since either way the directory was NOT actually removed.
      let removeError: string | undefined;
      try {
        const baseDir = dirname(dirname(worktreePath));
        const removed = await orchestrator.removeWorktree(baseDir, worktreePath);
        if (!removed) removeError = 'removeWorktree refused or failed';
      } catch (cleanupError) {
        removeError = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      }

      if (removeError) {
        // NOTE: warn, not error (task 816) — cleanup failure must not fail the workflow; the cleanup scheduler retries and self-heals.
        log.warn({ err: removeError }, `[Workflow] Worktree cleanup failed: ${worktreePath}`);
        result.worktreeCleanupResult = { success: false, worktreePath, error: removeError };
      } else {
        await prisma.agentSession.update({
          where: { id: latestSession.id },
          data: { worktreePath: null },
        });
        result.worktreeCleanupResult = { success: true, worktreePath };
        log.info(`[Workflow] Worktree cleaned up for task ${taskId}: ${worktreePath}`);
      }
    }
  } catch (error) {
    log.error({ err: error }, `[Workflow] Auto-commit/PR process failed for task ${taskId}`);
  }

  return result;
}
