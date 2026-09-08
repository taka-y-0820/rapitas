/**
 * blocked-pr-retry-recovery
 *
 * Lightweight recovery for a task blocked by `verify_pr_not_created` (task
 * 673): retry PR creation ONCE, in place, instead of the full
 * `workflowStatus:'draft'` reset that discards the already-completed
 * implementation and commit. Not responsible for the blind full-reset
 * fallback itself — see workflow-reconciler-requeue.ts's requeueBlockedTasks,
 * which calls {@link attemptPrOnlyRecovery} before that fallback and falls
 * through unchanged on failure.
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { readWorkflowFile } from './workflow-file-utils';
import { recordTransition } from './transition-recorder';
import { taskHasLinkedPr } from './workflow-cli-executor-helpers';
import { PR_RETRY_LIGHTWEIGHT_CAUSE } from './blocked-task-policy';
import { isAwaitingRequiredMerge } from './verify-settle-artifact-recovery';
import { holdForRequiredMerge } from './required-merge-hold';
import { isLatestExecutionCancelled } from './publication-cancellation-guard';

const log = createLogger('workflow:blocked-pr-retry-recovery');

/**
 * Outcome of one `attemptPrOnlyRecovery` call (task 895 repair, verifier
 * finding #1 in the 2nd repair round).
 *
 * `requeueBlockedTasks` (workflow-reconciler-requeue.ts) previously collapsed
 * every non-completion outcome to a single boolean `false` and fell through to
 * its own blind full reset (`status:'todo', workflowStatus:'draft'`) on any of
 * them — including when `canReviveBlockedPrRetry` declined because the task was
 * STOPPED. That reset re-dispatches a brand-new execution, which is exactly the
 * "後続の自動操作" AGENTS.md's stop section forbids. This type lets the caller
 * distinguish "genuinely failed, safe to fall back to the existing reset" from
 * "declined for a reason the reset must also respect".
 *
 * - `held` / `completed`: handled — do not touch the row further.
 * - `declined_stopped`: block is stop-derived (theme unarmed or the task's
 *   latest execution is cancelled) — leave the row untouched, do NOT reset.
 * - `cas_lost`: the row already moved on to a different state concurrently
 *   (another path completed it, or a stop landed mid-write) — leave it
 *   untouched; a blind reset here would overwrite whatever it moved to.
 * - `failed`: a genuine PR-creation failure — safe for the caller's existing
 *   bounded full-reset fallback to proceed unchanged.
 */
export type BlockedPrRecoveryOutcome =
  | 'held'
  | 'completed'
  | 'declined_stopped'
  | 'cas_lost'
  | 'failed';

/**
 * Whether a `blocked` task's failed-PR-creation recovery may lift it back to
 * `in-progress` (task 895 repair). `holdForRequiredMerge`'s default CAS refuses
 * `blocked` on purpose — a `blocked` row can be stop-derived, and reviving it
 * unconditionally would resurrect a task the user or theme stopped. This gate
 * re-reads BOTH the theme's arm state and the task's own latest-execution
 * cancellation fresh (not the reconciler's possibly-stale scan row), so a stop
 * that landed between the reconciler's scan and this call is honored.
 *
 * Deliberately does NOT itself decide "is this really the PR-creation-failure
 * block" — the caller (`attemptPrOnlyRecovery`) only reaches this after its own
 * evidence (a linked PR, or a just-succeeded PR creation) already confirms
 * that. This function's sole job is the stop/armed check that
 * `holdForRequiredMerge`'s default set structurally cannot express.
 *
 * @param taskId - Task currently `blocked`, about to be revived. / 復帰対象タスクID
 * @returns True when reviving from `blocked` is safe right now. / 復帰させてよい場合 true
 */
