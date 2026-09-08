/**
 * workflow-reconciler-requeue
 *
 * Recovery heals that put a stranded task back on the auto-run path: orphaned
 * in-progress tasks, bounded blocked-task retries, and undispatchable
 * status/workflowStatus desyncs. Called only from the workflow-reconciler's
 * periodic pass — NOT responsible for scheduling or detection cadence.
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { recordTransition } from './transition-recorder';
// NOTE: Thresholds live in blocked-task-policy (task 615) so the evidence /
// escalation passes share the same constants — behavior here is unchanged.
import {
  BLOCKED_RETRY_SETTLE_MS,
  MAX_ORPHAN_REQUEUE_AGE_MS,
  MAX_BLOCKED_RETRY,
  MAX_PR_RECOVERY_ATTEMPTS,
  resolveVerifyRepairLimit,
  VERIFY_NON_CONVERGENCE_CAUSE,
  PR_RETRY_LIGHTWEIGHT_CAUSE,
} from './blocked-task-policy';
import { isAwaitingRequiredMerge } from './verify-settle-artifact-recovery';

const log = createLogger('workflow-reconciler');

/** Execution statuses that represent a still-alive agent. */
export const ACTIVE_EXEC = ['running', 'pending', 'waiting_for_input'];

/** An in-progress task idle this long with no live execution is surfaced. */
export const STALE_TASK_MS = 45 * 60 * 1000;

/** Re-queue an orphan at most this many times before leaving it for notification. */
const MAX_ORPHAN_REQUEUE = 2;
/**
 * A todo task must sit in an undispatchable workflowStatus this long before a
 * reset — no legitimate in-flight completion could still be settling by then.
 */
const UNDISPATCHABLE_SETTLE_MS = 24 * 60 * 60 * 1000;

/** True when the task still has a live agent execution. */
async function hasLiveExecution(taskId: number): Promise<boolean> {
  const live = await prisma.agentExecution.findFirst({
    where: { session: { config: { taskId } }, status: { in: ACTIVE_EXEC } },
    select: { id: true },
  });
  return !!live;
}

/**
 * Orphan recovery: re-queue a genuinely-stuck in-progress task (no live agent,
 * stale, non-terminal workflowStatus) back to 'todo' so auto-run reruns it.
 * Guards: skips completed (healed elsewhere) and awaiting_question (paused),
 * skips ANCIENT orphans (likely abandoned), and caps re-queues so an orphan that
 * keeps dying isn't requeued forever — after the cap, flagOrphanTasks notifies.
 *
 * @param nowMs - Current time (ms). / 現在時刻
 * @returns Number of tasks re-queued. / 再キュー数
 */
export async function requeueOrphanTasks(
  nowMs: number,
  excludedTaskIds: ReadonlySet<number> = new Set(),
): Promise<number> {
  const staleBefore = new Date(nowMs - STALE_TASK_MS);
  const notOlderThan = new Date(nowMs - MAX_ORPHAN_REQUEUE_AGE_MS);
  const tasks = await prisma.task
    .findMany({
      where: {
        status: 'in-progress',
        parentId: null,
        updatedAt: { lt: staleBefore, gt: notOlderThan },
      },
      select: { id: true, title: true, workflowStatus: true },
    })
    .catch(() => [] as { id: number; title: string; workflowStatus: string | null }[]);

  let requeued = 0;
  for (const t of tasks) {
    // Do not bypass a failed repair receipt check through generic recovery.
    if (excludedTaskIds.has(t.id)) continue;
    if (t.workflowStatus === 'completed' || t.workflowStatus === 'awaiting_question') continue;
    // A task parked at verify_done/in-progress can be legitimately AWAITING the
    // AutoMergeWatcher's confirmation (task 895), not orphaned — its PENDING_TIMEOUT_MS
    // (90 min) is longer than STALE_TASK_MS (45 min), so this scan would otherwise
    // reset it to 'todo' mid-wait and dispatch a duplicate execution while the
    // original PR is still pending CI/merge. Fail-closed: an unreadable policy
    // must not be read as "not awaiting a merge".
    if (
      t.workflowStatus === 'verify_done' &&
      (await isAwaitingRequiredMerge(t.id).catch(() => true))
    ) {
      continue;
    }
    if (await hasLiveExecution(t.id)) continue;
    // A committed repair may just have been delivered by the preceding heal pass.
    if (
      await prisma.workflowQueueItem.findFirst({
        where: {
          taskId: t.id,
          status: { in: ['queued', 'running', 'waiting_approval'] },
        },
        select: { id: true },
      })
    )
      continue;

    const attempts = await prisma.workflowTransition.count({
      where: { taskId: t.id, cause: 'reconciler_requeue' },
    });
    if (attempts >= MAX_ORPHAN_REQUEUE) continue;

    await prisma.task.update({
      where: { id: t.id },
      data: { status: 'todo', updatedAt: new Date() },
    });
    await recordTransition({
      taskId: t.id,
      fromStatus: t.workflowStatus,
      toStatus: t.workflowStatus ?? 'draft',
      actor: 'system',
      cause: 'reconciler_requeue',
      metadata: { reason: 'orphan_in_progress_no_execution', attempt: attempts + 1 },
    }).catch(() => {});
    requeued++;
    log.info(
      { taskId: t.id, attempt: attempts + 1, wf: t.workflowStatus },
      '[reconciler] Re-queued orphaned in-progress task -> todo',
    );
  }
  return requeued;
}

