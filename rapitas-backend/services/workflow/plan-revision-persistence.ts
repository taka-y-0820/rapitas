import type { PrismaClient } from '../../generated/prisma-postgres';
import { PLAN_REVISION_CAUSE } from './workflow-plan-revision-context';

export async function persistPlanRevision(
  db: PrismaClient,
  task: { id: number; updatedAt: Date; workflowStatus: string | null },
  instruction: string,
  source: string,
): Promise<void> {
  // The instruction is execution input, not best-effort telemetry. Persist it
  // with the rollback state, or leave both unchanged. Reject stale requests.
  await db.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: task.id, updatedAt: task.updatedAt, workflowStatus: task.workflowStatus },
      data: { workflowStatus: 'research_done', status: 'in-progress', updatedAt: new Date() },
      select: { id: true },
    });
    await tx.workflowTransition.create({
      data: {
        taskId: task.id,
        fromStatus: task.workflowStatus,
        toStatus: 'research_done',
        actor: 'user',
        cause: PLAN_REVISION_CAUSE,
        phase: 'plan',
        metadata: JSON.stringify({ instruction, source }),
      },
    });
  });
}