export async function canReviveBlockedPrRetry(taskId: number): Promise<boolean> {
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: { status: true, themeId: true },
    });
    // Fail CLOSED: a row that has already moved on from `blocked` (another
    // process got there first) is not this function's to revive.
    if (!task || task.status !== 'blocked') return false;
    if (task.themeId != null) {
      const run = await prisma.themeAutoRun.findUnique({
        where: { themeId: task.themeId },
        select: { enabled: true, status: true },
      });
      // A missing row or a read failure cannot prove the theme is still armed —
      // do not revive on it.
      if (!run || !run.enabled || run.status !== 'running') return false;
    }
    if (await isLatestExecutionCancelled(taskId)) return false;
    return true;
  } catch (err) {
    log.warn(
      { err, taskId },
      '[blocked-pr-retry-recovery] canReviveBlockedPrRetry read failed — fail closed (not reviving)',
    );
    return false;
  }
}

/**
 * Retry PR creation for a task blocked by `verify_pr_not_created`, without
 * resetting workflowStatus or re-running research/plan/implement. Reuses the
 * existing verify.md body and the same commit/PR pipeline the verify gates
 * already call (performAutoCommitAndPR), so this is exactly what those gates
 * would have done on a second attempt — just without duplicating the attempt
 * across two independent gate implementations (see verify-self-repair.ts's
 * hasFreshVerifyRejection, which now vetoes that duplication going forward).
 *
 * NOTE: This recovery path is NOT part of `classifyBlockedExclusion`'s
 * exclusion set (blocked-task-policy.ts) — it runs BEFORE that blind-retry
 * split. Its outcome tells the caller EXACTLY what may safely happen next:
 * `held`/`completed` mean "handled, stop"; `declined_stopped`/`cas_lost` mean
 * "do not touch this row, not even the existing full-reset fallback"; only
 * `failed` means "genuinely didn't work, the existing fallback may proceed".
 * No sync contract with classifyBlockedExclusion applies here.
 *
 * @param taskId - Task blocked by a failed PR-creation attempt. / PR作成失敗でblockedになったタスク
 * @returns The outcome — see {@link BlockedPrRecoveryOutcome}. / 結果種別
 */
