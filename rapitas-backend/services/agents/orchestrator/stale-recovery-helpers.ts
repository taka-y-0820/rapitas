/**
 * Stale Recovery Helpers
 *
 * Shared DB-correction primitives used by both the startup recovery pass
 * (stale-execution-recovery.ts) and the periodic lease sweep
 * (execution-lease-sweep.ts): session finalization, orphaned-session
 * reconciliation, task rollback, and the recovery notification.
 * Not responsible for deciding WHICH executions are stale — callers own
 * detection and pass in the affected id sets.
 */

import { createLogger } from '../../../config';
import type { OrchestratorContext } from './types';
import { recordTransition } from '../../workflow/transition-recorder';

const logger = createLogger('stale-recovery-helpers');

/**
 * Execution statuses that mean "this session is still doing something".
 *
 * NOTE: `post_processing` and `canceling` were missing, so a sweep that landed
 * between the CLI exiting and post-processing finishing saw zero live rows and
 * declared a healthy, nearly-finished session `interrupted` (task 893). Both
 * are non-terminal, so neither may count as "no work left".
 */
const LIVE_EXECUTION_STATUSES = [
  'running',
  'pending',
  'waiting_for_input',
  'post_processing',
  'canceling',
] as const;

/**
 * Marks affected sessions as interrupted when they have no remaining active executions.
 *
 * @param ctx - Orchestrator context / オーケストレーターコンテキスト
 * @param sessionIds - Set of session IDs to check / チェックするセッションIDのセット
 * @returns Number of sessions actually marked interrupted / 実際に中断済みにしたセッション数
 */
export async function updateAffectedSessions(
  ctx: OrchestratorContext,
  sessionIds: Set<number>,
): Promise<number> {
  let updated = 0;
  for (const sessionId of sessionIds) {
    try {
      const activeCount = await ctx.prisma.agentExecution.count({
        where: {
          sessionId,
          status: { in: [...LIVE_EXECUTION_STATUSES] },
        },
      });

      if (activeCount === 0) {
        // Conditional write: the count above is a snapshot, and the phase can
        // finish (or be stopped) between it and this update. Re-stating both
        // preconditions in the `where` turns that lost race into a no-op
        // instead of relabelling a session someone else already terminated.
        await ctx.prisma.agentSession.update({
          where: {
            id: sessionId,
            status: { in: ['active', 'running'] },
            agentExecutions: { none: { status: { in: [...LIVE_EXECUTION_STATUSES] } } },
          },
          data: {
            status: 'interrupted',
            lastActivityAt: new Date(),
          },
        });
        updated++;
        logger.info(`[RecoveryManager] Session ${sessionId} marked as interrupted`);
      }
    } catch (error) {
      logger.error({ err: error, sessionId }, `[RecoveryManager] Failed to update session`);
    }
  }
  return updated;
}

/**
 * Marks orphaned active/running sessions as interrupted when every one of
 * their executions is already terminal (no LIVE_EXECUTION_STATUSES row left).
 * These sessions are invisible to the execution-keyed startup scan and
 * previously lingered forever as fake "active" state.
 *
 * @param ctx - Orchestrator context / オーケストレーターコンテキスト
 * @returns Number of sessions marked interrupted / 中断済みにしたセッション数
 */
export async function reconcileOrphanedActiveSessions(ctx: OrchestratorContext): Promise<number> {
  let updated = 0;
  try {
    const candidates = await ctx.prisma.agentSession.findMany({
      // Sessions created by THIS process instance are still being driven by
      // it — sweeping them races the phase that owns them. Only sessions that
      // predate this start-up can be orphans of a previous process.
      where: {
        status: { in: ['active', 'running'] },
        createdAt: { lt: ctx.serverStartedAt },
      },
      select: { id: true },
    });
    for (const session of candidates) {
      try {
        const liveCount = await ctx.prisma.agentExecution.count({
          where: {
            sessionId: session.id,
            status: { in: [...LIVE_EXECUTION_STATUSES] },
          },
        });
        if (liveCount === 0) {
          await ctx.prisma.agentSession.update({
            where: {
              id: session.id,
              status: { in: ['active', 'running'] },
              createdAt: { lt: ctx.serverStartedAt },
              agentExecutions: { none: { status: { in: [...LIVE_EXECUTION_STATUSES] } } },
            },
            data: { status: 'interrupted', lastActivityAt: new Date() },
          });
          updated++;
          logger.info(
            `[RecoveryManager] Orphaned session ${session.id} (no live executions) marked as interrupted`,
          );
        }
      } catch (error) {
        logger.error(
          { err: error, sessionId: session.id },
          '[RecoveryManager] Failed to reconcile orphaned session',
        );
      }
    }
  } catch (error) {
    logger.error({ err: error }, '[RecoveryManager] Orphaned session scan failed');
  }
  return updated;
}

/**
 * Reverts in-progress tasks to 'todo' status.
 *
 * @param ctx - Orchestrator context / オーケストレーターコンテキスト
 * @param taskIds - Set of task IDs to revert / 元に戻すタスクIDのセット
 * @returns Number of tasks that were updated / 更新されたタスクの数
 */
export async function updateAffectedTasks(
  ctx: OrchestratorContext,
  taskIds: Set<number>,
): Promise<number> {
  let updated = 0;
  for (const taskId of taskIds) {
    try {
      const task = await ctx.prisma.task.findUnique({
        where: { id: taskId },
        select: { id: true, status: true, workflowStatus: true },
      });

      if (task && task.status === 'in-progress') {
        await ctx.prisma.task.update({
          where: { id: taskId },
          data: { status: 'todo' },
        });
        updated++;
        logger.info(`[RecoveryManager] Task ${taskId} reverted to 'todo'`);
        // Record the revert so isWithinRecoveryGrace (incident-signature-detectors.ts)
        // can grant this deliberate `status='todo'` × advanced `workflowStatus`
        // shape its recovery grace period (task 709: previously unrecorded,
        // causing an immediate Pattern B false positive — task #602).
        await recordTransition({
          taskId,
          fromStatus: task.workflowStatus,
          toStatus: task.workflowStatus ?? 'draft',
          actor: 'system',
          cause: 'stale_execution_recovery_revert',
          metadata: { reason: 'stale_execution_recovery' },
        }).catch(() => {});
      }
    } catch (error) {
      logger.error({ err: error, taskId }, `[RecoveryManager] Failed to update task`);
    }
  }
  return updated;
}

/**
 * Creates a notification record informing the user about recovered executions.
 *
 * @param ctx - Orchestrator context / オーケストレーターコンテキスト
 * @param recoveredExecutions - Count of recovered executions / 復旧した実行数
 * @param updatedTasks - Count of updated tasks / 更新されたタスク数
 * @param updatedSessions - Count of updated sessions / 更新されたセッション数
 */
export async function createRecoveryNotification(
  ctx: OrchestratorContext,
  recoveredExecutions: number,
  updatedTasks: number,
  updatedSessions: number,
): Promise<void> {
  try {
    await ctx.prisma.notification.create({
      data: {
        type: 'agent_execution_interrupted',
        title: 'サーバー再起動による中断',
        message: `サーバー再起動により${recoveredExecutions}件のエージェント実行が中断されました。バナーから再開できます。`,
        link: '/',
        metadata: JSON.stringify({
          recoveredExecutions,
          updatedTasks,
          updatedSessions,
        }),
      },
    });
  } catch (error) {
    logger.error({ err: error }, '[RecoveryManager] Failed to create recovery notification');
  }
}
