/**
 * workflow-reconciler-blocked
 *
 * Blocked-task heal passes around the blind retry (task 615). Order contract
 * within one reconciler cycle — do not re-order:
 *   1. correctBlockedByEvidence  — corrects PROVEN-successful blocked tasks to
 *      done (no re-run, no duplicate PR), removing them before the retry runs.
 *   2. healBlockedStatusDesync   — restores `status` to `todo` for tasks a
 *      human already pushed forward via `workflowStatus` (task 802) while
 *      `status` stayed `blocked`, BEFORE the blind retry sees them — this
 *      keeps the two passes' `status:'blocked'` candidate query mutually
 *      exclusive across one cycle instead of racing on the same rows.
 *   3. requeueBlockedTasks       — blind retry of the evidence-less remainder
 *      (workflow-reconciler-requeue, unchanged).
 *   4. escalateAbandonedBlocked  — one-shot escalation of what retry will NOT
 *      touch (awaiting_question / exhausted budget / retry cap / too old), so
 *      exclusion no longer means abandonment; when a task was ALREADY
 *      escalated in a prior cycle, this same pass instead checks whether the
 *      re-escalation interval has elapsed (task 703 — bounds how long a task
 *      can sit silently blocked past its first notification).
 * Not responsible for scheduling — called only from workflow-reconciler.
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { recordTransition } from './transition-recorder';
import { ACTIVE_EXEC } from './workflow-reconciler-requeue';
import {
  BLOCKED_RETRY_SETTLE_MS,
  classifyBlockedExclusion,
  HUMAN_ADVANCED_WORKFLOW_STATUSES,
  resolveVerifyRepairLimit,
  VERIFY_NON_CONVERGENCE_CAUSE,
} from './blocked-task-policy';
import { resolveBlockedTaskEvidence } from './blocked-task-evidence';
import { resolveAutomationPolicy } from './automation-policy';
import { escalateBlockedTask, reescalateIfOverdue } from './blocked-task-escalation';

const log = createLogger('workflow-reconciler');

/** Transition cause for an evidence-based done correction. */
export const BLOCKED_EVIDENCE_DONE_CAUSE = 'blocked_evidence_done';

/** True when the task still has a live agent execution (requeue-consistent). */
async function hasLiveExecution(taskId: number): Promise<boolean> {
  const live = await prisma.agentExecution
    .findFirst({
      where: { session: { config: { taskId } }, status: { in: ACTIVE_EXEC } },
      select: { id: true },
    })
    .catch(() => null);
  return !!live;
}

/** Blocked candidates for both passes: armed themes, settle elapsed, NO upper age bound. */
async function findBlockedCandidates(nowMs: number): Promise<
  {
    id: number;
    title: string;
    themeId: number | null;
    workflowStatus: string | null;
    completedAt: Date | null;
    updatedAt: Date;
  }[]
> {
  // Respect user stops: only heal blocked tasks in themes that are still armed.
  const armed = await prisma.themeAutoRun
    .findMany({ where: { enabled: true, status: 'running' }, select: { themeId: true } })
    .catch(() => [] as { themeId: number }[]);
  const armedThemeIds = armed.map((a) => a.themeId);
  if (armedThemeIds.length === 0) return [];

  // Unlike the retry query there is deliberately NO `gt: notOlderThan` bound:
  // an old blocked task must stay visible to correction/escalation forever —
  // aging out of the query was exactly the abandonment being fixed (task 615).
  const settleBefore = new Date(nowMs - BLOCKED_RETRY_SETTLE_MS);
  return prisma.task
    .findMany({
      where: {
        status: 'blocked',
        parentId: null,
        themeId: { in: armedThemeIds },
        updatedAt: { lt: settleBefore },
      },
      select: {
        id: true,
        title: true,
        themeId: true,
        workflowStatus: true,
        completedAt: true,
        updatedAt: true,
      },
    })
    .catch(
      () =>
        [] as {
          id: number;
          title: string;
          themeId: number | null;
          workflowStatus: string | null;
          completedAt: Date | null;
          updatedAt: Date;
        }[],
    );
}

