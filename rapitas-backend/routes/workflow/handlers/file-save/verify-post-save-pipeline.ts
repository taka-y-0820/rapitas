import type { CompletionReviewReceipt } from '../../../../services/workflow/requirement-replan-commit';
/**
 * FileSave Verify Post-Save Pipeline
 *
 * Runs everything that follows a passing verify.md's `verify_done` write — the
 * empty-diff completion gate, the adversarial jury review and the commit / PR
 * / merge completion — as ONE unit of work registered with the
 * verify-completion in-flight registry before any of it is awaited.
 * Not responsible for the stage logic itself; only for the ordering and for
 * the registration boundary.
 */

import type { WorkflowFileType } from '../../core/workflow-helpers';
import { registerVerifyCompletion } from '../../../../services/workflow/verify-completion-inflight';
import { runVerifyCompletionGate } from './verify-completion-gate';
import { runAdversarialDiffReview } from './verify-adversarial-review';
import { runVerifyCommitPrCompletion, type CommitPrCompletionOutcome } from './verify-commit-pr';

/**
 * Runs the post-save automation for a verify.md that just reached `verify_done`.
 *
 * The task's `workflowStatus` is already `verify_done` in the DB by the time
 * this is called, so the WorkflowRunner's verify-settle wait can observe it
 * from its very first poll. Task 658 (task 660): only the commit/PR stage was
 * registered in-flight, so the gate + LLM jury that precede it (jurors time
 * out at 120s each) ran with the registry empty, the runner's 60s window
 * expired at 63s and a task whose PR #458 landed 3.5 minutes later was parked
 * as blocked. Registering the whole sequence here, BEFORE the first await,
 * closes that gap: there is no longer any moment between the DB write and the
 * final outcome in which the automation is running but unregistered.
 *
 * Every early exit inside the three stages (gate blocked, jury FAIL bounce,
 * recovery exhausted) is a normal `return` from those functions, so the
 * wrapped Promise settles and the registry entry is released on all of them.
 *
 * @param params - taskId / fileType / newStatus after the status transition / saved verify.md content / 入力一式
 * @returns The completion outcome (pass-through when the save was not a passing verify)
 */
export async function runVerifyPostSaveAutomation(params: {
  completionReceipt?: CompletionReviewReceipt;
  taskId: number;
  fileType: WorkflowFileType;
  newStatus: string | undefined;
  savedContent: string;
}): Promise<CommitPrCompletionOutcome> {
  const { taskId, fileType, newStatus, savedContent } = params;

  if (fileType !== 'verify' || newStatus !== 'verify_done') {
    return { newStatus, taskMarkedDone: false, autoCommitPRResult: {} };
  }

  const work = (async (): Promise<CommitPrCompletionOutcome> => {
    const completionGate = await runVerifyCompletionGate({
      completionReceipt: params.completionReceipt,
      taskId,
      fileType,
      newStatus,
      savedContent,
    });
    const { conflictTask, isConflictResolutionTask, preferredBaseBranchForVerify } = completionGate;

    const adversarial = await runAdversarialDiffReview({
      taskId,
      fileType,
      newStatus,
      verifyGateBlocked: completionGate.verifyGateBlocked,
      isConflictResolutionTask,
      savedContent,
      preferredBaseBranchForVerify,
    });

    return runVerifyCommitPrCompletion({
      completionReceipt: params.completionReceipt,
      taskId,
      fileType,
      newStatus: adversarial.newStatus,
      verifyGateBlocked: adversarial.verifyGateBlocked,
      staleVerifyRequest: adversarial.staleVerifyRequest,
      isConflictResolutionTask,
      conflictTask,
      savedContent,
      preferredBaseBranchForVerify,
    });
  })();

  // Register synchronously, before the first await: the runner may poll this
  // task at any moment after the verify_done write above, and must see it as
  // live work from the gate onward — not only once commit/PR begins.
  registerVerifyCompletion(taskId, work);
  return work;
}
