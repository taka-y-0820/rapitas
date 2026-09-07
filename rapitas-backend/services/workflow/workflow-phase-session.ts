/**
 * WorkflowPhaseSession
 *
 * Drives the AgentSession a workflow phase opened to a terminal status once
 * the phase's artifact processing is done. Not responsible for the task's own
 * status, nor for deciding whether the phase succeeded — the caller passes
 * that in.
 *
 * The write is CONDITIONAL on purpose. A phase session can be stopped,
 * cancelled or reclaimed while the phase is still winding down (stop-route,
 * the orphan sweep, an operator's cancel), and an unconditional
 * `update({ where: { id } })` would resurrect that stopped session as
 * completed/failed. The `where` therefore re-states both preconditions — the
 * session is still live, and every execution it owns has already reached a
 * terminal status — so a lost race writes nothing instead of overwriting a
 * decision someone else already made.
 */
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';

const log = createLogger('workflow-phase-session');

/**
 * Persist a terminal phase outcome only when execution evidence permits it.
 *
 * @param sessionId - Session opened for this phase. / このフェーズのセッションID
 * @param success - Whether the phase succeeded. / フェーズが成功したか
 * @returns True only when this call committed the terminal session state.
 */
export async function finalizePhaseSession(sessionId: number, success: boolean): Promise<boolean> {
  try {
    const result = await prisma.agentSession.updateMany({
      where: {
        id: sessionId,
        status: { in: ['active', 'running'] },
        agentExecutions: {
          some: {},
          // Unknown/new execution states are deliberately not considered terminal.
          every: { status: { in: success ? ['completed'] : ['completed', 'failed'] } },
        },
      },
      data: {
        status: success ? 'completed' : 'failed',
        completedAt: new Date(),
        lastActivityAt: new Date(),
      },
    });
    if (result.count === 1) return true;
    if (!success) return false;

    // A successful retry may follow a failed execution. Read that exact
    // terminal set; merely finding ANY completed child would credit stale
    // success when a later attempt failed or is still running.
    const executions = await prisma.agentExecution.findMany({
      where: { sessionId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true },
    });
    if (
      executions[0]?.status !== 'completed' ||
      !executions.some((e) => e.status === 'failed') ||
      executions.some((e) => !['completed', 'failed'].includes(e.status))
    )
      return false;

    const snapshot = executions.map(({ id, status }) => ({ id, status }));
    const retried = await prisma.agentSession.updateMany({
      where: {
        id: sessionId,
        status: { in: ['active', 'running'] },
        // No added, removed, or changed child can pass the second conditional
        // write. A competing cancellation still wins through session status.
        agentExecutions: { every: { OR: snapshot } },
        AND: snapshot.map((child) => ({ agentExecutions: { some: child } })),
      },
      data: { status: 'completed', completedAt: new Date(), lastActivityAt: new Date() },
    });
    return retried.count === 1;
  } catch (err) {
    log.warn({ err, sessionId }, 'Failed to persist phase session outcome');
    return false;
  }
}