/**
 * Correct blocked tasks with decisive success evidence to done — the machine
 * version of what the operator did by hand for 6 tasks on 2026-08-16: check
 * the PR, and when the work provably landed, finalize instead of re-running
 * (a blind retry would open a duplicate PR; not retrying would discard a
 * finished implementation).
 *
 * Includes `awaiting_question` tasks ON PURPOSE: correction is NOT a blind
 * retry — it never resets workflowStatus to draft and never touches the
 * pending question, it only finalizes status directly (observed: #578→PR376 /
 * #576→PR381 were awaiting_question AND already succeeded). Ambiguous
 * evidence corrects nothing (fail-closed).
 *
 * @param nowMs - Current time (ms). / 現在時刻
 * @returns Number of tasks corrected to done. / 是正件数
 */
export async function correctBlockedByEvidence(nowMs: number): Promise<number> {
  const tasks = await findBlockedCandidates(nowMs);
  let corrected = 0;
  for (const t of tasks) {
    // A live agent means it's not really stuck — skip.
    if (await hasLiveExecution(t.id)) continue;

    const evidence = await resolveBlockedTaskEvidence(prisma, t.id);
    if (!evidence.isSuccess) continue;

    // Local PR rows cannot prove a required remote merge. The authoritative
    // merge watcher owns that completion; an unreadable policy also withholds it.
    const policy = await resolveAutomationPolicy(prisma, t.id).catch(() => null);
    if (!policy || policy.autoMergePR) continue;

    await prisma.task
      .update({
        where: { id: t.id },
        data: {
          status: 'done',
          workflowStatus: 'completed',
          completedAt: t.completedAt ?? new Date(),
          updatedAt: new Date(),
        },
      })
      .catch(() => {});
    await recordTransition({
      taskId: t.id,
      fromStatus: t.workflowStatus,
      toStatus: 'completed',
      actor: 'system',
      cause: BLOCKED_EVIDENCE_DONE_CAUSE,
      metadata: { source: evidence.source, prState: evidence.prState ?? null },
    }).catch(() => {});
    corrected++;
    log.info(
      { taskId: t.id, source: evidence.source, prState: evidence.prState },
      '[reconciler] Corrected blocked task with success evidence -> done (no re-run)',
    );
  }
  return corrected;
}

/** Transition cause recorded when {@link healBlockedStatusDesync} restores `status`. */
export const STATUS_DESYNC_HEALED_CAUSE = 'status_desync_healed';

/**
 * Restores `Task.status` to `todo` for tasks a human already pushed forward
 * via `PUT /tasks/:id/status` (`workflowStatus`) while `status` stayed
 * `blocked` — the two fields are updated independently by that endpoint (task
 * 802: task #800 sat invisible to the auto-run scheduler for 45.1 min because
 * `status='blocked'` excludes a task from `selectNextTask` regardless of how
 * far `workflowStatus` has advanced).
 *
 * Only touches `status`; `workflowStatus` is left exactly as the human set
 * it — the human's forward progress is the thing being trusted here, not
 * discarded like {@link requeueBlockedTasks}'s blind full reset would.
 *
 * @param nowMs - Current time (ms). / 現在時刻
 * @returns Number of tasks healed this cycle. / 復旧件数
 */
