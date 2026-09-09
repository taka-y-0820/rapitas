import { writeBlockedTask } from '../../../../services/workflow/blocked-task-write';
/**
 * FileSave Verify Adversarial Review
 *
 * Independent adversarial diff review of a passing verify.md, including
 * history-contamination recovery (worktree rebuild) and the stale-verdict
 * compare-and-swap guards.
 * Not responsible for the empty-diff gate or commit/PR completion.
 */

import { prisma } from '../../../../config';
import { createLogger } from '../../../../config/logger';
import type { WorkflowFileType } from '../../core/workflow-helpers';
import { recordTransition } from '../../../../services/workflow/transition-recorder';
import { markLatestExecutionFailed, wasNonConvergenceCutoffJustRecorded } from './shared';

const log = createLogger('routes:workflow:handlers:files');

/**
 * Result of the adversarial-review stage. `staleVerifyRequest` is set when a
 * slow, synchronous check finished only after this task already moved past the
 * verify_done status it was evaluated against — e.g. a second, faster
 * verify/repair round already completed and merged it. It makes downstream
 * stages skip any further mutation this request would otherwise make (rollback
 * AND completion), since acting on a stale read here would just corrupt an
 * already-resolved task.
 */
export interface AdversarialReviewOutcome {
  newStatus?: string;
  verifyGateBlocked: boolean;
  staleVerifyRequest: boolean;
}

/**
 * Runs the adversarial diff review for a passing verify.md save.
 *
 * Independent adversarial diff review: a cross-provider JURY (majority
 * vote, tie→fail) scores the ACTUAL diff against plan + acceptance
 * criteria, catching wrong/incomplete implementations that the
 * self-reported verify.md misses. On a FAIL verdict, bounce the workflow
 * back to the implementer (self-repair loop). Availability is risk-gated
 * inside the diff-review gate: low-risk 'unknown' fails open; high-risk changes
 * fail closed when no juror is reachable.
 *
 * @param params - taskId / fileType / newStatus / gate flags / content / base branch / 入力一式
 * @returns Possibly rolled-back newStatus + updated gate/stale flags
 */
