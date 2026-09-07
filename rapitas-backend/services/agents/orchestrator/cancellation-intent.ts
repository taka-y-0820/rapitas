/** Persist a stop request without replacing a terminal execution. */
import type { PrismaClient } from '../../../generated/prisma-postgres';
import { createLogger } from '../../../config/logger';
const log = createLogger('cancellation-intent');

export async function persistCancellationIntent(
  prisma: PrismaClient,
  executionId: number,
): Promise<void> {
  try {
    await prisma.agentExecution.updateMany({
      where: {
        id: executionId,
        status: { in: ['pending', 'running', 'waiting_for_input', 'post_processing', 'canceling'] },
      },
      data: { status: 'canceling', errorMessage: 'Cancellation requested' },
    });
  } catch (error) {
    // Still attempt to stop the CLI during a database outage.
    log.warn({ error, executionId }, 'Failed to persist cancellation request');
  }
}
