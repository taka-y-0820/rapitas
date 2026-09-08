/**
 * publication-cancellation-guard
 *
 * Answers one question for every publication step (commit / PR / merge /
 * worktree cleanup): has this task's run been stopped? A stop request is
 * persisted before process termination; check that intent as well as the
 * latest execution status before allowing the next publication step.
 * Not responsible for stopping anything, nor for deciding whether a required
 * merge has landed — that is verify-settle-artifact-recovery's
 * `isAwaitingRequiredMerge`.
 */
import { THEME_STOP_INTENT } from '../agents/theme-stop-intent';
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';

const log = createLogger('workflow:publication-cancellation-guard');

/** Stop-in-progress and terminal cancellation variants used by supported runners. */
const CANCELLED_EXECUTION_STATUSES = new Set(['cancelled', 'canceled', 'canceling', 'cancelling']);

/**
 * Whether the task's most recent agent execution was cancelled — i.e. a stop
 * request is on record and no newer run has superseded it.
 *
 * Deliberately reads only the LATEST row: a task that was stopped once and then
 * legitimately re-run must not be blocked forever by that historical
 * cancellation, so an older cancelled execution behind a newer running/completed
 * one yields false.
 *
 * Withholds publication on DB failure: an unreadable stop record must not
 * authorize an irreversible action. A missing execution alone is not a stop.
 *
 * @param taskId - Task whose publication step is about to run. / 公開処理を行おうとしているタスクID
 * @returns True when the latest execution is cancelled. / 最新実行がキャンセル済みなら true
 */
export async function isLatestExecutionCancelled(taskId: number): Promise<boolean> {
  try {
    const latest = await prisma.agentExecution.findFirst({
      where: { session: { config: { taskId } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true, startedAt: true },
    });
    const stop = await prisma.workflowTransition.findFirst({
      where: {
        taskId,
        cause: {
          in: [
            THEME_STOP_INTENT,
            'manual_execution_stop_revert',
            'manual_execution_stop_withdraw',
            'auto_run_stop_revert',
          ],
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true },
    });
    const unresumedStop = stop && (!latest?.startedAt || latest.startedAt <= stop.createdAt);
    if (!unresumedStop && !CANCELLED_EXECUTION_STATUSES.has(latest?.status ?? '')) return false;
    log.warn(
      { taskId, executionId: latest?.id },
      '[publication-guard] Latest execution is cancelled — withholding the next publication step',
    );
    return true;
  } catch (err) {
    log.warn(
      { err, taskId },
      '[publication-guard] Cancellation lookup failed — withholding publication',
    );
    return true;
  }
}

/**
 * Fixed sentence recorded as the publication result's error when a stop request
 * aborted it. Kept FREE of git/merge wording so the no-change classifier
 * (`isNoChangeCompletion`) can never misread it as a benign "nothing to land".
 */
export const PUBLICATION_CANCELLED_ERROR = 'タスクが停止されたため、公開処理を中断しました。';

/**
 * Re-check the persisted stop intent at one publication boundary.
 *
 * Every awaited publication step (verification gate, commit, base sync, PR
 * creation, worktree removal) can take minutes, so a stop that arrives
 * mid-flight is only observable by re-reading between steps. This does NOT
 * interrupt a git command already running — it withholds every step AFTER the
 * one in flight.
 *
 * @param taskId - Task being published. / 公開対象タスクID
 * @param step - Boundary name, for the log line. / 判定地点の名前
 * @returns True when publication must stop here. / 中断すべきなら true
 */
export async function publicationAborted(taskId: number, step: string): Promise<boolean> {
  if (!(await isLatestExecutionCancelled(taskId))) return false;
  log.warn({ taskId, step }, '[publication-guard] Task was stopped — withholding this step');
  return true;
}
