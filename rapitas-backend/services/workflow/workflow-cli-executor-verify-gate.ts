/**
 * Workflow CLI Executor Verify Gate
 *
 * Decides the verify phase's resulting workflow status for orchestrator /
 * queue-driven runs: honors an HTTP-completed state and fresh verify
 * rejections, blocks on hard validation failures or missing code changes,
 * requires a PR for completion (with the no-change classification), and
 * completes the task on full success. Not responsible for artifact harvesting
 * or non-verify status advancement.
 */
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import { readWorkflowFile } from './workflow-file-utils';
import type { ValidationResult } from './phase-output-validator';
import type { RoleTransition, WorkflowAdvanceResult } from './workflow-types';
import { recordTransition, type TransitionActor } from './transition-recorder';
import { evaluateCompletionGate } from './completion-gate';
import { isAwaitingRequiredMerge } from './verify-settle-artifact-recovery';
import { holdForRequiredMerge } from './required-merge-hold';
import { writeBlockedStatusDurable } from './durable-blocked-write';
import {
  taskHasLinkedPr,
  wasVerifyValidationFailureJustRecorded,
} from './workflow-cli-executor-helpers';

// NOTE: Same logger name as the executor body — keeps the observed log `name`
// field identical after the file split.
const log = createLogger('workflow-cli-executor');

/**
 * Resolve the phase status for a saved verify.md, mirroring the HTTP
 * file-save auto-complete so orchestrator / queue-driven runs (subtasks)
 * don't get stuck at verify_done with task.status still 'in-progress'.
 * A passing verify completes the task; a hard validation failure blocks it
 * for fix + re-verify.
 *
 * @param params - Verify-gate inputs (task, transition, session, current status, artifact, validation, worktree) / 検証ゲートの入力一式
 * @returns The phase status the executor should report / エピローグが報告すべきフェーズステータス
 */
