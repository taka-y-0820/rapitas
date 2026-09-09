/** Preserve shutdown recovery and real failure reconciliation for admitted manual replies. */
import { prisma } from '../../../../config/database';
import { createLogger } from '../../../../config/logger';
import { isShutdownError } from '../../../../services/agents/agent-worker/shutdown-error';
import { reconcileHardFailure } from './hard-failure-reconciler';

const log = createLogger('routes:manual-execution-error');

export async function handleManualExecutionError(
  cause: unknown,
  taskId: number,
  sessionId: number,
  isExecutionCurrent: () => boolean,
): Promise<void> {
  if (!isExecutionCurrent()) return;
  const error = cause instanceof Error ? cause : new Error(String(cause));
  if (isShutdownError(error)) {
    log.warn({ err: error, taskId }, 'Execution interrupted by shutdown');
    await prisma.agentSession
      .updateMany({
        where: { id: sessionId, status: { notIn: ['cancelled', 'canceled', 'canceling'] } },
        data: { status: 'interrupted', completedAt: new Date(), errorMessage: error.message },
      })
      .catch(() => {});
    return;
  }
  log.error({ err: error, taskId }, 'Manual execution error');
  // IPC failure can occur while the worker continues saving workflow artifacts.
  await reconcileHardFailure({
    taskId,
    sessionId,
    errorMessage: error.message || 'Execution error',
    logPrefix: '[API]',
    isExecutionCurrent,
  });
}
