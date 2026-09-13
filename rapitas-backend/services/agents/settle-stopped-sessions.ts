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
    select: { id: true, sessionId: true },
  });
  const latestBySession = new Map<number, number>();
  for (const row of rows) {
    if (row.sessionId != null)
      latestBySession.set(row.sessionId, Math.max(latestBySession.get(row.sessionId) ?? 0, row.id));
  }
  for (const [sessionId, executionId] of latestBySession) {
    await prisma.agentSession.updateMany({
      where: {
        id: { in: [sessionId] },
        status: { in: ['pending', 'active', 'running', 'failed'] },
        // Recover a stop whose first DB writes failed, without rewriting a newer outcome.
        agentExecutions: {
          none: {
            OR: [
              { status: { in: [...ACTIVE_EXECUTION_STATUSES] } },
              { id: { gt: executionId }, status: { notIn: ['cancelled', 'canceled'] } },
            ],
          },
        },
      },
      data: { status: 'cancelled' },
    });
  }
}