export async function resolveVerifyPhaseStatus(params: {
  taskId: number;
  transition: RoleTransition;
  session: { id: number };
  currentWfStatus: string;
  fileContent: Awaited<ReturnType<typeof readWorkflowFile>>;
  validation: ValidationResult;
  resolvedWorktreePath: string | null;
}): Promise<WorkflowAdvanceResult['status']> {
  const { taskId, transition, session, currentWfStatus, fileContent, validation } = params;
  const { resolvedWorktreePath } = params;
  let phaseStatus: WorkflowAdvanceResult['status'];
  if (currentWfStatus === 'completed') return 'completed';
  const hardFail = !validation.ok && validation.severity >= 80;
  // The agent saved verify.md via the HTTP API during its run — if that
  // save was just REJECTED there (self-repair bounce or adversarial-review
  // FAIL), the rejection owns the task's next step. Running the completion
  // epilogue anyway would commit/PR/complete over the bounce (task 485).
  const { hasFreshVerifyRejection } = await import('./verify-self-repair');
  // Also honor a `verify_validation_failed` the HTTP save gate already
  // recorded moments ago — hasFreshVerifyRejection() doesn't cover that cause
  // (it owns terminal-block recording, not rejection-freshness detection), so
  // without this the epilogue below re-runs attemptVerifyRepair() a second
  // time and double-records the same failure as two transitions (task 720).
  const verifyRejected =
    (await hasFreshVerifyRejection(taskId)) ||
    (await wasVerifyValidationFailureJustRecorded(taskId));
  if (verifyRejected) {
    phaseStatus = currentWfStatus as WorkflowAdvanceResult['status'];
    log.warn(
      { taskId, currentWfStatus },
      '[WorkflowCLIExecutor] Verify was rejected by a fresh gate rejection — honoring it and skipping the completion epilogue',
    );
    return phaseStatus;
  }
  // The HTTP rejection owns the next action. Only review a still-admissible
  // artifact, and never treat an unreadable rejection history as approval.
  const { attemptRequirementReplan } = await import('./requirement-replan-service');
  const replan = await attemptRequirementReplan(prisma, taskId);
  if (replan.committed) return 'research_done';
  if (replan.reason !== 'no_mismatch') {
    throw new Error(`Requirement replan review held: ${replan.reason}`);
  }
  const finalize = async (cause: 'verify_passed' | 'verify_no_change_confirmed') => {
    if (!replan.completionReceipt) throw new Error('Missing server completion review receipt');
    const { completeReviewedTask } = await import('./requirement-replan-commit');
    const settled = await completeReviewedTask(prisma, replan.completionReceipt, {
      cause,
      sessionId: session.id,
    });
    if (!settled.committed) throw new Error(`Reviewed completion held: ${settled.reason}`);
  };
  if (hardFail) {
    // Give the CLI/orchestrator-driven epilogue the same self-repair chance
    // as the HTTP save path (status-transition.ts) — previously this branch
    // blocked directly, so every hard-fail evaluated here consumed a blind
    // blocked_auto_retry instead of the bounded verify→implement repair
    // budget, delaying escalation to the existing verify_repair_exhausted /
    // verify_no_convergence classification (task 705, task #684 timeline).
    const { attemptVerifyRepair } = await import('./verify-self-repair');
    const repair = await attemptVerifyRepair(
      taskId,
      currentWfStatus,
      validation.summary,
      typeof fileContent === 'string' ? fileContent : '',
    );

    if (repair.bounced && repair.newStatus) {
      log.warn(
        { taskId, attempt: repair.attempt, newStatus: repair.newStatus },
        '[WorkflowCLIExecutor] verify hard-fail — re-running implement→verify (self-repair)',
      );
      phaseStatus = repair.newStatus as WorkflowAdvanceResult['status'];
    } else if (repair.stale) {
      // The workflow advanced past the evaluated status while this verdict
      // was in flight — neither bounce nor block (task 551 CAS pattern).
      phaseStatus = currentWfStatus as WorkflowAdvanceResult['status'];
    } else {
      // This write is what actually STOPS the verify hard-fail loop, so a
      // swallowed failure here (mirroring the workflow-orchestrator
      // plan-replan incident) could let the task re-enter verify on the
      // next poll. Retry once, then notify a human on continued failure.
      await writeBlockedStatusDurable({
        taskId,
        log,
        source: 'WorkflowCLIExecutor',
        notification: {
          title: 'ブロック処理の書き込みに失敗',
          message: `タスク #${taskId} を blocked にする更新が2回失敗しました（検証バリデーション不合格）。手動確認が必要です。`,
        },
      });
      // Skip when attemptVerifyRepair() already recorded its own terminal
      // transition (non-convergence cutoff) — avoids double-recording one
      // verify failure as two transitions (task 705).
      if (!repair.cutoffRecorded) {
        await recordTransition({
          taskId,
          fromStatus: currentWfStatus,
          toStatus: currentWfStatus,
          actor: transition.role as TransitionActor,
          cause: 'verify_validation_failed',
          phase: 'verify',
          sessionId: session.id,
          metadata: { reason: validation.summary },
          invariantViolation: true,
          invariantMessage: validation.summary,
        });
      }
      phaseStatus = currentWfStatus as WorkflowAdvanceResult['status'];
    }
  } else {
    // Completion gate: a passing verify may only complete the task when it
    // is backed by REAL code changes, or verify.md explicitly justifies a
    // no-op. Otherwise it's the silent-skip pattern (agent claimed work it
    // never did — empty diff, no commit) and we block for inspection.
    const gate = await evaluateCompletionGate(
      resolvedWorktreePath,
      typeof fileContent === 'string' ? fileContent : '',
    );
    if (!gate.allow) {
      await prisma.task.update({
        where: { id: taskId },
        data: { status: 'blocked' },
      });
      await recordTransition({
        taskId,
        fromStatus: currentWfStatus,
        toStatus: currentWfStatus,
        actor: transition.role as TransitionActor,
        cause: 'verify_no_changes',
        phase: 'verify',
        sessionId: session.id,
        metadata: { reason: gate.reason },
        invariantViolation: true,
        invariantMessage:
          '検証は通過しましたが、実装による変更がありません（verify.md に「変更不要の理由」の明記もなし）。暗黙的な完了を防ぐためタスクをブロックしました。',
      });
      phaseStatus = currentWfStatus as WorkflowAdvanceResult['status'];
      log.warn(
        { taskId, reason: gate.reason },
        '[WorkflowCLIExecutor] Verify passed but no code changes and no justification — blocking instead of completing',
      );
    } else {
      // Completion REQUIRES a PR — mirror the HTTP file-save handler
      // (workflow-handlers-files.ts). This phased/queue path previously marked
      // the task done WITHOUT creating or confirming a PR, so auto-run tasks
      // that completed here produced no PR at all (the HTTP path made PRs; this
      // one silently did not).
      let prSatisfied = await taskHasLinkedPr(taskId);
      let prRequested = true;
      let prError: string | undefined;
      // No-diff / already-implemented classification: PR creation failed
      // because there is nothing to land. Requiring a PR would wrongly
      // block an already-done task — complete as a no-change result
      // instead (PR required ONLY for actual changes). The shared
      // classifier excludes base-branch errors and real committed changes
      // (task 485 false completion). Mirrors the HTTP handler.
      let noChangeCompletion = false;
      if (!prSatisfied) {
        // No PR yet (e.g. the HTTP save bounced before PR creation). Run the
        // shared commit/PR flow; a pre-existing PR is re-confirmed via
        // taskHasLinkedPr. Dynamic import avoids a routes↔services import cycle.
        const { performAutoCommitAndPR, isNoChangeCompletion } =
          await import('../../routes/workflow/workflow-auto-commit');
        if (!replan.completionReceipt) throw new Error('Missing server completion review receipt');
        const { assertReviewedTaskCurrent } = await import('./requirement-replan-commit');
        await assertReviewedTaskCurrent(prisma, replan.completionReceipt);
        const acpr = await performAutoCommitAndPR(
          taskId,
          typeof fileContent === 'string' ? fileContent : '',
        ).catch(() => ({}) as Awaited<ReturnType<typeof performAutoCommitAndPR>>);
        prRequested = acpr.requested ? acpr.requested.autoCreatePR : true;
        prSatisfied =
          !prRequested || acpr.autoPRResult?.success === true || (await taskHasLinkedPr(taskId));
        prError = acpr.autoPRResult?.error ?? acpr.error;
        noChangeCompletion =
          prRequested &&
          !prSatisfied &&
          isNoChangeCompletion({
            errorBlob: `${acpr.autoPRResult?.error ?? ''} ${acpr.autoCommitResult?.error ?? ''} ${acpr.error ?? ''}`,
            filesChanged: acpr.autoCommitResult?.filesChanged,
          });
      }

      if (noChangeCompletion) {
        await finalize('verify_no_change_confirmed');
        phaseStatus = 'completed';
        log.info(
          { taskId, prError },
          '[WorkflowCLIExecutor] verify passed with NO diff (already implemented) — completing WITHOUT a PR.',
        );
      } else if (prRequested && !prSatisfied) {
        // Verify passed but no PR was produced — do NOT complete. Keep the
        // task actionable (blocked) so "完了" always implies a PR.
        await prisma.task
          .update({
            where: { id: taskId },
            data: { status: 'blocked', updatedAt: new Date() },
          })
          .catch(() => {});
        await recordTransition({
          taskId,
          fromStatus: currentWfStatus,
          toStatus: currentWfStatus,
          actor: transition.role as TransitionActor,
          cause: 'verify_pr_not_created',
          phase: 'verify',
          sessionId: session.id,
          metadata: { reason: prError ?? 'PRが作成されませんでした' },
          invariantViolation: true,
          invariantMessage: '検証通過後にPRが作成されませんでした。PR作成成功まで完了にしません。',
        });
        phaseStatus = currentWfStatus as WorkflowAdvanceResult['status'];
        log.warn(
          { taskId, prError },
          '[WorkflowCLIExecutor] Verify passed but no PR — blocking (completion requires a PR).',
        );
        // Fail CLOSED on an unreadable automation policy: it cannot prove the
        // merge is NOT required, and a wrong completion is irreversible whereas
        // holding self-heals on the next tick.
      } else if (await isAwaitingRequiredMerge(taskId).catch(() => true)) {
        // A PR exists and autoMergePR was REQUESTED — PR creation is not the
        // completion point. Mirror the HTTP pipeline's `merge` landing mode
        // (verify-commit-pr-pipeline.ts): hold at verify_done and let the
        // AutoMergeWatcher complete the task once GitHub reports the PR merged.
        // Without this, orchestrator/queue-driven runs (auto-run, subtasks)
        // completed on PR creation alone (task 895).
        await holdForRequiredMerge({
          taskId,
          fromStatus: currentWfStatus,
          actor: transition.role as TransitionActor,
          sessionId: session.id,
          source: 'WorkflowCLIExecutor',
        });
        phaseStatus = currentWfStatus as WorkflowAdvanceResult['status'];
      } else {
        await finalize('verify_passed');
        phaseStatus = 'completed';
      }
    }
  }

  return phaseStatus;
}
