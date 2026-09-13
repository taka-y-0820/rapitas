/**
 * A committed replan — or a human/operator plan-revision request — invalidates
 * output from phases that began before it.
 */
import type { PrismaClient } from '../../generated/prisma-postgres';
import { REQUIREMENT_REPLAN_CAUSE } from './requirement-replan-commit';

/**
 * Transition cause recorded by POST /workflow/tasks/:id/revise-plan
 * (plan-revision-persistence.ts). Observed 2026-09-13 (task 901): a revision
 * rolled the task to research_done, but an implementer that had started
 * earlier finished afterwards and the epilogue's forward-only advance moved
 * the task straight to in_progress — the planner never ran on the revised
 * instruction, and the next verify was judged against the plan the revision
 * had just withdrawn.
 */
const PLAN_REVISION_CAUSE = 'plan_revision_requested';

export async function requirementReplannedSince(
  db: PrismaClient,
  taskId: number,
  phaseStartedAt: Date,
): Promise<boolean> {
  // Do not swallow DB errors: an unavailable audit cannot authorize stale completion.
  return (
    (await db.workflowTransition.findFirst({
      where: {
        taskId,
        cause: { in: [REQUIREMENT_REPLAN_CAUSE, PLAN_REVISION_CAUSE] },
        createdAt: { gte: phaseStartedAt },
      },
      select: { id: true },
    })) !== null
  );
}
