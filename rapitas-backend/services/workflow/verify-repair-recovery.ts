/** Recover committed repair delivery without creating a second repair attempt. */
import type { PrismaClient } from '../../generated/prisma-postgres';
import { enqueueCommittedRepair } from './verify-repair-queue';
import { REQUIREMENT_REPLAN_CAUSE } from './requirement-replan-commit';

export class RepairRecoveryError extends Error {
  constructor(
    readonly errors: Error[],
    recovered: number,
  ) {
    super(`Repair recovery incomplete (${recovered} queued)`);
    this.name = 'RepairRecoveryError';
  }
}

/** Reconciler adapter: wake the runner and preserve failed IDs for later passes. */
export async function recoverRepairsForRunner(
  db: PrismaClient,
  nowMs: number,
  failed: Set<number>,
) {
  const { WorkflowRunner } = await import('./workflow-runner');
  return recoverPendingRepairs(
    db,
    () => WorkflowRunner.getInstance().startProcessing(),
    nowMs,
    (taskId) => {
      failed.add(taskId);
    },
  );
}

export async function recoverCommittedRepair(db: PrismaClient, taskId: number) {
  const audit = await db.workflowTransition.findFirst({
    where: { taskId, cause: { in: ['verify_repair', REQUIREMENT_REPLAN_CAUSE] } },
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
  onFailure: (taskId: number) => void = () => {},
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
  const failures: Error[] = [];
  for (const task of tasks) {
    try {
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
    } catch (cause) {
      onFailure(task.id);
      failures.push(new Error(`Repair recovery failed for task ${task.id}`, { cause }));
    }
  }
  // Deliver healthy repairs first, but never report a partial pass as success.
  if (failures.length) throw new RepairRecoveryError(failures, recovered);
  return recovered;
}
