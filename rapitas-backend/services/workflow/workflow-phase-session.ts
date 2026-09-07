/** Finalizes a phase session after artifact processing, without completing its task. */
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';

const log = createLogger('workflow-phase-session');

/** Persist a terminal phase outcome only when execution evidence permits it. */
export async function finalizePhaseSession(sessionId: number, success: boolean): Promise<void> {
  try {
    await prisma.agentSession.updateMany({
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
  } catch (err) {
    log.warn({ err, sessionId }, 'Failed to persist phase session outcome');
  }
}
