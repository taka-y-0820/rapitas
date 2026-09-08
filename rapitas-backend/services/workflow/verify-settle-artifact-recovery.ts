/**
 * verify-settle-artifact-recovery
 *
 * Last line of defence before the WorkflowRunner declares a `verify_done` task
 * stuck: checks the DB's primary evidence (a PR linked to the task) and, when
 * the work has demonstrably landed, completes the task instead of blocking it.
 * Not responsible for deciding whether the automation is still running — that
 * is verify-completion-inflight; this only rescues a task whose success is
 * already on record but whose status row never caught up.
 */
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import { recordTransition } from './transition-recorder';
import { resolveAutomationPolicy } from './automation-policy';

const log = createLogger('workflow:verify-settle-artifact-recovery');

/** A recorded PR with a required merge belongs to the merge watcher. */
export async function isAwaitingRequiredMerge(taskId: number): Promise<boolean> {
  const policy = await resolveAutomationPolicy(prisma, taskId);
  return policy.autoMergePR && !!(await findLandedPullRequest(taskId));
}

/**
 * Whether a pull request is on record for the task, via the app-linked
 * `GitHubPullRequest.linkedTaskId` first and `Task.githubPrId` as fallback —
 * the same two-step lookup the commit/PR pipeline's PR-required gate uses.
 *
 * @param taskId - Task to look up. / 対象タスクID
 * @returns The PR reference found, or null when none is on record. / 見つかったPR参照
 */
async function findLandedPullRequest(
  taskId: number,
): Promise<{ source: 'linked_pr' | 'task_github_pr_id'; ref: number } | null> {
  const linked = await prisma.gitHubPullRequest.findFirst({
    where: { linkedTaskId: taskId },
    select: { id: true },
  });
  if (linked) return { source: 'linked_pr', ref: linked.id };
  const taskRow = await prisma.task.findUnique({
    where: { id: taskId },
    select: { githubPrId: true },
  });
  if (taskRow?.githubPrId != null) return { source: 'task_github_pr_id', ref: taskRow.githubPrId };
  return null;
}

/**
 * Complete a `verify_done` task whose PR already exists, so it is not judged
 * stuck. Compare-and-swap on `workflowStatus: 'verify_done'` — a concurrent
 * completion (the pipeline itself finishing, a duplicate save) wins and this
 * returns false rather than recording a second completion.
 *
 * Every failure path — no PR on record, the CAS losing, any DB error — yields
 * false so the caller falls through to its normal `stuck` verdict: this is a
 * safety net for a success that was already recorded, never an optimistic
 * completion of unknown work.
 *
 * @param taskId - Task the runner is about to declare stuck. / stuck 判定直前のタスクID
 * @returns True when the task was completed here from landed evidence. / 実在確認で完了させた場合 true
 */
export async function recoverFromLandedArtifact(taskId: number): Promise<boolean> {
  try {
    // PR existence cannot satisfy a required merge. The watcher confirms GitHub.
    const policy = await resolveAutomationPolicy(prisma, taskId);
    if (policy.autoMergePR) return false;
    const landed = await findLandedPullRequest(taskId);
    if (!landed) return false;

    const flipped = await prisma.task.updateMany({
      where: {
        id: taskId,
        workflowStatus: 'verify_done',
        status: { in: ['todo', 'in-progress', 'in_progress'] },
      },
      data: { status: 'done', workflowStatus: 'completed', completedAt: new Date() },
    });
    if (flipped.count === 0) {
      log.info(
        { taskId, ...landed },
        '[VerifySettle] PR on record but the task already left verify_done — no recovery needed',
      );
      return false;
    }

    await recordTransition({
      taskId,
      fromStatus: 'verify_done',
      toStatus: 'completed',
      actor: 'system',
      cause: 'verify_settle_artifact_recovered',
      phase: 'verify',
      metadata: { prSource: landed.source, prRef: landed.ref },
    });
    log.warn(
      { taskId, ...landed },
      '[VerifySettle] Task was about to be judged stuck, but its PR already exists — completed from landed evidence instead of blocking',
    );
    return true;
  } catch (err) {
    log.warn(
      { err, taskId },
      '[VerifySettle] Landed-artifact check failed — falling through to the normal stuck verdict',
    );
    return false;
  }
}
