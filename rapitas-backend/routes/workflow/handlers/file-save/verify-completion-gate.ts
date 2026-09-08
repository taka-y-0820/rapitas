import type { CompletionReviewReceipt } from '../../../../services/workflow/requirement-replan-commit';
/**
 * FileSave Verify Completion Gate
 *
 * Conflict-resolution task detection and the empty-diff completion gate for a
 * passing verify.md (block on first empty diff, complete as 修正不要 on repeat).
 * Not responsible for the adversarial diff review or commit/PR completion.
 */

import { prisma } from '../../../../config';
import { createLogger } from '../../../../config/logger';
import type { WorkflowFileType } from '../../core/workflow-helpers';
import { evaluateCompletionGate } from '../../../../services/workflow/completion-gate';
import { blockReviewedEmptyDiff } from '../../../../services/workflow/reviewed-empty-diff';
import { resolvePreferredBaseBranch } from '../../../../services/task/task-resolver';

const log = createLogger('routes:workflow:handlers:files');

/**
 * Result of the verify completion-gate stage, shared by the adversarial-review
 * and commit/PR stages downstream.
 */
export interface VerifyCompletionGateOutcome {
  verifyGateBlocked: boolean;
  conflictTask: { title: string | null; githubPrId: number | null } | null;
  isConflictResolutionTask: boolean;
  preferredBaseBranchForVerify: string | null;
}

/**
 * Evaluates the empty-diff completion gate for a passing verify.md save.
 *
 * Completion gate: a passing verify may only complete the task when it is
 * backed by REAL code changes (or verify.md explicitly justifies a no-op).
 * Otherwise it's the silent-skip pattern (agent claimed work it never did —
 * empty diff, no commit) and we block for inspection instead of completing.
 *
 * Conflict-resolution tasks (system-generated "PR #N の競合を解消", githubPrId
 * set at CREATION) deliver their result by PUSHING to the EXISTING PR branch —
 * not as a worktree diff or a new PR. The empty-diff gate, the adversarial
 * diff-review, the scope check and the PR-required gate all assume "diff
 * matches plan → publish a new PR", so they FALSELY bounce these tasks (the
 * `git merge base` pulls the base branch's files into the worktree → scope NG
 * (31 files) and a diff-vs-plan mismatch → verify_repair, looping forever even
 * though the PR is already mergeable). Skip all those gates and complete on a
 * passing verify; the target PR (task.githubPrId) already exists.
 *
 * @param params - taskId / fileType / current newStatus / persisted content / 入力一式
 * @returns Gate outcome + conflict-task classification + resolved base branch
 */
export async function runVerifyCompletionGate(params: {
  completionReceipt?: CompletionReviewReceipt;
  taskId: number;
  fileType: WorkflowFileType;
  newStatus: string | undefined;
  savedContent: string;
}): Promise<VerifyCompletionGateOutcome> {
  const { taskId, fileType, newStatus, savedContent } = params;

  let verifyGateBlocked = false;

  const conflictTask =
    fileType === 'verify' && newStatus === 'verify_done'
      ? await prisma.task
          .findUnique({ where: { id: taskId }, select: { title: true, githubPrId: true } })
          .catch(() => null)
      : null;
  const isConflictResolutionTask =
    !!conflictTask &&
    conflictTask.githubPrId != null &&
    /^PR #\d+ の競合を解消/.test(conflictTask.title ?? '');

  // Resolved once, shared by the completion gate and BOTH history-contamination
  // recovery call sites downstream (adversarial review / verification gate) — see
  // plan.md 申し送り: avoid recomputing resolvePreferredBaseBranch per branch.
  let preferredBaseBranchForVerify: string | null = null;
  if (fileType === 'verify' && newStatus === 'verify_done' && !isConflictResolutionTask) {
    const gateSession = await prisma.agentSession
      .findFirst({
        where: { config: { taskId }, worktreePath: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { worktreePath: true },
      })
      .catch(() => null);
    // The worktree's ACTUAL fork point, not a guess — see automated-verifier
    // .ts's diffBaseRef doc comment (task 506). NOTE: theme.defaultBranch,
    // not AgentExecutionConfig.targetBranch alone (task 511: that table is
    // empty for the autonomous pipeline) — see resolvePreferredBaseBranch's
    // doc comment. This call site was missed when the other five were fixed.
    preferredBaseBranchForVerify = await resolvePreferredBaseBranch(taskId);
    const completionGate = await evaluateCompletionGate(
      gateSession?.worktreePath ?? null,
      savedContent,
      preferredBaseBranchForVerify,
    );
    if (!completionGate.allow) {
      verifyGateBlocked = true;
      // Repeated empty diffs are not evidence that the requirements are met.
      const receipt = params.completionReceipt;
      if (!receipt || receipt.taskId !== taskId) throw new Error('Missing reviewed verify receipt');
      await blockReviewedEmptyDiff(prisma, receipt, completionGate.reason);
      log.warn(
        { taskId, reason: completionGate.reason },
        '[Workflow] verify passed but no code changes and no justification — blocking until implementation or explicit justification is provided',
      );
    }
  }

  return {
    verifyGateBlocked,
    conflictTask,
    isConflictResolutionTask,
    preferredBaseBranchForVerify,
  };
}
