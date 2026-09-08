/**
 * required-merge-hold
 *
 * The single write that every completion path uses when `autoMergePR` was
 * requested and the PR exists but GitHub has not merged it yet: park the task at
 * `verify_done` / `in-progress` so the AutoMergeWatcher owns its completion.
 * Not responsible for DECIDING that a merge is required — that is
 * `isAwaitingRequiredMerge` (verify-settle-artifact-recovery.ts) — nor for
 * completing the task once the merge lands.
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { recordTransition, type TransitionActor } from './transition-recorder';

const log = createLogger('workflow:required-merge-hold');

/**
 * Transition cause recorded whenever a completion path defers to the merge
 * watcher. Distinct from `verify_passed` (completed) and
 * `verify_pr_not_created` (blocked, no PR): here the PR exists and verification
 * passed — only the REQUESTED merge is outstanding.
 */
export const AWAITING_REQUIRED_MERGE_CAUSE = 'verify_awaiting_required_merge';

/**
 * Hold a verified task at `verify_done` until its required merge is confirmed.
 *
 * The written shape (`status: 'in-progress'`, `workflowStatus: 'verify_done'`)
 * is exactly what auto-merge-candidates.ts's `isAwaitingCi` predicate looks for,
 * so a held task is picked up by the watcher on its next tick. The update is
 * CONDITIONAL: a task another path already completed, or one that was
 * cancelled/archived meanwhile, is left alone rather than resurrected.
 *
 * @param p.taskId - Task to hold. / 保留するタスクID
 * @param p.fromStatus - Workflow status the caller observed. / 呼び出し元が見たワークフロー状態
 * @param p.actor - Transition actor (defaults to `system`). / 遷移の実行主体
 * @param p.sessionId - Session to attribute the transition to, if any. / 紐づけるセッションID
 * @param p.source - Caller name, for the log line. / 呼び出し元の名前（ログ用）
 * @param p.metadata - Extra transition metadata. / 追加メタデータ
 * @param p.fromStatusIn - Task.status values eligible for this CAS. Defaults to
 *   the set every ordinary caller uses (`todo`/`in-progress`/`in_progress`).
 *   Widening this (e.g. to include `blocked`) is the caller's decision AND the
 *   caller's responsibility: this function does not itself re-derive whether a
 *   `blocked` row is stop-derived — see blocked-pr-retry-recovery.ts's
 *   `canReviveBlockedPrRetry`, which must be checked before passing a widened
 *   set. Never pass a status here that this function has not been explicitly
 *   asked to trust. / このCASが許容する Task.status の集合（既定は変更しない）
 * @returns True when this call actually parked the task. / 実際に保留した場合 true
 */
export async function holdForRequiredMerge(p: {
  taskId: number;
  fromStatus: string | null;
  actor?: TransitionActor;
  sessionId?: number;
  source: string;
  metadata?: Record<string, unknown>;
  fromStatusIn?: string[];
}): Promise<boolean> {
  const held = await prisma.task
    .updateMany({
      where: {
        id: p.taskId,
        workflowStatus: p.fromStatus,
        status: { in: p.fromStatusIn ?? ['todo', 'in-progress', 'in_progress'] },
      },
      data: { status: 'in-progress', workflowStatus: 'verify_done', updatedAt: new Date() },
    })
    .catch((err) => {
      log.warn({ err, taskId: p.taskId }, '[required-merge-hold] Hold write failed');
      return { count: 0 };
    });

  if (held.count === 0) {
    log.info(
      { taskId: p.taskId, source: p.source },
      '[required-merge-hold] Task already left the holdable state — no hold recorded',
    );
    return false;
  }

  await recordTransition({
    taskId: p.taskId,
    fromStatus: p.fromStatus,
    toStatus: 'verify_done',
    actor: p.actor ?? 'system',
    cause: AWAITING_REQUIRED_MERGE_CAUSE,
    phase: 'verify',
    sessionId: p.sessionId,
    metadata: { source: p.source, ...(p.metadata ?? {}) },
  }).catch(() => {});

  log.info(
    { taskId: p.taskId, source: p.source },
    '[required-merge-hold] autoMergePR requested and PR on record — holding at verify_done until the merge is confirmed',
  );
  return true;
}
