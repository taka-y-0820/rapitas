/**
 * FileSave Verify Commit/PR Completion
 *
 * Auto commit / PR / merge for a passing verify.md, the gate-side
 * history-contamination retry, the PR-required completion gate, staged
 * completion, conflict-resolution direct completion, and the post-completion
 * fire-and-forget side effects.
 * Not responsible for the empty-diff gate or the adversarial review.
 */

import { prisma } from '../../../../config';
import { createLogger } from '../../../../config/logger';
import type { WorkflowFileType } from '../../core/workflow-helpers';
import type { performAutoCommitAndPR } from '../../workflow-auto-commit';
import { recordTransition } from '../../../../services/workflow/transition-recorder';
import {
  runVerifyCommitPrPipeline,
  type CommitPrCompletionOutcome,
} from './verify-commit-pr-pipeline';
import { readConflictPrVerdict } from './conflict-pr-merge-state';
import { isAwaitingRequiredMerge } from '../../../../services/workflow/verify-settle-artifact-recovery';
import { holdForRequiredMerge } from '../../../../services/workflow/required-merge-hold';

const log = createLogger('routes:workflow:handlers:files');

export type { CommitPrCompletionOutcome };

/**
 * Runs commit/PR/merge and the completion gates for a passing verify.md save.
 *
 * Auto commit and PR creation when saving verify.md.
 *
 * NOTE: reaching this stage's active branch means verify.md passed validation
 * (the failure branch upstream holds the task at `in_progress`/`blocked` and
 * leaves newStatus undefined). Per the user's request — "verify.md を保存し、
 * 問題がなければステータスを完了に" — a passing verification now completes the
 * task directly. Auto-commit / PR / merge still run as a BEST-EFFORT side
 * effect (so branches with real changes still get a PR), but completion no
 * longer depends on a PR being published... except that completion REQUIRES a
 * successfully created PR when one was requested (see the gate below).
 *
 * @param params - taskId / fileType / newStatus / gate flags / conflict info / content / base branch / 入力一式
 * @returns The completion outcome (pass-through when the gates skip this stage)
 */
