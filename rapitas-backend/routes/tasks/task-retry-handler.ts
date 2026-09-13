/**
 * TaskRetryHandler
 *
 * Returns a blocked/failed task to the queue in a state that can actually
 * RECORD the work its re-run produces.
 * Not responsible for dispatching the re-run itself.
 */
import { prisma } from '../../config/database';
import { ValidationError } from '../../middleware/error-handler';
import { resolveImplementEntryStatus } from '../../services/workflow/verify-self-repair';
import { recordTransition } from '../../services/workflow/transition-recorder';
import { recordRequirementReviewRetryRequest } from '../../services/workflow/requirement-review-claim';

/** Statuses a retry is allowed to act on. */
const RETRYABLE_STATUSES = new Set(['blocked', 'failed']);

/**
 * Roll the workflow back when it is parked somewhere nothing can be saved.
 *
 * Resetting `status` alone is not enough: ALLOWED_FILE_TYPES_BY_STATUS
 * .verify_done is an EMPTY set, so a task left there re-runs, works through a
 * full implementer phase, and is then refused when it PUTs verify.md ("file
 * type not allowed in current workflow status") — the run is discarded and the
 * task drifts straight back to where it started. Measured on task 632: a
 * 15.1 min / $4.15 implementer run whose result could never be recorded.
 *
 * @param taskId - Task being retried. / 再実行するタスク
 * @param workflowStatus - Its current workflowStatus. / 現在のworkflowStatus
 * @returns The status to roll back to, or null to leave it alone. / 巻き戻し先、無ければnull
 */
async function resolveRollbackTarget(
  taskId: number,
  workflowStatus: string | null,
): Promise<string | null> {
  if (workflowStatus !== 'verify_done') return null;
  // Same target the self-repair bounce uses — plan_approved when a plan exists,
  // else research_done. Both permit saving verify.
  return resolveImplementEntryStatus(taskId);
}

/**
 * Handle `POST /tasks/:id/retry`.
 *
 * @param id - Task id. / タスクID
 * @param setStatus - Setter for the HTTP status code. / HTTPステータス設定関数
 * @returns The updated task, or an error body when absent. / 更新後タスク、無ければエラー
 * @throws {ValidationError} When the task is not blocked/failed. / blocked/failed以外の場合
 */
export async function retryTask(
  id: number,
  setStatus: (code: number) => void,
  retryRequestId?: string,
): Promise<unknown> {
  const task = await prisma.task.findUnique({
    where: { id },
    select: { status: true, workflowStatus: true },
  });
  if (!task) {
    setStatus(404);
    return null;
  }
  if (!RETRYABLE_STATUSES.has(task.status)) {
    throw new ValidationError('blocked / failed のタスクのみ再実行できます');
  }

  if (retryRequestId) {
    const recorded = await recordRequirementReviewRetryRequest(prisma, id, retryRequestId);
    if (recorded === 'duplicate') {
      // The original request already owns any lifecycle mutation/evaluation.
      // Return current state without recording another transition.
      return prisma.task.findUnique({ where: { id } });
    }
  }

  const rolledBackTo = await resolveRollbackTarget(id, task.workflowStatus);
  const updated = await prisma.task.update({
    where: { id },
    data: { status: 'todo', ...(rolledBackTo ? { workflowStatus: rolledBackTo } : {}) },
  });

  // Always record the transition, even when workflowStatus is left unchanged
  // (rolledBackTo === null) — isWithinRecoveryGrace (incident-signature-detectors.ts)
  // needs this row to grant the recovery grace period. Before task 709 this
  // call only fired for the verify_done rollback case, so every other
  // workflowStatus (research_done/plan_created/plan_approved/in_progress/
  // draft/null) left `status='todo'` reset with no transition recorded, and
  // the self-incident watcher's Pattern B fired on the shape immediately
  // (task #602).
  await recordTransition({
    taskId: id,
    fromStatus: task.workflowStatus,
    toStatus: rolledBackTo ?? task.workflowStatus ?? 'draft',
    actor: 'user',
    cause: 'task_retried',
    metadata: { from: task.status },
  }).catch(() => {});

  // countPriorRepairs resets the self-repair budget at the most recent
  // `task_retried` entry, so this row is what grants the retry a fresh slate.
  await prisma.activityLog
    .create({
      data: {
        taskId: id,
        action: 'task_retried',
        metadata: JSON.stringify({ from: task.status }),
        createdAt: new Date(),
      },
    })
    .catch(() => {});

  // Mark the skip notification read — notifyOnce dedups on an UNREAD
  // notification of the same task, so leaving it unread would suppress the
  // alert if this retry fails and the task is skipped again.
  await prisma.notification
    .updateMany({
      where: {
        type: 'auto_run_task_skipped',
        isRead: false,
        metadata: { contains: `"dedupKey":"auto_run_task_skipped:${id}"` },
      },
      data: { isRead: true, readAt: new Date() },
    })
    .catch(() => {});

  return updated;
}
