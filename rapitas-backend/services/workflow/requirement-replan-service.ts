/** Server-owned review entry point. Callers supply a task id, never their own verdict. */
import type { PrismaClient } from '../../generated/prisma-postgres';
import { commitRequirementReplan, parseStoredRequirementArray } from './requirement-replan-commit';
import { reviewRequirementReplan } from './requirement-replan-review';
import { replanSnapshotDigest } from './requirement-replan-evidence';
import { shareInflightReplanReview } from './requirement-replan-inflight';
import type { CompletionReviewReceipt } from './requirement-replan-commit';

export async function attemptRequirementReplan(
  db: PrismaClient,
  taskId: number,
  review: typeof reviewRequirementReplan = reviewRequirementReplan,
): Promise<{ committed: boolean; reason: string; completionReceipt?: CompletionReviewReceipt }> {
  const readSource = () =>
    db.$transaction(
      async (tx) => {
        const task = await tx.task.findUnique({
          where: { id: taskId },
          select: {
            title: true,
            description: true,
            goals: true,
            constraints: true,
            acceptanceCriteria: true,
            status: true,
            workflowStatus: true,
            updatedAt: true,
          },
        });
        if (
          !task ||
          task.status !== 'in-progress' ||
          !['plan_approved', 'in_progress', 'verify_done'].includes(task.workflowStatus ?? '')
        )
          return null;
        const files = await tx.workflowFile.findMany({
          where: { taskId, fileType: { in: ['plan', 'verify'] } },
          select: { fileType: true, content: true },
        });
        const plan = files.find((f) => f.fileType === 'plan');
        const verify = files.find((f) => f.fileType === 'verify');
        if (!plan || !verify) return null;
        const execution = await tx.agentExecution.findFirst({
          where: { session: { config: { taskId } } },
          orderBy: { id: 'desc' },
          select: { id: true },
        });
        return {
          executionId: execution?.id ?? null,
          updatedAt: task.updatedAt,
          snapshot: {
            title: task.title,
            description: task.description ?? '',
            goals: parseStoredRequirementArray(task.goals),
            constraints: parseStoredRequirementArray(task.constraints),
            acceptanceCriteria: parseStoredRequirementArray(task.acceptanceCriteria),
            plan: plan.content,
            verify: verify.content,
          },
        };
      },
      { isolationLevel: 'Serializable' },
    );
  const source = await readSource();
  if (!source) return { committed: false, reason: 'not_reviewable' };
  // No DB transaction or lifecycle lock is held during potentially slow AI evaluation.
  const result = await shareInflightReplanReview(source.snapshot, review);
  if (result.verdict.kind === 'no_mismatch') {
    const fresh = await readSource();
    if (!fresh || fresh.updatedAt.getTime() !== source.updatedAt.getTime()) {
      return { committed: false, reason: 'stale_task' };
    }
    if (replanSnapshotDigest(fresh.snapshot) !== result.snapshotDigest) {
      return { committed: false, reason: 'stale_snapshot' };
    }
    if (fresh.executionId !== source.executionId)
      return { committed: false, reason: 'execution_superseded' };
  }
  // The commit re-reads lifecycle, stop state, budget and all reviewed text atomically.
  const decision = await commitRequirementReplan(db, taskId, source.updatedAt, result);
  if (decision.reason !== 'no_mismatch') return decision;
  return {
    ...decision,
    completionReceipt: {
      taskId,
      executionId: source.executionId,
      evaluatedUpdatedAt: source.updatedAt,
      review: structuredClone(result),
    },
  };
}
