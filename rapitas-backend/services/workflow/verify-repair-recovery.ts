/** Recover committed repair delivery without creating a second repair attempt. */
import type { PrismaClient } from '../../generated/prisma-postgres';
import { enqueueCommittedRepair } from './verify-repair-queue';

export async function recoverCommittedRepair(db: PrismaClient, taskId: number) {
  const audit = await db.workflowTransition.findFirst({
    where: { taskId, cause: 'verify_repair' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { metadata: true },
  });
  if (!audit) return 'not_repair' as const;
  const metadata: unknown = JSON.parse(audit.metadata);
  if (!metadata || typeof metadata !== 'object' || !('resumeReceipt' in metadata))
    return 'not_repair' as const; // Older audits cannot authorize automatic replay.
  const receipt = metadata.resumeReceipt;
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    !('updatedAt' in receipt) ||
    !('workflowStatus' in receipt) ||
    !('executionId' in receipt) ||
    typeof receipt.updatedAt !== 'string' ||
    typeof receipt.workflowStatus !== 'string' ||
    !(
      receipt.executionId === null ||
      (typeof receipt.executionId === 'number' &&
        Number.isSafeInteger(receipt.executionId) &&
        receipt.executionId > 0)
    )
  )
    throw new Error('Invalid persisted repair receipt');
  const updatedAt = new Date(receipt.updatedAt);
  if (!Number.isFinite(updatedAt.getTime())) throw new Error('Invalid repair receipt timestamp');
  return enqueueCommittedRepair(db, taskId, {
    updatedAt,
    workflowStatus: receipt.workflowStatus,
    executionId: receipt.executionId,
  });
}

/** Periodic/startup delivery pass; active agents retain ownership of their repair. */
export async function recoverPendingRepairs(
  db: PrismaClient,
  wake: () => void,
  nowMs = Date.now(),
): Promise<number> {
  const tasks = await db.task.findMany({
    where: {
      status: 'in-progress',
      workflowStatus: { in: ['plan_approved', 'research_done'] },
      updatedAt: { lt: new Date(nowMs - 60_000) },
    },
    select: { id: true },
  });
  let recovered = 0;
  for (const task of tasks) {
    const active = await db.agentExecution.findFirst({
      where: {
        session: { config: { taskId: task.id } },
        status: { in: ['running', 'pending', 'waiting_for_input', 'canceling', 'cancelling'] },
      },
      select: { id: true },
    });
    if (active) continue;
    const result = await recoverCommittedRepair(db, task.id);
    if (result === 'queued' || result === 'existing') {
      wake();
      if (result === 'queued') recovered++;
    }
  }
  return recovered;
}
