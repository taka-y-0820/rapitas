/**
 * execution/hard-failure-reconciler
 *
 * Closes out an execution reported as a hard failure, reconciling
 * instead of hard-failing when the workflow actually advanced during
 * the run (worker IPC lost the round-trip but the process kept going).
 * Separated from execute-post-handler.ts to keep each file under 500 lines.
 */

import { prisma } from '../../../../config/database';
import { createLogger } from '../../../../config/logger';

const log = createLogger('routes:agent-execution:hard-failure-reconciler');

/**
 * Returns whether any workflow artifact (research/plan/verify…) was saved for
 * the task after the given instant. WorkflowFile.updatedAt is bumped on every
 * save through the workflow API, and every workflowStatus transition is tied
 * to such a save — so this is direct evidence that the workflow advanced
 * during the session. DB errors count as "no progress" (fail-safe: keeps the
 * legacy hard-fail behavior).
 *
 * @param taskId - Task whose workflow files to inspect / 対象タスクID
 * @param since - Lower bound (exclusive) for updatedAt / 判定基準時刻
 * @returns true when an artifact was saved after `since` / 前進していれば true
 */
async function workflowProgressedSince(taskId: number, since: Date): Promise<boolean> {
  const recentFile = await prisma.workflowFile
    .findFirst({ where: { taskId, updatedAt: { gt: since } }, select: { id: true } })
    .catch(() => null);
  return !!recentFile;
}

/**
 * Closes out an execution that was REPORTED as a hard failure (worker promise
 * rejected — e.g. IPC timeout — or resolved with success:false), without
 * clobbering a run whose workflow actually advanced.
 *
 * The reject/failure signal only means the manager lost the IPC round-trip;
 * the worker process keeps running and saves artifacts through the workflow
 * API on its own (task 541 / session 2098 incident). When an artifact was
 * saved during this session, the run is reconciled (task status derived from
 * workflowStatus, session 'interrupted', stale/post_processing executions
 * closed) instead of the unconditional todo/failed marking.
 *
 * @param params - taskId/sessionId plus the original error message and log prefix / 対象と失敗文脈
 */
export async function reconcileHardFailure(params: {
  taskId: number;
  sessionId: number;
  errorMessage: string;
  logPrefix: string;
  isExecutionCurrent?: () => boolean;
}): Promise<void> {
  const { taskId, sessionId, errorMessage, logPrefix } = params;
  const current = () => params.isExecutionCurrent?.() !== false;
  if (!current()) return;
  const session = await prisma.agentSession
    .findUnique({
      where: { id: sessionId },
      select: { startedAt: true, createdAt: true, status: true },
    })
    .catch(() => null);
  if (!current() || !session || ['cancelled', 'canceled', 'canceling'].includes(session.status))
    return;
  // startedAt is never set on the execute-setup session-creation path — fall
  // back to createdAt (same pattern as research-phase-handler.ts).
  const since = session?.startedAt ?? session?.createdAt ?? null;
  const progressed = since ? await workflowProgressedSince(taskId, since) : false;
  if (!current()) return;

  if (!progressed) {
    await prisma.task
      .update({ where: { id: taskId }, data: { status: 'todo' } })
      .catch((e: unknown) =>
        log.error({ err: e }, `${logPrefix} Failed to update task ${taskId} to todo after failure`),
      );
    if (!current()) return;
    await prisma.agentSession
      .update({
        where: { id: sessionId, status: { notIn: ['cancelled', 'canceled', 'canceling'] } },
        data: { status: 'failed', completedAt: new Date(), errorMessage },
      })
      .catch((e: unknown) =>
        log.error({ err: e }, `${logPrefix} Failed to update session ${sessionId} to failed`),
      );
    return;
  }

  log.warn(
    { taskId, sessionId },
    `${logPrefix} Execution reported failure but workflow artifacts advanced during this run — reconciling instead of hard-failing`,
  );

  const { applyTaskStatusFromWorkflow } =
    await import('../../../../services/workflow/apply-task-status-from-workflow');
  if (!current()) return;
  await applyTaskStatusFromWorkflow(prisma, taskId, logPrefix);
  if (!current()) return;

  // Keep the original error for auditability — do not swallow it.
  const reconciledMessage = `${errorMessage} (ワークフローはこの実行中に前進したため 'failed' から 'interrupted' へ再調整されました)`;
  await prisma.agentSession
    .update({
      where: { id: sessionId, status: { notIn: ['cancelled', 'canceled', 'canceling'] } },
      data: { status: 'interrupted', completedAt: new Date(), errorMessage: reconciledMessage },
    })
    .catch((e: unknown) =>
      log.error({ err: e }, `${logPrefix} Failed to update session ${sessionId} to interrupted`),
    );

  // Close only executions whose heartbeat already went stale — a fresh
  // heartbeat means the worker is still alive and stale-execution-recovery's
  // periodic sweep will handle it if it later dies.
  const { LEASE_STALE_MS } =
    await import('../../../../services/agents/orchestrator/execution-heartbeat');
  if (!current()) return;
  const staleBefore = new Date(Date.now() - LEASE_STALE_MS);
  await prisma.agentExecution
    .updateMany({
      where: {
        sessionId,
        status: { in: ['running', 'pending'] },
        OR: [
          { heartbeatAt: { lt: staleBefore } },
          { heartbeatAt: null, createdAt: { lt: staleBefore } },
        ],
      },
      data: { status: 'interrupted', completedAt: new Date() },
    })
    .catch((e: unknown) =>
      log.warn({ err: e, sessionId }, `${logPrefix} Failed to interrupt stale-lease executions`),
    );

  // post_processing means "agent exited 0 but the artifact flip was pending" —
  // progress is already confirmed here, so flip unconditionally (heartbeat
  // freshness is irrelevant for this transient state; see plan 設計判断).
  if (!current()) return;
  await prisma.agentExecution
    .updateMany({
      where: { sessionId, status: 'post_processing' },
      data: { status: 'completed', completedAt: new Date() },
    })
    .catch((e: unknown) =>
      log.warn({ err: e, sessionId }, `${logPrefix} Failed to flip post_processing → completed`),
    );
}
