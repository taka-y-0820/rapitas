/** A committed replan invalidates output from phases that began before it. */
import type { PrismaClient } from '../../generated/prisma-postgres';
import { REQUIREMENT_REPLAN_CAUSE } from './requirement-replan-commit';

export async function requirementReplannedSince(
  db: PrismaClient,
  taskId: number,
  phaseStartedAt: Date,
): Promise<boolean> {
  // Do not swallow DB errors: an unavailable audit cannot authorize stale completion.
  return (
    (await db.workflowTransition.findFirst({
      where: { taskId, cause: REQUIREMENT_REPLAN_CAUSE, createdAt: { gte: phaseStartedAt } },
      select: { id: true },
    })) !== null
  );
}