export async function healBlockedStatusDesync(nowMs: number): Promise<number> {
  const tasks = await findBlockedCandidates(nowMs);
  const candidates = tasks.filter(
    (t): t is typeof t & { workflowStatus: string } =>
      t.workflowStatus != null && HUMAN_ADVANCED_WORKFLOW_STATUSES.includes(t.workflowStatus),
  );
  if (candidates.length === 0) return 0;

  let healed = 0;
  for (const t of candidates) {
    if (await hasLiveExecution(t.id)) continue;

    const lastBlocked = await prisma.workflowTransition
      .findFirst({
        where: { taskId: t.id, toStatus: 'blocked' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      })
      .catch(() => null);
    // No 'blocked' transition on record at all — can't establish that a user
    // transition happened AFTER the block, so don't guess (fail closed).
    if (!lastBlocked) continue;

    const userAdvance = await prisma.workflowTransition
      .findFirst({
        where: {
          taskId: t.id,
          actor: 'user',
          createdAt: { gt: lastBlocked.createdAt },
        },
        select: { id: true },
      })
      .catch(() => null);
    if (!userAdvance) continue;

    await prisma.task
      .update({ where: { id: t.id }, data: { status: 'todo', updatedAt: new Date() } })
      .catch(() => {});
    await recordTransition({
      taskId: t.id,
      fromStatus: t.workflowStatus,
      toStatus: t.workflowStatus,
      actor: 'system',
      cause: STATUS_DESYNC_HEALED_CAUSE,
      metadata: { blockedAt: lastBlocked.createdAt.toISOString() },
    }).catch(() => {});
    healed++;
    log.info(
      { taskId: t.id, workflowStatus: t.workflowStatus },
      '[reconciler] Healed status/workflowStatus desync -> status: todo',
    );
  }
  return healed;
}

/**
 * One-shot escalation for blocked tasks the blind retry will not touch.
 * Skips tasks with success evidence (the correction pass owns those) and
 * tasks classified retryable (requeueBlockedTasks owns those — escalating
 * them too would duplicate handling, premortem #2). Everything else gets
 * exactly one escalation via escalateBlockedTask's permanent gate.
 *
 * @param nowMs - Current time (ms). / 現在時刻
 * @returns Number of tasks escalated this cycle. / エスカレーション件数
 */
export async function escalateAbandonedBlocked(nowMs: number): Promise<number> {
  const tasks = await findBlockedCandidates(nowMs);
  if (tasks.length === 0) return 0;

  const settings = (await prisma.userSettings.findFirst().catch(() => null)) as {
    verifyRepairLimit?: number | null;
  } | null;
  const verifyRepairLimit = resolveVerifyRepairLimit(settings);

  let escalated = 0;
  for (const t of tasks) {
    if (await hasLiveExecution(t.id)) continue;

    // Double safety: a success-evidence task belongs to the correction pass
    // (this cycle or the next) — never escalate a task that in fact succeeded.
    const evidence = await resolveBlockedTaskEvidence(prisma, t.id);
    if (evidence.isSuccess) continue;

    // Mirror requeueBlockedTasks' budget accounting (count since last manual
    // retry) so classification cannot drift from what retry actually does.
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
    const attempts = await prisma.workflowTransition
      .count({ where: { taskId: t.id, cause: 'blocked_auto_retry' } })
      .catch(() => 0);

    // Unwindowed, mirroring requeueBlockedTasks' totalPrNotCreated (task
    // 713) — a full reset does not reset this count, so classification stays
    // in sync with what retry actually stopped attempting.
    const prNotCreatedCount = await prisma.workflowTransition
      .count({ where: { taskId: t.id, cause: 'verify_pr_not_created' } })
      .catch(() => 0);

    // Mirror requeueBlockedTasks' non-convergence skip (task 619, same window)
    // so the classifier sees exactly the signal retry acted on — a drift here
    // would double-handle or abandon the cutoff task.
    const nonConvergedCount = await prisma.workflowTransition
      .count({
        where: {
          taskId: t.id,
          cause: VERIFY_NON_CONVERGENCE_CAUSE,
          ...(lastRetry ? { createdAt: { gt: lastRetry.createdAt } } : {}),
        },
      })
      .catch(() => 0);

    const classification = classifyBlockedExclusion({
      workflowStatus: t.workflowStatus,
      ageMs: nowMs - t.updatedAt.getTime(),
      repairs,
      verifyRepairLimit,
      attempts,
      nonConverged: nonConvergedCount > 0,
      prNotCreatedCount,
    });
    if (classification === 'retryable') continue; // requeueBlockedTasks owns it

    const did = await escalateBlockedTask(
      prisma,
      { id: t.id, title: t.title, themeId: t.themeId },
      classification,
      nowMs,
      undefined,
      t.workflowStatus,
    );
    if (did) {
      escalated++;
      continue;
    }

    // Already escalated in a prior cycle — check whether it is overdue for a
    // periodic re-notification instead (task 703).
    const reescalated = await reescalateIfOverdue(
      prisma,
      { id: t.id, title: t.title, themeId: t.themeId },
      classification,
      nowMs,
      undefined,
      t.workflowStatus,
    );
    if (reescalated) escalated++;
  }
  return escalated;
}
