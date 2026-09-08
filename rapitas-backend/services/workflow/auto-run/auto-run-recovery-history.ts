/** Historical queue and user-action checks used by active-task recovery. */
import type { PrismaClient } from '../../../generated/prisma-postgres';

/** Cancelled-without-running items that trip the runaway-loop guard. */
const RUNAWAY_CANCEL_THRESHOLD = 8;

/** Window the runaway-loop guard counts over. */
const RUNAWAY_CANCEL_WINDOW_MS = 10 * 60_000;

/**
 * Whether a task keeps producing cancelled queue items without ever running.
 *
 * Fails OPEN (false) — an unreadable queue must not stop the scheduler from
 * resuming genuinely-stalled work.
 *
 * @param prisma - Prisma client. / Prismaクライアント
 * @param taskId - Task under resolution. / 対象タスク
 * @returns true when the re-enqueue loop should be broken. / ループ打切りなら true
 */
export async function hasRunawayCancelLoop(prisma: PrismaClient, taskId: number): Promise<boolean> {
  try {
    const since = new Date(Date.now() - RUNAWAY_CANCEL_WINDOW_MS);
    const n = await prisma.workflowQueueItem.count({
      where: { taskId, status: 'cancelled', createdAt: { gt: since } },
    });
    return n >= RUNAWAY_CANCEL_THRESHOLD;
  } catch {
    return false;
  }
}

/**
 * Whether a human acted on the task after a point in time.
 *
 * Used to detect that a failure decision has been overtaken by a user action
 * (most often answering an AskUserQuestion, which revives the task). Only
 * `actor: 'user'` transitions count; the system transitions recorded around a
 * failure are the bookkeeping being applied, not a revival.
 *
 * Fails CLOSED (false) — an unreadable transition log must not stop the
 * scheduler from recording a genuine failure.
 *
 * @param prisma - Prisma client. / Prismaクライアント
 * @param taskId - Task under resolution. / 対象タスク
 * @param since - Terminal timestamp to compare against; null skips the check. / 比較起点
 * @returns true when a user transition exists after `since`. / ユーザー操作があれば true
 */
export async function userActedAfter(
  prisma: PrismaClient,
  taskId: number,
  since: Date | null,
): Promise<boolean> {
  if (!since) return false;
  try {
    const n = await prisma.workflowTransition.count({
      where: { taskId, actor: 'user', createdAt: { gt: since } },
    });
    return n > 0;
  } catch {
    return false;
  }
}
