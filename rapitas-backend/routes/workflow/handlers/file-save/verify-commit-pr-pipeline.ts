import { writeBlockedTask } from '../../../../services/workflow/blocked-task-write';
import type { CompletionReviewReceipt } from '../../../../services/workflow/requirement-replan-commit';
/**
 * FileSave Verify Commit/PR Pipeline
 *
 * The full post-verify automation for a passing verify.md: the initial
 * commit/PR/merge attempt, the history-contamination recovery retry, the
 * PR-required completion gate, staged completion, and the post-completion
 * side effects. Extracted out of verify-commit-pr.ts so callers can register
 * the WHOLE pipeline — not just the initial attempt — as one in-flight
 * Promise (task 657: the initial-attempt-only registration let the
 * WorkflowRunner's 60s settle window expire mid-recovery and report task
 * #653 as blocked 79s before its PR actually landed).
 */

import { prisma } from '../../../../config';
import { createLogger } from '../../../../config/logger';
import { performAutoCommitAndPR, isNoChangeCompletion } from '../../workflow-auto-commit';
import { resolveLandingMode } from '../../../../services/workflow/automation-policy';
import { recordTransition } from '../../../../services/workflow/transition-recorder';
import { markLatestExecutionFailed } from './shared';
import { handleVerifyGateBlocked } from './verify-commit-pr-gate-blocked';
import { runVerifyCompletionSideEffects } from './verify-commit-pr-side-effects';

const log = createLogger('routes:workflow:handlers:files');

/**
 * Result of the commit/PR completion stage: the (possibly updated) newStatus,
 * whether the task actually completed, and the raw auto-commit/PR result the
 * HTTP response echoes back.
 */
export interface CommitPrCompletionOutcome {
  newStatus?: string;
  taskMarkedDone: boolean;
  autoCommitPRResult: Awaited<ReturnType<typeof performAutoCommitAndPR>>;
}

/**
 * Runs commit/PR/merge, its history-contamination recovery retry, and the
 * completion gates for a `verify_done` task whose verify.md just passed.
 *
 * The returned Promise MUST run inside a registerVerifyCompletion scope
 * (owned by verify-post-save-pipeline.ts, which registers the completion gate
 * + adversarial review + this pipeline as one unit before awaiting any of
 * them) so the WorkflowRunner's verify-settle wait treats the entire
 * post-verify automation as in-flight, not just the first commit/PR call.
 *
 * @param params - taskId / verify.md の保存内容 / 優先ベースブランチ
 * @returns The completion outcome
 */