export async function runVerifyCommitPrCompletion(params: {
  taskId: number;
  fileType: WorkflowFileType;
  newStatus: string | undefined;
  verifyGateBlocked: boolean;
  staleVerifyRequest: boolean;
  isConflictResolutionTask: boolean;
  conflictTask: { title: string | null; githubPrId: number | null } | null;
  savedContent: string;
  preferredBaseBranchForVerify: string | null;
}): Promise<CommitPrCompletionOutcome> {
  const {
    taskId,
    fileType,
    staleVerifyRequest,
    isConflictResolutionTask,
    conflictTask,
    savedContent,
    preferredBaseBranchForVerify,
  } = params;
  let newStatus = params.newStatus;
  const verifyGateBlocked = params.verifyGateBlocked;

  let autoCommitPRResult: Awaited<ReturnType<typeof performAutoCommitAndPR>> = {};
  let taskMarkedDone = false;
  if (
    fileType === 'verify' &&
    newStatus === 'verify_done' &&
    !verifyGateBlocked &&
    !staleVerifyRequest &&
    isConflictResolutionTask
  ) {
    // Conflict-resolution task: the fix was already pushed to the existing PR
    // branch, so there is no new commit/PR to make and the scope check does not
    // apply. Complete directly — the PR (task.githubPrId) is what carries the work.
    // GitHub, not verify.md, is the evidence that the conflict is gone: #762
    // completed here while PR #534 was still CONFLICTING, and the auto-merge
    // watcher re-filed the identical task 20 minutes later. A PR GitHub still
    // reports DIRTY goes through the bounded self-repair loop instead.
    const prNumber = conflictTask?.githubPrId ?? null;
    const prVerdict = prNumber == null ? null : await readConflictPrVerdict(taskId, prNumber);
    if (prVerdict?.dirty) {
      const reason = `PR #${prNumber} は GitHub 上でまだ競合状態です（mergeStateStatus=DIRTY）。base ブランチの最新を取り込んで競合を解消し、PR ブランチへ push してから再検証してください。`;
      const { attemptVerifyRepair } =
        await import('../../../../services/workflow/verify-self-repair');
      const repair = await attemptVerifyRepair(taskId, newStatus ?? null, reason, savedContent);
      if (repair.bounced && repair.newStatus) {
        log.warn(
          { taskId, prNumber, attempt: repair.attempt, newStatus: repair.newStatus },
          '[Workflow] Conflict-resolution PR still DIRTY on GitHub — re-running implement→verify (self-repair)',
        );
        newStatus = repair.newStatus;
      } else if (!repair.stale) {
        log.warn(
          { taskId, prNumber },
          '[Workflow] Conflict-resolution PR still DIRTY on GitHub and repairs exhausted — blocking task',
        );
        await prisma.task
          .update({ where: { id: taskId }, data: { status: 'blocked', updatedAt: new Date() } })
          .catch(() => {});
        await recordTransition({
          taskId,
          fromStatus: 'verify_done',
          toStatus: 'blocked',
          actor: 'system',
          cause: 'conflict_pr_still_dirty',
          phase: 'verify',
          metadata: { prNumber, state: prVerdict.state },
        });
      }
      return { newStatus, taskMarkedDone, autoCommitPRResult };
    }
    // The PR is no longer DIRTY, but "not conflicting" is not "merged". When
    // autoMergePR was requested for this task, completion belongs to the
    // AutoMergeWatcher after GitHub reports the merge — this branch used to
    // complete on the non-DIRTY verdict alone (task 895).
    if (await isAwaitingRequiredMerge(taskId).catch(() => true)) {
      await holdForRequiredMerge({
        taskId,
        fromStatus: 'verify_done',
        source: 'verify-commit-pr:conflict-resolution',
        metadata: { prNumber },
      });
      return { newStatus: 'verify_done', taskMarkedDone, autoCommitPRResult };
    }
    // Compare-and-swap on verify_done: a concurrent duplicate of this save
    // (task 594 recorded the same completion twice, 242ms apart) must not
    // record a second completion transition — only the request that actually
    // flips the row completes and records. Mirrors the repair rollback below.
    const completed = await prisma.task
      .updateMany({
        where: { id: taskId, workflowStatus: 'verify_done' },
        data: { status: 'done', workflowStatus: 'completed', completedAt: new Date() },
      })
      .catch(() => ({ count: 0 }));
    if (completed.count === 0) {
      log.warn(
        { taskId, prNumber: conflictTask?.githubPrId },
        '[Workflow] Conflict-resolution completion already applied by a concurrent request — skipping duplicate transition',
      );
    } else {
      taskMarkedDone = true;
      await recordTransition({
        taskId,
        fromStatus: 'verify_done',
        toStatus: 'completed',
        actor: 'system',
        cause: 'conflict_resolution_completed',
        phase: 'verify',
        metadata: { prNumber: conflictTask?.githubPrId },
      });
      log.info(
        { taskId, prNumber: conflictTask?.githubPrId },
        '[Workflow] Conflict-resolution task completed (work pushed to PR branch; commit/PR/scope gates skipped).',
      );
    }
  } else if (
    fileType === 'verify' &&
    newStatus === 'verify_done' &&
    !verifyGateBlocked &&
    !staleVerifyRequest
  ) {
    // Run the commit/PR/merge pipeline (initial attempt, history-contamination
    // recovery retry, and the completion gates — see verify-commit-pr-pipeline.ts).
    // NOTE: in-flight registration moved OUT of this stage (task 660). It is
    // now owned by verify-post-save-pipeline.ts, which wraps the completion
    // gate + adversarial jury + this stage as one registered unit; registering
    // here again would overwrite that entry with a narrower Promise.
    const outcome = await runVerifyCommitPrPipeline({
      taskId,
      savedContent,
      preferredBaseBranchForVerify,
    });
    newStatus = outcome.newStatus;
    taskMarkedDone = outcome.taskMarkedDone;
    autoCommitPRResult = outcome.autoCommitPRResult;
  }

  return { newStatus, taskMarkedDone, autoCommitPRResult };
}