export async function attemptPrOnlyRecovery(taskId: number): Promise<BlockedPrRecoveryOutcome> {
  // Another process may have already landed the PR (e.g. a concurrent manual
  // retry) — avoid a redundant second PR-creation attempt.
  if (await taskHasLinkedPr(taskId)) {
    // A requested auto-merge is not satisfied by the PR merely existing — the
    // watcher must confirm GitHub merged it, so this path must NOT complete the
    // task (task 895). holdForRequiredMerge's DEFAULT set excludes `blocked` on
    // purpose (a `blocked` row can be stop-derived) — canReviveBlockedPrRetry
    // re-confirms the theme/execution are not stopped before this recovery is
    // allowed to widen that set for THIS task. A decline here is reported as
    // `declined_stopped`, NOT the same `false`/`failed` a genuine PR-creation
    // failure gets — collapsing them previously let the caller's blind full
    // reset re-dispatch a new execution over a stopped task (task 895 verifier
    // finding, 2nd repair round).
    if (await isAwaitingRequiredMerge(taskId).catch(() => true)) {
      if (!(await canReviveBlockedPrRetry(taskId))) {
        log.info(
          { taskId },
          '[blocked-pr-retry-recovery] Required-merge hold skipped — block is stop-derived or the task already moved on',
        );
        return 'declined_stopped';
      }
      const held = await holdForRequiredMerge({
        taskId,
        fromStatus: 'verify_done',
        source: 'blocked-pr-retry-recovery',
        fromStatusIn: ['blocked'],
        metadata: { lightweightRetry: true, reason: 'PR already linked' },
      });
      if (!held) {
        log.warn(
          { taskId },
          '[blocked-pr-retry-recovery] Required-merge hold CAS lost — task moved on concurrently, not claiming recovery',
        );
        return 'cas_lost';
      }
      return 'held';
    }
    const completed = await prisma.task
      .updateMany({
        where: { id: taskId, workflowStatus: 'verify_done' },
        data: { status: 'done', workflowStatus: 'completed', completedAt: new Date() },
      })
      .catch(() => ({ count: 0 }));
    if (completed.count > 0) {
      await recordTransition({
        taskId,
        fromStatus: 'verify_done',
        toStatus: 'completed',
        actor: 'system',
        cause: 'verify_passed',
        phase: 'verify',
        metadata: { lightweightRetry: true, reason: 'PR already linked' },
      });
      log.info({ taskId }, '[blocked-pr-retry-recovery] PR already linked — completed in place');
    }
    return 'completed';
  }

  const verifyContent = (await readWorkflowFile(taskId, 'verify')) ?? '';

  // Dynamic import avoids a routes↔services import cycle (mirrors
  // workflow-cli-executor-verify-gate.ts's own performAutoCommitAndPR call).
  const { performAutoCommitAndPR } = await import('../../routes/workflow/workflow-auto-commit');
  const acpr = await performAutoCommitAndPR(taskId, verifyContent).catch(
    () => ({}) as Awaited<ReturnType<typeof performAutoCommitAndPR>>,
  );
  const prSatisfied = acpr.autoPRResult?.success === true || (await taskHasLinkedPr(taskId));

  if (!prSatisfied) {
    await recordTransition({
      taskId,
      fromStatus: 'verify_done',
      toStatus: 'verify_done',
      actor: 'system',
      cause: PR_RETRY_LIGHTWEIGHT_CAUSE,
      phase: 'verify',
      metadata: {
        commit: acpr.autoCommitResult?.success,
        prError: acpr.autoPRResult?.error,
        error: acpr.error,
      },
    });
    log.warn(
      { taskId, prError: acpr.autoPRResult?.error, error: acpr.error },
      '[blocked-pr-retry-recovery] Lightweight PR retry failed — falling through to existing fallback',
    );
    return 'failed';
  }

  // Same required-merge gate as the already-linked branch above: a freshly
  // created PR is a publication step, not the completion point. Re-check
  // canReviveBlockedPrRetry HERE (not reused from above) — performAutoCommitAndPR
  // just ran and can take minutes, so the stop/armed state must be re-read fresh
  // immediately before this write, not assumed from before the commit/PR call.
  if (await isAwaitingRequiredMerge(taskId).catch(() => true)) {
    if (!(await canReviveBlockedPrRetry(taskId))) {
      log.info(
        { taskId },
        '[blocked-pr-retry-recovery] Required-merge hold skipped after PR creation — block is stop-derived or the task already moved on',
      );
      return 'declined_stopped';
    }
    const held = await holdForRequiredMerge({
      taskId,
      fromStatus: 'verify_done',
      source: 'blocked-pr-retry-recovery',
      fromStatusIn: ['blocked'],
      metadata: {
        lightweightRetry: true,
        commit: acpr.autoCommitResult?.success,
        pr: acpr.autoPRResult?.success,
      },
    });
    if (!held) {
      log.warn(
        { taskId },
        '[blocked-pr-retry-recovery] Required-merge hold CAS lost after PR creation — task moved on concurrently, not claiming recovery',
      );
      return 'cas_lost';
    }
    return 'held';
  }

  // Compare-and-swap on verify_done (verify-commit-pr-pipeline.ts's
  // noChangeCompletion pattern): a concurrent HTTP pipeline run may complete
  // the same task between the checks above and here.
  const completed = await prisma.task
    .updateMany({
      where: { id: taskId, workflowStatus: 'verify_done' },
      data: { status: 'done', workflowStatus: 'completed', completedAt: new Date() },
    })
    .catch(() => ({ count: 0 }));
  if (completed.count === 0) {
    log.warn(
      { taskId },
      '[blocked-pr-retry-recovery] Task already completed by a concurrent run — skipping duplicate transition',
    );
    return 'completed';
  }

  await recordTransition({
    taskId,
    fromStatus: 'verify_done',
    toStatus: 'completed',
    actor: 'system',
    cause: 'verify_passed',
    phase: 'verify',
    metadata: {
      lightweightRetry: true,
      commit: acpr.autoCommitResult?.success,
      pr: acpr.autoPRResult?.success,
    },
  });
  log.info(
    { taskId, prUrl: acpr.autoPRResult?.prUrl },
    '[blocked-pr-retry-recovery] Lightweight PR retry succeeded — task completed without a full reset',
  );
  return 'completed';
}