/**
 * Self-healing for the perpetual loop: auto-retry BLOCKED auto-created tasks so
 * a since-fixed bug no longer strands them holding the backlog-promotion cap.
 * Bounded by MAX_BLOCKED_RETRY; armed themes only (a user STOP is respected),
 * after a settle delay. Resets to 'todo' + workflowStatus 'draft' (research/
 * plan are reused via isReusableArtifact, so the re-run is cheap).
 *
 * @param nowMs - Current time (ms). / 現在時刻
 * @returns Number of tasks retried. / 再試行数
 */
export async function requeueBlockedTasks(nowMs: number): Promise<number> {
  const settleBefore = new Date(nowMs - BLOCKED_RETRY_SETTLE_MS);
  const notOlderThan = new Date(nowMs - MAX_ORPHAN_REQUEUE_AGE_MS);

  // Respect user stops: only retry blocked tasks in themes that are still armed.
  const armed = await prisma.themeAutoRun
    .findMany({ where: { enabled: true, status: 'running' }, select: { themeId: true } })
    .catch(() => [] as { themeId: number }[]);
  const armedThemeIds = armed.map((a) => a.themeId);
  if (armedThemeIds.length === 0) return 0;

  // The verify->implement repair budget: a task that EXHAUSTED it needs
  // splitting / human attention, not auto-retry (re-queuing repeats the same
  // doomed cycle). Read via cast (column pending client regen).
  const settings = (await prisma.userSettings.findFirst().catch(() => null)) as {
    verifyRepairLimit?: number | null;
  } | null;
  const verifyRepairLimit = resolveVerifyRepairLimit(settings);

  const tasks = await prisma.task
    .findMany({
      where: {
        status: 'blocked',
        parentId: null,
        themeId: { in: armedThemeIds },
        updatedAt: { lt: settleBefore, gt: notOlderThan },
      },
      select: { id: true, workflowStatus: true },
    })
    .catch(() => [] as { id: number; workflowStatus: string | null }[]);

  let retried = 0;
  for (const t of tasks) {
    // A live agent means it's not really stuck — skip.
    if (await hasLiveExecution(t.id)) continue;

    // Skip tasks PAUSED for the USER's answer. A blocked task whose workflowStatus
    // is 'awaiting_question' is not "stuck-blocked" — it is waiting for human input.
    // Auto-retrying it resets the workflow to draft, DESTROYS the pending question,
    // re-raises it, and loops (intake_question → blocked_auto_retry → intake_question
    // …, observed: task 363). It resumes via the answer-question endpoint, never a
    // blind retry — so leave it paused.
    if (t.workflowStatus === 'awaiting_question') continue;

    // Skip tasks that exhausted verify-repair — re-running repeats the same
    // failing implement→verify cycle (the task is too hard, needs splitting, not
    // blind retry). Count since the last manual retry so a user re-try grants a
    // fresh budget (mirrors verify-self-repair's countPriorRepairs).
    const lastRetry = await prisma.activityLog
      .findFirst({
        where: { taskId: t.id, action: 'task_retried' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })
      .catch(() => null);
    const repairs = await prisma.workflowTransition
      .count({
        where: {
          taskId: t.id,
          cause: 'verify_repair',
          ...(lastRetry ? { createdAt: { gt: lastRetry.createdAt } } : {}),
        },
      })
      .catch(() => 0);
    if (repairs >= verifyRepairLimit) {
      log.info(
        { taskId: t.id, repairs, verifyRepairLimit },
        '[reconciler] Blocked task exhausted verify-repair — leaving blocked (needs split/manual), not auto-retrying',
      );
      continue;
    }

    // Skip tasks CUT OFF for non-convergence (task 619): the same acceptance
    // criterion was flagged by 2+ repair bounces, so a blind retry would just
    // replay the treading-water loop and re-trigger the same cutoff. Same
    // window as the repair budget (reset by a manual retry).
    const nonConverged = await prisma.workflowTransition
      .count({
        where: {
          taskId: t.id,
          cause: VERIFY_NON_CONVERGENCE_CAUSE,
          ...(lastRetry ? { createdAt: { gt: lastRetry.createdAt } } : {}),
        },
      })
      .catch(() => 0);
    if (nonConverged > 0) {
      log.info(
        { taskId: t.id, nonConverged },
        '[reconciler] Blocked task was cut off for non-convergence — leaving blocked (needs split/spec revision), not auto-retrying',
      );
      continue;
    }

    // PR-creation-recovery exhaustion (task 713): unwindowed, so a full reset
    // does not reset this count — the PR-creation failure pattern persists
    // across resets even though the implementation gets discarded. Checked
    // BEFORE the lightweight retry below so an exhausted task stops
    // attempting PR creation entirely (matches classifyBlockedExclusion's
    // pr_recovery_exhausted, which then escalates it on the next pass).
    const totalPrNotCreated = await prisma.workflowTransition
      .count({ where: { taskId: t.id, cause: 'verify_pr_not_created' } })
      .catch(() => 0);
    if (totalPrNotCreated >= MAX_PR_RECOVERY_ATTEMPTS) {
      log.info(
        { taskId: t.id, totalPrNotCreated },
        '[reconciler] Blocked task exhausted PR-creation recovery — leaving blocked for escalation, not auto-retrying',
      );
      continue;
    }

    // Lightweight PR-only recovery (task 673/681): before the full reset
    // below discards an already-completed implementation, try ONE lightweight
    // PR retry for a task blocked purely by a failed PR-creation attempt.
    // Runs BEFORE the attempts/MAX_BLOCKED_RETRY check so it never consumes
    // that (full-reset) budget, and still applies once that budget is
    // exhausted — an exhausted full-reset budget says nothing about whether
    // the PR-only path was ever tried. Gated to exactly one attempt per
    // window via the PR_RETRY_LIGHTWEIGHT_CAUSE count.
    const prNotCreated = await prisma.workflowTransition
      .count({
        where: {
          taskId: t.id,
          cause: 'verify_pr_not_created',
          ...(lastRetry ? { createdAt: { gt: lastRetry.createdAt } } : {}),
        },
      })
      .catch(() => 0);
    if (prNotCreated > 0) {
      const lightweightAttempted = await prisma.workflowTransition
        .count({
          where: {
            taskId: t.id,
            cause: PR_RETRY_LIGHTWEIGHT_CAUSE,
            ...(lastRetry ? { createdAt: { gt: lastRetry.createdAt } } : {}),
          },
        })
        .catch(() => 0);
      if (lightweightAttempted === 0) {
        const { attemptPrOnlyRecovery } = await import('./blocked-pr-retry-recovery');
        const outcome = await attemptPrOnlyRecovery(t.id).catch((err) => {
          log.warn({ err, taskId: t.id }, '[reconciler] Lightweight PR retry threw');
          return 'failed' as const;
        });
        if (outcome === 'held' || outcome === 'completed') {
          retried++;
          log.info(
            { taskId: t.id, outcome },
            '[reconciler] Lightweight PR retry recovered blocked task (no full reset)',
          );
          continue;
        }
        // 'declined_stopped' (theme/task stopped) and 'cas_lost' (row already
        // moved on concurrently) must NOT fall through to the blind full reset
        // below — resetting either would re-dispatch a brand-new execution,
        // which is exactly the post-stop automatic action AGENTS.md forbids, or
        // would overwrite whatever state the row concurrently moved to (task
        // 895 verifier finding, 2nd repair round). Only a genuine 'failed'
        // (real PR-creation failure) is safe for the existing fallback below.
        if (outcome === 'declined_stopped' || outcome === 'cas_lost') {
          log.info(
            { taskId: t.id, outcome },
            '[reconciler] Lightweight PR retry declined (stop-derived or concurrent state change) — leaving blocked untouched, not falling through to full reset',
          );
          continue;
        }
      }
    }

    const attempts = await prisma.workflowTransition
      .count({ where: { taskId: t.id, cause: 'blocked_auto_retry' } })
      .catch(() => 0);
    if (attempts >= MAX_BLOCKED_RETRY) continue;

    await prisma.task
      .update({
        where: { id: t.id },
        data: { status: 'todo', workflowStatus: 'draft', updatedAt: new Date() },
      })
      .catch(() => {});
    await recordTransition({
      taskId: t.id,
      fromStatus: t.workflowStatus,
      toStatus: 'draft',
      actor: 'system',
      cause: 'blocked_auto_retry',
      metadata: { reason: 'blocked_task_auto_retry', attempt: attempts + 1 },
    }).catch(() => {});
    retried++;
    log.info(
      { taskId: t.id, attempt: attempts + 1, wf: t.workflowStatus },
      '[reconciler] Auto-retried blocked task -> todo (draft)',
    );
  }
  return retried;
}

/**
 * Heal undispatchable status/workflowStatus desyncs on todo tasks.
 *
 * Class 1 — todo × verify_done: `verify_done` has NO entry in the transition
 * table, so such a task can never be dispatched — every auto-run selection
 * fails and repeats forever (observed: tasks 5/8/11 parked since May). Reset
 * workflowStatus to 'draft' (artifacts are reused via isReusableArtifact, so
 * the re-run is cheap and completes properly this time).
 *
 * Class 2 — todo × completed: the workflow finished but the task row's status
 * was never finalized — finalize to done so it stops being re-selected.
 *
 * Both classes require 24h staleness and no live execution. Class 1 is
 * additionally bounded to one reset per task.
 *
 * @param nowMs - Current time (ms). / 現在時刻
 * @returns Number of tasks healed. / 修復数
 */
export async function healUndispatchableTodo(nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - UNDISPATCHABLE_SETTLE_MS);
  let healed = 0;

  const stranded = await prisma.task
    .findMany({
      where: {
        status: 'todo',
        workflowStatus: 'verify_done',
        parentId: null,
        updatedAt: { lt: cutoff },
      },
      select: { id: true },
    })
    .catch(() => [] as { id: number }[]);
  for (const t of stranded) {
    if (await hasLiveExecution(t.id)) continue;
    const attempts = await prisma.workflowTransition
      .count({ where: { taskId: t.id, cause: 'reconciler_reset_undispatchable' } })
      .catch(() => 0);
    if (attempts >= 1) continue; // one reset per task — a re-strand needs a human look
    await prisma.task
      .update({
        where: { id: t.id },
        data: { workflowStatus: 'draft', updatedAt: new Date() },
      })
      .catch(() => {});
    await recordTransition({
      taskId: t.id,
      fromStatus: 'verify_done',
      toStatus: 'draft',
      actor: 'system',
      cause: 'reconciler_reset_undispatchable',
      metadata: { reason: 'todo_verify_done_has_no_transition' },
    }).catch(() => {});
    healed++;
    log.info(
      { taskId: t.id },
      '[reconciler] Reset undispatchable todo×verify_done task -> draft (artifacts reused on re-run)',
    );
  }

  const finished = await prisma.task
    .findMany({
      where: {
        status: 'todo',
        workflowStatus: 'completed',
        parentId: null,
        updatedAt: { lt: cutoff },
      },
      select: { id: true, completedAt: true },
    })
    .catch(() => [] as { id: number; completedAt: Date | null }[]);
  for (const t of finished) {
    if (await hasLiveExecution(t.id)) continue;
    await prisma.task
      .update({
        where: { id: t.id },
        data: { status: 'done', completedAt: t.completedAt ?? new Date() },
      })
      .catch(() => {});
    healed++;
    log.info(
      { taskId: t.id },
      '[reconciler] Healed completion desync (todo + wf=completed) -> done',
    );
  }

  return healed;
}
