/**
 * Workflow Reconciler / Question Pause
 *
 * Restores an intake question pause that was silently dropped: `question.md` is
 * still live but the task's `workflowStatus` no longer says `awaiting_question`.
 * Not responsible for asking the question, rendering it, or answering it.
 */
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import { recordTransition } from './transition-recorder';
import type { WorkflowStatus } from './workflow-types';
import { readQuestionMetadata } from './question-kind-resolver';

const log = createLogger('workflow-reconciler');

/** Cause recorded for a restored pause — also the per-task attempt counter. */
export const RESTORE_QUESTION_PAUSE_CAUSE = 'reconciler_restore_question_pause';

/**
 * Give an in-flight answer time to land before healing. `handleAnswerWorkflowQuestion`
 * updates the task first and archives `question.md` a few statements later, so a
 * reconciler tick landing between those two writes would see exactly the shape we
 * heal and wrongly re-pause a task the user just answered.
 */
const QUESTION_PAUSE_SETTLE_MS = 2 * 60 * 1000;

/**
 * Stop re-pausing a task that keeps getting clobbered. Three restores mean
 * something is actively fighting the pause and a human needs to look.
 */
const MAX_RESTORES_PER_TASK = 3;

/**
 * Task states that legitimately outlive an unarchived `question.md`. Exported
 * so other question-pause-adjacent heal passes (e.g.
 * workflow-reconciler-question-auto-answer.ts) share the exact same terminal
 * set instead of redefining it and drifting apart.
 */
export const TERMINAL_TASK_STATUSES = new Set(['done', 'cancelled', 'archived']);
export const TERMINAL_WORKFLOW_STATUSES = new Set(['completed', 'verify_done']);

/**
 * Re-pause tasks whose `question.md` is still live but whose `workflowStatus`
 * was reset away from `awaiting_question` without the question being answered.
 *
 * Such a task is invisible as "waiting on a human": the status badge, the
 * blocked-cause banner and the Q&A auto-focus all key off `awaiting_question`,
 * so the question survives only as an unselected tab. The scheduler also keeps
 * re-selecting it, which is how task 656 entered an enqueue/cancel loop.
 *
 * Conservative by construction — a task is only healed when its MOST RECENT
 * transition is the one INTO `awaiting_question`, proving it entered the pause
 * and never legitimately advanced out of it.
 *
 * @param nowMs - Current time in epoch ms. / 現在時刻(epoch ms)
 * @returns Number of pauses restored. / 復元した件数
 */
export async function healOrphanedQuestionPause(nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - QUESTION_PAUSE_SETTLE_MS);

  // WorkflowFile holds only LIVE artifacts — archiving moves the row's content
  // into WorkflowFileVersion and deletes it — so a row here means "unanswered".
  const pending = await prisma.workflowFile
    .findMany({ where: { fileType: 'question' }, select: { taskId: true } })
    .catch(() => [] as { taskId: number }[]);
  if (pending.length === 0) return 0;

  let restored = 0;
  for (const { taskId } of pending) {
    const task = await prisma.task
      .findUnique({
        where: { id: taskId },
        select: { id: true, status: true, workflowStatus: true, updatedAt: true },
      })
      .catch(() => null);
    if (!task) continue;
    if (task.workflowStatus === 'awaiting_question') continue; // already consistent
    if (TERMINAL_TASK_STATUSES.has(task.status)) continue;
    if (task.workflowStatus && TERMINAL_WORKFLOW_STATUSES.has(task.workflowStatus)) continue;
    if (task.updatedAt >= cutoff) continue; // an answer may still be landing

    const latest = await prisma.workflowTransition
      .findFirst({
        where: { taskId },
        orderBy: { createdAt: 'desc' },
        select: { toStatus: true, metadata: true },
      })
      .catch(() => null);
    // Anything newer than the pause means the workflow moved on for a reason we
    // must not second-guess; only an unbroken pause is safe to restore.
    if (latest?.toStatus !== 'awaiting_question') continue;

    // Carry the original pause's kind forward (task 902) — without this, an
    // answer after this heal always falls back to the default derivation,
    // which can disagree with the kind actually recorded when the question
    // was first raised (e.g. an explicit kind embedded in question.md).
    const latestMeta = readQuestionMetadata(latest.metadata);
    const inheritedKind = typeof latestMeta?.kind === 'string' ? latestMeta.kind : undefined;

    const attempts = await prisma.workflowTransition
      .count({ where: { taskId, cause: RESTORE_QUESTION_PAUSE_CAUSE } })
      .catch(() => 0);
    if (attempts >= MAX_RESTORES_PER_TASK) {
      log.warn(
        { taskId, attempts },
        '[reconciler] Question pause keeps being cleared without an answer — leaving it for a human',
      );
      continue;
    }

    await prisma.task
      .update({
        where: { id: taskId },
        data: { workflowStatus: 'awaiting_question', updatedAt: new Date() },
      })
      .catch(() => {});
    await recordTransition({
      taskId,
      fromStatus: (task.workflowStatus ?? 'draft') as WorkflowStatus,
      toStatus: 'awaiting_question',
      actor: 'system',
      cause: RESTORE_QUESTION_PAUSE_CAUSE,
      metadata: {
        reason: 'live_question_md_without_awaiting_status',
        attempt: attempts + 1,
        ...(inheritedKind ? { kind: inheritedKind } : {}),
      },
    }).catch(() => {});
    restored++;
    log.info(
      { taskId, was: task.workflowStatus },
      '[reconciler] Restored dropped intake question pause -> awaiting_question',
    );
  }

  return restored;
}
