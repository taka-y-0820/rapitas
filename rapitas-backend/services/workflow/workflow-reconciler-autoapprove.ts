/**
 * WorkflowReconcilerAutoApprove
 *
 * Heal pass for auto-approve stalls: a task sitting at `plan_created` while
 * the auto-approve policy applies means the save-time approval step was LOST
 * (observed cause: the synchronous plan-critic gate makes the save request
 * outlive the agent's 120s curl timeout; the client resends, and the second
 * request's critic/auto-approve tail never completes — task 492 sat at
 * plan_created forever with global autoApprovePlan=true). The reconciler
 * re-runs the exact approval the save path would have performed.
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { maybeAutoApprovePlan, resolveEffectiveAutoApprovePlan } from './plan-auto-approve';

const log = createLogger('workflow-reconciler-autoapprove');

/**
 * How long a task may sit at plan_created before the reconciler steps in.
 * Must comfortably exceed the critic gate's worst-case runtime so a save
 * request that is still legitimately evaluating is never raced.
 */
const AUTO_APPROVE_STALL_MS = 5 * 60 * 1000;

/** Max stalls healed per reconcile cycle (each heal spawns an agent phase). */
const MAX_HEALS_PER_CYCLE = 3;

/**
 * Approve + advance tasks stuck at plan_created despite an active
 * auto-approve policy. Idempotent: maybeAutoApprovePlan no-ops unless the
 * task is still at plan_created, and tasks without an applicable policy are
 * skipped (they are legitimately waiting for the human gate).
 *
 * @param nowMs - Current epoch ms (injected for testability). / 現在時刻
 * @returns Number of tasks healed this cycle. / 修復件数
 */
export async function healAutoApproveStalls(nowMs: number): Promise<number> {
  const staleBefore = new Date(nowMs - AUTO_APPROVE_STALL_MS);
  const candidates = await prisma.task.findMany({
    where: {
      workflowStatus: 'plan_created',
      // A stopped task returns to todo. Recovery cannot grant a new run.
      status: 'in-progress',
      updatedAt: { lte: staleBefore },
    },
    select: { id: true },
    orderBy: { updatedAt: 'asc' },
    take: MAX_HEALS_PER_CYCLE,
  });

  let healed = 0;
  for (const { id } of candidates) {
    try {
      if (!(await resolveEffectiveAutoApprovePlan(id))) continue; // human gate — leave it
      log.info(
        { taskId: id },
        '[reconciler] plan_created stall with auto-approve policy — re-running lost approval',
      );
      const approval = await maybeAutoApprovePlan(id, 'ja', { autoAdvance: true });
      if (approval.autoApproved) healed++;
    } catch (err) {
      log.warn({ err, taskId: id }, '[reconciler] auto-approve heal failed for task');
    }
  }
  return healed;
}
