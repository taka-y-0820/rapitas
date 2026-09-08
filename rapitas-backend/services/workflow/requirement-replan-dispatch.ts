/** A reviewed contradiction must revise its plan instead of reusing the rejected plan. */
import type { PrismaClient } from '../../generated/prisma-postgres';
import type { RoleTransition } from './workflow-types';
import { readRequirementReplanAudit } from './requirement-replan-context';

export async function reviewedReplanTransition(
  db: PrismaClient,
  taskId: number,
  status: string,
): Promise<RoleTransition | null> {
  if (!['research_done', 'plan_approved'].includes(status)) return null;
  if (!(await readRequirementReplanAudit(db, taskId))) return null;
  // plan_created remains the existing approval gate; it is never dispatched here.
  return status === 'research_done'
    ? { role: 'planner', outputFile: 'plan', nextStatus: 'plan_created' }
    : { role: 'implementer', outputFile: null, nextStatus: 'in_progress' };
}
