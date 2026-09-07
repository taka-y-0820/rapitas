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
    return result.count === 1;
  } catch (err) {
    log.warn({ err, sessionId }, 'Failed to persist phase session outcome');
    return false;
  }
}
