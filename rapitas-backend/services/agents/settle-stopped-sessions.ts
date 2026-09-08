import type { PrismaClient } from '../../generated/prisma-postgres';
const ACTIVE_EXECUTION_STATUSES = ['running', 'pending', 'waiting_for_input'];

/** Retryable session settlement, including targets cancelled by an earlier stop. */
export async function settleStoppedSessions(
  prisma: PrismaClient,
  executionIds: number[],
): Promise<void> {
  if (!executionIds.length) return;
  const rows = await prisma.agentExecution.findMany({
    where: { id: { in: executionIds }, status: { in: ['cancelled', 'canceled'] } },
    select: { sessionId: true },
  });
  const sessionIds = [...new Set(rows.map((row) => row.sessionId).filter((id) => id != null))];
  if (!sessionIds.length) return;
  await prisma.agentSession.updateMany({
    where: {
      id: { in: sessionIds },
      status: { in: ['active', 'running'] },
      // A newer active execution still owns its session.
      agentExecutions: { none: { status: { in: [...ACTIVE_EXECUTION_STATUSES] } } },
    },
    data: { status: 'cancelled' },
  });
}