export async function runAdversarialDiffReview(params: {
  taskId: number;
  fileType: WorkflowFileType;
  newStatus: string | undefined;
  verifyGateBlocked: boolean;
  isConflictResolutionTask: boolean;
  savedContent: string;
  preferredBaseBranchForVerify: string | null;
}): Promise<AdversarialReviewOutcome> {
  const { taskId, fileType, isConflictResolutionTask, savedContent, preferredBaseBranchForVerify } =
    params;
  let newStatus = params.newStatus;
  let verifyGateBlocked = params.verifyGateBlocked;
  let staleVerifyRequest = false;

  if (
    fileType === 'verify' &&
    newStatus === 'verify_done' &&
    !verifyGateBlocked &&
    !isConflictResolutionTask
  ) {
    const reviewSession = await prisma.agentSession
      .findFirst({
        where: { config: { taskId }, worktreePath: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { worktreePath: true },
      })
      .catch(() => null);
    const { reviewDiffAdversarially } =
      await import('../../../../services/agents/verification/adversarial-diff-review');
    const review = await reviewDiffAdversarially({
      taskId,
      worktreePath: reviewSession?.worktreePath,
    }).catch(() => null);

    if (review && review.verdict === 'fail') {
      // History-contamination recovery (task 539): when the out-of-plan files
      // behind this FAIL came from BRANCH HISTORY (the worktree was cut on
      // another task's unmerged branch), an implementer bounce can never fix
      // it — editing the working tree cannot remove ancestor commits. Rebuild
      // the worktree from the base branch instead, then re-review ONCE.
      const { tryRecoverFromHistoryContamination, notifyRecoveryFallbackBlocked } =
        await import('../../../../services/workflow/worktree-rebuild-recovery');
      const recovery = await tryRecoverFromHistoryContamination(
        taskId,
        reviewSession?.worktreePath,
        preferredBaseBranchForVerify,
      ).catch(
        () =>
          ({ recovered: false }) as Awaited<ReturnType<typeof tryRecoverFromHistoryContamination>>,
      );

      let activeReview = review;
      let reviewStillFailing = true;
      if (recovery.recovered) {
        const retryReview = await reviewDiffAdversarially({
          taskId,
          worktreePath: recovery.newWorktreePath,
        }).catch(() => null);
        if (!retryReview || retryReview.verdict !== 'fail') {
          reviewStillFailing = false;
          // Same compare-and-swap guard as below: the rebuild + re-review took
          // real time — only resume the normal completion flow when the task
          // is still at the status this evaluation was based on.
          const liveAfterRecovery = await prisma.task
            .findUnique({ where: { id: taskId }, select: { workflowStatus: true } })
            .catch(() => null);
          if (liveAfterRecovery?.workflowStatus !== 'verify_done') {
            staleVerifyRequest = true;
            if (liveAfterRecovery?.workflowStatus) newStatus = liveAfterRecovery.workflowStatus;
            log.warn(
              {
                taskId,
                actualStatus: liveAfterRecovery?.workflowStatus,
                reasons: activeReview.reasons.slice(0, 5),
              },
              '[Workflow] Worktree rebuild recovery finished after the workflow moved on — skipping',
            );
          } else {
            log.info(
              { taskId, newWorktreePath: recovery.newWorktreePath },
              '[Workflow] Adversarial review passed after worktree rebuild recovery — resuming normal flow',
            );
          }
        } else {
          // Report the RETRY's reasons — the pre-rebuild verdict is stale.
          activeReview = retryReview;
        }
      }

      const reason = `差分レビュー不合格: ${
        activeReview.reasons.slice(0, 5).join(' / ') || '受入基準を満たしていません'
      }`;

      if (
        reviewStillFailing &&
        (recovery.reason === 'recovery_already_used' || recovery.reason === 'patch_apply_conflict')
      ) {
        // Contamination recovery exhausted (受入基準3) or failed after the old
        // worktree was destroyed (受入基準2c): an implementer bounce is either
        // futile (same contaminated history again) or impossible (no worktree)
        // — block + notify directly, WITHOUT attemptVerifyRepair.
        const liveTask = await prisma.task
          .findUnique({ where: { id: taskId }, select: { workflowStatus: true } })
          .catch(() => null);
        if (liveTask?.workflowStatus !== 'verify_done') {
          staleVerifyRequest = true;
          if (liveTask?.workflowStatus) newStatus = liveTask.workflowStatus;
          log.warn(
            {
              taskId,
              recoveryReason: recovery.reason,
              actualStatus: liveTask?.workflowStatus,
              reasons: activeReview.reasons.slice(0, 5),
            },
            '[Workflow] Recovery-blocked verdict arrived after the workflow moved on — skipping',
          );
        } else {
          verifyGateBlocked = true;
          const blockedTitle =
            recovery.reason === 'recovery_already_used'
              ? '差分レビューが再び計画外混入で不合格（worktree再構築の上限到達）'
              : 'worktree再構築リカバリが失敗しました';
          const blockedMessage =
            recovery.reason === 'recovery_already_used'
              ? `タスク #${taskId} はブランチ履歴汚染による worktree 再構築を既に1回実施済みですが、再度計画外混入が検出されました。手動確認が必要です。`
              : `タスク #${taskId} の worktree 再構築中にパッチ適用が失敗しました。退避タグ（recovery/task-${taskId}-*）から手動復旧してください。`;
          // Dynamic import mirrors this handler's convention — keeps the
          // static graph free of config/database for test isolation.
          const { writeBlockedStatusDurable } =
            await import('../../../../services/workflow/durable-blocked-write');
          await writeBlockedStatusDurable({
            taskId,
            log,
            source: 'Workflow',
            notification: { title: blockedTitle, message: blockedMessage },
          });
          await notifyRecoveryFallbackBlocked(taskId, blockedTitle, blockedMessage);
          await markLatestExecutionFailed(taskId, reason);
          await recordTransition({
            taskId,
            fromStatus: 'verify_done',
            toStatus: 'verify_done',
            actor: 'system',
            cause: 'adversarial_review_failed',
            phase: 'verify',
            metadata: {
              severity: activeReview.severity,
              reasons: activeReview.reasons.slice(0, 5),
              recoveryOutcome: recovery.reason,
              recoveryExhausted: recovery.reason === 'recovery_already_used',
            },
            invariantViolation: true,
            invariantMessage: reason,
          }).catch(() => {});
          log.warn(
            { taskId, recoveryReason: recovery.reason, severity: activeReview.severity },
            '[Workflow] History-contamination recovery unavailable — task blocked (no implementer bounce)',
          );
        }
      } else if (reviewStillFailing) {
        const { attemptVerifyRepair } =
          await import('../../../../services/workflow/verify-self-repair');
        const repair = await attemptVerifyRepair(taskId, 'verify_done', reason, savedContent).catch(
          () => ({ bounced: false }) as Awaited<ReturnType<typeof attemptVerifyRepair>>,
        );
        // Compare-and-swap: this review runs an LLM jury synchronously and can
        // take a while — a second, faster verify attempt (self-repair round, or
        // a race) can legitimately complete and even merge the task before this
        // verdict comes back. Applying it unconditionally would then stomp an
        // already-completed/merged task back to plan_approved (observed: task
        // 503 was rolled back ~40s after its PR had already merged). Skip the
        // entire rollback — including verifyGateBlocked and the transition log —
        // when the task has already moved off the status this review evaluated.
        const liveTask = await prisma.task
          .findUnique({ where: { id: taskId }, select: { workflowStatus: true } })
          .catch(() => null);
        if (liveTask?.workflowStatus !== 'verify_done') {
          staleVerifyRequest = true;
          // Report what the task ACTUALLY is now (e.g. 'completed'), not the
          // 'verify_done' this stale evaluation was based on — the response
          // reaches the saving agent, and it must not be told a status that
          // isn't true in the DB.
          if (liveTask?.workflowStatus) newStatus = liveTask.workflowStatus;
          log.warn(
            {
              taskId,
              severity: activeReview.severity,
              actualStatus: liveTask?.workflowStatus,
              reasons: activeReview.reasons.slice(0, 5),
            },
            '[Workflow] Adversarial review FAIL arrived after the workflow moved on — skipping rollback entirely',
          );
        } else {
          verifyGateBlocked = true;
          if (repair.bounced && repair.newStatus) {
            const rolled = await prisma.task
              .updateMany({
                where: { id: taskId, workflowStatus: 'verify_done' },
                data: { workflowStatus: repair.newStatus },
              })
              .catch(() => ({ count: 0 }));
            if (rolled.count === 0) {
              log.warn(
                { taskId, attempt: repair.attempt, severity: activeReview.severity },
                '[Workflow] Adversarial review FAIL lost the compare-and-swap race — skipping rollback',
              );
            } else {
              newStatus = repair.newStatus;
              // Bounced ≠ this execution succeeded: the diff it produced was
              // rejected, even though the workflow itself lives on for a retry
              // (a fresh AgentExecution row is created for that). Without this,
              // markLatestExecutionFailed only ran once repairs were exhausted,
              // so a bounced-for-retry run kept showing 完了/success in the
              // execution log while the task had just been rolled back.
              await markLatestExecutionFailed(taskId, reason);
              log.warn(
                { taskId, attempt: repair.attempt, severity: activeReview.severity },
                '[Workflow] Adversarial diff review FAILED — bounced to implementer for self-repair',
              );
            }
          } else {
            // NOTE: this update was previously missing — the log claimed "task
            // stays blocked" but task.status was never actually set, leaving
            // the task looking untouched (status stuck at whatever it already
            // was, e.g. 'todo') instead of clearly flagged for attention
            // (task 504: workflowStatus stayed 'verify_done' with no PR/commit
            // and status='todo', indistinguishable from a never-started task).
            await writeBlockedTask(prisma, taskId).catch(() => {});
            await markLatestExecutionFailed(taskId, reason);
            log.warn(
              { taskId, severity: activeReview.severity },
              '[Workflow] Adversarial diff review FAILED and repairs exhausted — task stays blocked',
            );
          }
          // The non-convergence cutoff already recorded its OWN
          // `verify_repair_non_convergence` transition for this rejection
          // (verify-self-repair.ts) — recording `adversarial_review_failed`
          // here too would duplicate it (task 674: two rows 43ms apart; task
          // 715 recurred even with the wasNonConvergenceCutoffJustRecorded
          // DB-read guard below, so `repair.cutoffRecorded` — the in-band
          // signal from THIS exact attemptVerifyRepair() call, task 710 — is
          // checked first as the authoritative source).
          if (!repair.cutoffRecorded && !(await wasNonConvergenceCutoffJustRecorded(taskId))) {
            await recordTransition({
              taskId,
              // newStatus is 'verify_done' here unless the bounce above rolled
              // it back — the fallback only guards the (unreachable) undefined.
              toStatus: newStatus ?? 'verify_done',
              fromStatus: 'verify_done',
              actor: 'system',
              cause: 'adversarial_review_failed',
              phase: 'verify',
              metadata: {
                severity: activeReview.severity,
                reasons: activeReview.reasons.slice(0, 5),
              },
              invariantViolation: true,
              invariantMessage: reason,
            }).catch(() => {});
          }
        }
      }
    }
  }

  return { newStatus, verifyGateBlocked, staleVerifyRequest };
}
