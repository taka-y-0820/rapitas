import { writeBlockedTask } from './blocked-task-write';
/**
 * Durable Blocked-Status Write
 *
 * The `status: 'blocked'` write is the terminal action that actually STOPS a
 * bounded self-repair/verify loop — downstream schedulers and the UI key off
 * `status === 'blocked'` to stop re-dispatching a task. Swallowing a failed
 * write with a bare `.catch(() => {})` lets the loop re-enter on the very
 * next poll, because the task never actually reached the stop state. This
 * helper retries once, and on continued failure escalates via a Notification
 * so a human intervenes instead of the loop silently repeating.
 */
import { prisma } from '../../config/database';
import type { createLogger } from '../../config/logger';

/** Minimal logger shape accepted — matches the pino-style logger used everywhere in this project. */
type WarnErrorLogger = Pick<ReturnType<typeof createLogger>, 'warn' | 'error'>;

export interface DurableBlockWriteOptions {
  /** Task to mark blocked. / ブロックするタスク */
  taskId: number;
  /** Caller's module logger. / 呼び出し元のロガー */
  log: WarnErrorLogger;
  /** Short identifier for the caller, used in log lines (e.g. '[WorkflowOrchestrator]'). / 呼び出し元識別用ラベル */
  source: string;
  /** Notification shown to the user if both write attempts fail. / 両方失敗した場合に表示する通知内容 */
  notification: {
    title: string;
    message: string;
  };
}

/**
 * Set a task's status to `'blocked'`, retrying once on failure, and firing a
 * Notification if the write still didn't land after the retry.
 *
 * @param options - Target task, logger, and notification copy. / 対象タスク・ロガー・通知内容
 * @returns True when the write eventually succeeded. / 書き込みが最終的に成功したか
 */
export async function writeBlockedStatusDurable(
  options: DurableBlockWriteOptions,
): Promise<boolean> {
  const { taskId, log, source, notification } = options;
  const attempt = async () => {
    try {
      await writeBlockedTask(prisma, taskId);
      return true;
    } catch {
      return false;
    }
  };

  if (await attempt()) return true;

  log.warn({ taskId, source }, `[${source}] status=blocked write failed — retrying once`);
  if (await attempt()) return true;

  log.error(
    { taskId, source },
    `[${source}] status=blocked write failed twice — loop may re-enter; escalating`,
  );
  // Dynamic import mirrors the pre-existing orchestrator pattern (avoids a
  // routes/services import cycle) — best-effort, must never throw.
  import('../communication/notification-service')
    .then(({ createNotification }) =>
      createNotification({
        type: 'system',
        title: notification.title,
        message: notification.message,
        link: `/tasks?taskId=${taskId}`,
        metadata: { taskId, reason: 'block_write_failed', source },
      }),
    )
    .catch(() => {});
  return false;
}
