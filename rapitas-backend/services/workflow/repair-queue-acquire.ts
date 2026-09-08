/** Validate the persisted repair receipt before a queue item acquires execution. */
import type { Prisma } from '../../generated/prisma-postgres';
import { readRepairQueueEligibility } from './verify-repair-queue';

export async function canAcquireRepairQueue(
  tx: Prisma.TransactionClient,
  item: { taskId: number; result?: string | null },
): Promise<boolean> {
  if (!item.result) return true;
  let stored: unknown;
  try {
    stored = JSON.parse(item.result);
  } catch {
    return false;
  }
  if (!stored || typeof stored !== 'object' || !('repairResume' in stored)) return true;
  const receipt = stored.repairResume;
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
    return false;
  const updatedAt = new Date(receipt.updatedAt);
  if (!Number.isFinite(updatedAt.getTime())) return false;
  return (
    (await readRepairQueueEligibility(tx, item.taskId, {
      updatedAt,
      workflowStatus: receipt.workflowStatus,
      executionId: receipt.executionId,
    })) !== 'held'
  );
}

/** Consume the admission-only metadata when first acquired; phase results use result later. */
export function clearAcquiredRepairReceipt(result: string | null): string | null {
  if (!result) return result;
  const stored: unknown = JSON.parse(result);
  return stored && typeof stored === 'object' && 'repairResume' in stored ? null : result;
}