export async function runVerifyCommitPrPipeline(params: {
  completionReceipt?: CompletionReviewReceipt;
  taskId: number;
  savedContent: string;
  preferredBaseBranchForVerify: string | null;
}): Promise<CommitPrCompletionOutcome> {
  const { taskId, savedContent, preferredBaseBranchForVerify } = params;
  let newStatus: string | undefined = 'verify_done';
  let taskMarkedDone = false;
  const finalize = async (cause: 'verify_passed' | 'verify_no_change_confirmed') => {
    if (!params.completionReceipt) throw new Error('Missing server completion review receipt');
    const { completeReviewedTask } =
      await import('../../../../services/workflow/requirement-replan-commit');
    const completed = await completeReviewedTask(prisma, params.completionReceipt, { cause });
    if (!completed.committed && completed.reason === 'already_completed') return;
    if (!completed.committed) throw new Error(`Reviewed completion held: ${completed.reason}`);
    taskMarkedDone = true;
    newStatus = 'completed';
  };

  const assertCurrent = async () => {
    if (!params.completionReceipt || params.completionReceipt.taskId !== taskId)
      throw new Error('Missing server completion review receipt');
    const { assertReviewedTaskCurrent } =
      await import('../../../../services/workflow/requirement-replan-commit');
    await assertReviewedTaskCurrent(prisma, params.completionReceipt);
  };
  await assertCurrent();
  const commitPrWork = performAutoCommitAndPR(taskId, savedContent).catch((err) => {
    log.warn({ err, taskId }, '[Workflow] Auto-commit/PR threw');
    return {} as Awaited<ReturnType<typeof performAutoCommitAndPR>>;
  });
  let autoCommitPRResult = await commitPrWork;

  // History-contamination recovery (task 539): when the automated gate
  // withheld commit/PR because the out-of-plan files came from branch
  // history, rebuild the worktree and retry ONCE. performAutoCommitAndPR
  // re-reads the latest session's worktreePath, which the recovery updates.
  let gateRecoveryBlocked: 'recovery_already_used' | 'patch_apply_conflict' | null = null;
  if (autoCommitPRResult.verificationBlocked && !autoCommitPRResult.verificationUnverifiable) {
    const { tryRecoverFromHistoryContamination } =
      await import('../../../../services/workflow/worktree-rebuild-recovery');
    const gateWorktreeSession = await prisma.agentSession
      .findFirst({
        where: { config: { taskId }, worktreePath: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { worktreePath: true },
      })
      .catch(() => null);
    await assertCurrent();
    const recovery = await tryRecoverFromHistoryContamination(
      taskId,
      gateWorktreeSession?.worktreePath,
      preferredBaseBranchForVerify,
    ).catch(
      () =>
        ({ recovered: false }) as Awaited<ReturnType<typeof tryRecoverFromHistoryContamination>>,
    );
    if (recovery.recovered) {
      await assertCurrent();
      autoCommitPRResult = await performAutoCommitAndPR(taskId, savedContent).catch((err) => {
        log.warn({ err, taskId }, '[Workflow] Auto-commit/PR retry after worktree rebuild threw');
        return {} as Awaited<ReturnType<typeof performAutoCommitAndPR>>;
      });
      log.info(
        { taskId, retryBlocked: autoCommitPRResult.verificationBlocked === true },
        '[Workflow] Verification gate re-ran after worktree rebuild recovery',
      );
    } else if (
      recovery.reason === 'recovery_already_used' ||
      recovery.reason === 'patch_apply_conflict'
    ) {
      gateRecoveryBlocked = recovery.reason;
    }
  }

  const commit = autoCommitPRResult.autoCommitResult;
  const pr = autoCommitPRResult.autoPRResult;
  const merge = autoCommitPRResult.autoMergeResult;

  if (autoCommitPRResult.verificationBlocked) {
    if (autoCommitPRResult.verificationUnverifiable) {
      // The gate already persisted the blocked task and original evidence.
      // No rebuild, repair budget, receipt refresh or completion is justified
      // when the verification infrastructure could not establish correctness.
      log.warn(
        { taskId, reason: autoCommitPRResult.error },
        '[Workflow] Verification unavailable; retaining blocked task and worktree',
      );
      return { newStatus, taskMarkedDone: false, autoCommitPRResult };
    }
    // The automated gate (lint/typecheck/test/scope) found problems, so
    // commit/PR were withheld. Bounce to the implementer for self-repair
    // (bounded by RAPITAS_MAX_VERIFY_REPAIRS) rather than dead-ending at
    // `blocked`; block only once exhausted. See verify-commit-pr-gate-blocked.ts.
    const gateReason =
      autoCommitPRResult.error ?? '自動検証に失敗しました（lint/型/テスト/スコープ）。';
    const gateOutcome = await handleVerifyGateBlocked({
      taskId,
      gateReason,
      gateRecoveryBlocked,
      savedContent,
    });
    if (gateOutcome.newStatus) newStatus = gateOutcome.newStatus;
  } else {
    // Completion REQUIRES a successfully created PR (user request): a passing
    // verify is no longer enough — the change must reach a PR. Exceptions:
    //   - PR creation was not requested (autoCreatePR off), or
    //   - a PR already exists for this task (app-linked or task.githubPrId).
    const prRequested = autoCommitPRResult.requested
      ? autoCommitPRResult.requested.autoCreatePR
      : true; // requested unset (e.g. threw) → default flow expects a PR
    let prSatisfied = pr?.success === true;
    if (prRequested && !prSatisfied) {
      const linked = await prisma.gitHubPullRequest
        .findFirst({ where: { linkedTaskId: taskId }, select: { id: true } })
        .catch(() => null);
      if (linked) {
        prSatisfied = true;
      } else {
        const taskRow = await prisma.task
          .findUnique({ where: { id: taskId }, select: { githubPrId: true } })
          .catch(() => null);
        prSatisfied = taskRow?.githubPrId != null;
      }
    }

    // No-diff / already-implemented: nothing to PR because the code already
    // satisfies the task — complete as no-change instead of wrongly blocking
    // (mirrors research "## 結論: 修正不要"). Classifier excludes base-branch
    // errors and real committed changes (task 485).
    const noChangeCompletion =
      prRequested &&
      !prSatisfied &&
      isNoChangeCompletion({
        errorBlob: `${pr?.error ?? ''} ${commit?.error ?? ''} ${autoCommitPRResult.error ?? ''}`,
        filesChanged: commit?.filesChanged,
      });

    if (noChangeCompletion) {
      await finalize('verify_no_change_confirmed');
    } else if (prRequested && !prSatisfied) {
      // Verify passed but no PR was produced — do NOT complete. Keep the task
      // actionable (blocked) and surface why, so "完了" always implies a PR.
      const reason =
        pr?.error || commit?.error || autoCommitPRResult.error || 'PRが作成されませんでした';
      await writeBlockedTask(prisma, taskId).catch(() => {});
      await markLatestExecutionFailed(
        taskId,
        `検証は通過しましたがPRが作成されませんでした: ${reason}。完了にはPR作成が必要です。まだ自動リカバリの再試行回数に余裕があれば、数分以内にPR再作成のみを行う軽量な自動リトライが1回行われます — 緊急でなければ、今すぐの手動リトライは控えて自動リトライの結果を待ってください。`,
      );
      await recordTransition({
        taskId,
        fromStatus: 'verify_done',
        toStatus: 'verify_done',
        actor: 'system',
        cause: 'verify_pr_not_created',
        phase: 'verify',
        metadata: {
          commit: commit?.success,
          prError: pr?.error,
          error: autoCommitPRResult.error,
        },
        invariantViolation: true,
        invariantMessage: '検証通過後にPRが作成されませんでした。PR作成成功まで完了にしません。',
      });
      log.warn(
        {
          taskId,
          prError: pr?.error,
          commitOk: commit?.success,
          error: autoCommitPRResult.error,
        },
        '[Workflow] verify passed but no PR created — NOT completing (completion requires a PR).',
      );
    } else {
      // Staged completion: when changes land via a PR, completion is NOT at
      // PR creation — `pr` mode completes when the PR's CI goes green, `merge`
      // mode completes when the PR is merged. A requested merge is always a
      // completion requirement; the legacy flag only controls CI-only PR mode.
      // The watcher verifies the external result before completing the task.
      const staged =
        process.env.RAPITAS_STAGED_COMPLETION === 'true' ||
        process.env.RAPITAS_STAGED_COMPLETION === '1';
      const landingMode = autoCommitPRResult.requested
        ? resolveLandingMode(autoCommitPRResult.requested)
        : 'none';
      if (landingMode === 'merge' || (staged && landingMode === 'pr')) {
        // Hold at verify_done (status stays in-progress, NOT done). The watcher
        // completes on CI-green (pr) / merge (merge). Do not fire completion
        // side effects yet (taskMarkedDone stays false).
        await recordTransition({
          taskId,
          fromStatus: 'verify_done',
          toStatus: 'verify_done',
          actor: 'system',
          cause: 'verify_passed_awaiting_ci',
          phase: 'verify',
          metadata: { landingMode, pr: pr?.success, prNumber: pr?.prNumber },
        });
        log.info(
          { taskId, landingMode, prNumber: pr?.prNumber },
          '[Workflow] verify passed + PR created — completion deferred to CI/merge (staged completion).',
        );
      } else {
        await finalize('verify_passed');
        log.info(
          { taskId, commitOk: commit?.success, prOk: pr?.success, mergeOk: merge?.success },
          '[Workflow] verify.md passed AND PR satisfied — task marked done/completed.',
        );
      }
    }
  }

  // Post-completion side effects only when the task ACTUALLY completed (not
  // when it was bounced for self-repair or held for a missing PR).
  // NOTE: Extracted to verify-commit-pr-side-effects.ts — behaviour unchanged.
  if (taskMarkedDone) {
    runVerifyCompletionSideEffects(taskId, savedContent);
  }

  return { newStatus, taskMarkedDone, autoCommitPRResult };
}
