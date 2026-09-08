/**
 * FileSave Status Transition
 *
 * Computes the auto workflow-status transition for a saved file (research /
 * plan / question / verify, including the verify validator + self-repair
 * bounce) and persists it with transition recording + invariant checks.
 * Not responsible for critic gates or commit/PR completion.
 */

import { prisma } from '../../../../config';
import { createLogger } from '../../../../config/logger';
import { hasNonpassingVerifyVerdict } from '../../../../services/workflow/nonpassing-verify-verdict';
import type { WorkflowFileType } from '../../core/workflow-helpers';
import { researchConcludesNoChange } from '../../../../services/workflow/completion-gate';
import { recordTransition } from '../../../../services/workflow/transition-recorder';
import { checkWorkflowInvariants } from '../../../../services/workflow/workflow-invariants';
import { attemptInvariantCutoff } from '../../../../services/workflow/verify-invariant-repair';
import { markLatestExecutionFailed, wasNonConvergenceCutoffJustRecorded } from './shared';

const log = createLogger('routes:workflow:handlers:files');

/**
 * Result of the status-transition stage. `newStatus` stays undefined when no
 * auto-transition applies (the caller then skips the downstream verify gates).
 */
export interface StatusTransitionOutcome {
  newStatus?: string;
  researchCompleted: boolean;
  verifyRerunAlreadyDone: boolean;
  verifyRepairBounced: boolean;
}

/**
 * Computes and persists the auto status transition for a saved workflow file.
 *
 * @param params - taskId / fileType / pre-save status / persisted content / 入力一式
 * @returns The transition outcome flags the downstream stages depend on
 */
export async function computeAndApplyStatusTransition(params: {
  taskId: number;
  fileType: WorkflowFileType;
  currentStatus: string | null | undefined;
  savedContent: string;
}): Promise<StatusTransitionOutcome> {
  const { taskId, fileType, currentStatus, savedContent } = params;

  // Auto-update workflowStatus
  let newStatus: string | undefined;

  log.info(`[Workflow] Processing fileType: ${fileType}, currentStatus: ${currentStatus}`);

  // Research concluded the requirement is ALREADY satisfied (explicit
  // "修正不要" verdict). Complete the task directly from research — no plan.md,
  // no implementation, no verify — so already-done work doesn't get a
  // duplicate PR. Only valid while still in the research phase.
  // NOTE: hypothesis/decision ledger seeding moved INTO writeWorkflowFile (the
  // universal save choke point) so the auto-run path — which writes via
  // writeWorkflowFile directly, bypassing this API route — also fires it.
  // writeWorkflowFile was already called above to persist savedContent.
  let researchCompleted = false;
  // True when a verify RE-RUN (ci_repair / verify_repair) reported a failure on
  // work that was ALREADY validated + PR'd — a false negative we complete instead
  // of looping. Marks the task done like researchCompleted does.
  let verifyRerunAlreadyDone = false;
  // True when attemptVerifyRepair() already bounced the workflow (and recorded
  // its OWN `verify_repair`-caused transition + task.update). Without this
  // flag the generic `if (newStatus)` block below unconditionally re-runs
  // BOTH the task.update and a SECOND `file_saved:verify` transition for the
  // same save — recorded milliseconds after the real `verify_repair` one.
  // That redundant transition becomes the newest row, so
  // verify-self-repair.hasFreshVerifyRejection() (which only looks at the
  // single most recent transition) no longer sees the bounce as fresh. The
  // CLI executor's completion epilogue then fails to skip, re-validates the
  // same verify.md on its own stale copy, hard-blocks the task, and a
  // downstream watchdog resets it all the way to `draft` — silently
  // discarding the research/plan/implementation work already done (observed
  // live on task 415: verify_repair bounce → redundant file_saved:verify →
  // epilogue hard-block → blocked_auto_retry → reset to draft).
  let verifyRepairBounced = false;
  if (
    fileType === 'research' &&
    (!currentStatus || currentStatus === 'draft' || currentStatus === 'research_done') &&
    researchConcludesNoChange(savedContent)
  ) {
    log.info(`[Workflow] Research concluded no change needed — completing task ${taskId}`);
    newStatus = 'completed';
    researchCompleted = true;
  } else if (fileType === 'research' && (!currentStatus || currentStatus === 'draft')) {
    log.info(`[Workflow] Research completed: setting newStatus to research_done`);
    newStatus = 'research_done';
  } else if (fileType === 'plan' && (!currentStatus || currentStatus === 'research_done')) {
    newStatus = 'plan_created';
  } else if (
    fileType === 'question' &&
    currentStatus &&
    currentStatus !== 'awaiting_question' &&
    currentStatus !== 'completed' &&
    currentStatus !== 'verify_done'
  ) {
    // 質問.md が保存されたらユーザー回答待ち状態に遷移する。
    // 復帰先 status は transition log の metadata.previousStatus に保存しておき、
    // 回答後に呼ばれる resume API（routes/workflow/handlers/workflow-handlers-resume.ts）が
    // この値を読み出して元状態に戻す。
    log.info(`[Workflow] Question saved: transitioning ${currentStatus} → awaiting_question`);
    newStatus = 'awaiting_question';
  } else if (fileType === 'verify') {
    // Run the verify validator (catches "claims all-pass but body says
    // failed" hallucinations + explicit ❌ markers). When validation
    // signals a real failure we hold the task at `in_progress` and
    // mark task.status='blocked' so the user notices, instead of
    // silently advancing to verify_done and auto-PR.
    try {
      const { validateVerify } =
        await import('../../../../services/workflow/phase-output-validator');
      const verifyValidation = validateVerify(savedContent);
      if (!verifyValidation.ok && verifyValidation.severity >= 80) {
        // FALSE-NEGATIVE GUARD: a re-run (ci_repair / verify_repair) executes in
        // a worktree where the work is ALREADY present (committed to the PR branch
        // or merged to base), so the implementer makes NO change and the verifier
        // — seeing an empty diff against a plan that lists "new" files — wrongly
        // reports 実装漏れ ("the artifacts don't exist at all"). If this task has
        // ALREADY reached verify_passed once AND produced a PR, the implementation
        // demonstrably exists, so the failure is a false negative. Complete it
        // instead of looping implement→verify→block forever (observed: task 367,
        // verify_passed→ci_repair→empty-diff re-run→"実装漏れ"→blocked, PR merged).
        const priorVerifyPass = await prisma.workflowTransition
          .findFirst({ where: { taskId, cause: 'verify_passed' }, select: { id: true } })
          .catch(() => null);
        const prRow = priorVerifyPass
          ? await prisma.task
              .findUnique({ where: { id: taskId }, select: { githubPrId: true } })
              .catch(() => null)
          : null;
        // NOTE: severity===80 is emitted EXCLUSIVELY by validateVerify's
        // self-contradiction branch (claimsAllPass && failureHits.length>0,
        // phase-output-validator.ts:344-357) — pollutedResult/empty uses 100,
        // canonical-partial/explicit-❌-mark uses 90, and the missing-sections
        // percentage (missingSections/3*100) can only land on 0/33/67/100 for
        // VERIFY_REQUIRED_SECTIONS' 3 entries, never 80. This exact-match is
        // guarded by phase-output-validator.test.ts's many severity===80
        // assertions on self-contradiction cases — if that coupling ever
        // breaks, those tests go RED first (task 906: a prior pass + PR must
        // not launder a CURRENT self-contradicting report into `completed`).
        if (
          priorVerifyPass &&
          prRow?.githubPrId != null &&
          !hasNonpassingVerifyVerdict(savedContent) &&
          verifyValidation.severity !== 80
        ) {
          log.warn(
            { taskId, prId: prRow.githubPrId, summary: verifyValidation.summary },
            '[Workflow] verify re-run reported a failure, but the task already passed verify and has a PR — completing as already-done (false-negative on already-merged work).',
          );
          newStatus = 'completed';
          verifyRerunAlreadyDone = true;
        } else {
          // Self-repair loop: bounce the workflow back to the implementer with
          // the failure as feedback so the runner re-runs implement → verify,
          // instead of dead-ending at `blocked`. Only block once the bounded
          // repair attempts are exhausted.
          const { attemptVerifyRepair } =
            await import('../../../../services/workflow/verify-self-repair');
          const repair = await attemptVerifyRepair(
            taskId,
            currentStatus ?? null,
            verifyValidation.summary,
            savedContent,
          );

          if (repair.bounced && repair.newStatus) {
            log.warn(
              { taskId, attempt: repair.attempt, newStatus: repair.newStatus },
              '[Workflow] verify.md failed validation — re-running implement→verify (self-repair)',
            );
            // Bounce: the runner re-runs the implementer from this status.
            // attemptVerifyRepair() already persisted task.status/workflowStatus
            // and recorded its own `verify_repair` transition — newStatus is set
            // only so the HTTP response reports the real status; the generic
            // save-transition block below must NOT repeat that work.
            newStatus = repair.newStatus;
            verifyRepairBounced = true;
          } else if (repair.stale) {
            // The workflow advanced past the evaluated status while this
            // verdict was in flight (e.g. a re-verify already passed) —
            // blocking now would clobber a live/terminal state (task 551).
            log.warn(
              { taskId, summary: verifyValidation.summary },
              '[Workflow] stale verify failure — workflow moved on; neither bouncing nor blocking',
            );
            verifyRepairBounced = true; // skip the generic save-transition below too
          } else {
            log.warn(
              { taskId, summary: verifyValidation.summary },
              '[Workflow] verify.md failed validation and repairs exhausted — blocking task',
            );
            await prisma.task
              .update({
                where: { id: taskId },
                data: { status: 'blocked', updatedAt: new Date() },
              })
              .catch(() => {});
            // Align the execution/session to failed so the log viewer doesn't show
            // 「完了」 while the task is blocked (the status gap).
            await markLatestExecutionFailed(
              taskId,
              `検証に失敗したためブロックしました: ${verifyValidation.summary}`,
            );
            // The non-convergence cutoff already recorded its OWN
            // `verify_repair_non_convergence` transition for this rejection
            // (verify-self-repair.ts) — recording `verify_validation_failed`
            // here too would duplicate it (task 674: two rows 43ms apart;
            // task 705 independently hit the same duplicate-record defect and
            // converged on this same DB-read check during merge; task 715
            // recurred even with that DB-read guard, so `repair.cutoffRecorded`
            // — the in-band signal from THIS exact attemptVerifyRepair() call,
            // task 710 — is checked first as the authoritative source).
            if (!repair.cutoffRecorded && !(await wasNonConvergenceCutoffJustRecorded(taskId))) {
              await recordTransition({
                taskId,
                fromStatus: currentStatus ?? null,
                toStatus: currentStatus ?? 'in_progress',
                actor: 'verifier',
                cause: 'verify_validation_failed',
                phase: 'verify',
                metadata: {
                  sizeBytes: savedContent.length,
                  reason: verifyValidation.summary,
                },
                invariantViolation: true,
                invariantMessage: verifyValidation.summary,
              });
            }
            // newStatus stays undefined — caller skips the verify_done
            // transition + auto-commit/PR pipeline below.
          }
        }
      } else {
        log.info(`[Workflow] Verification saved: setting newStatus to verify_done`);
        newStatus = 'verify_done';
      }
    } catch (err) {
      // Validator failure must not block legitimate verify saves.
      log.warn({ err, taskId }, '[Workflow] verify validator threw, allowing save anyway');
      newStatus = 'verify_done';
    }
  }

  if (newStatus && !verifyRepairBounced) {
    await prisma.task.update({
      where: { id: taskId },
      // Research-no-change completion (and the verify re-run already-done
      // false-negative guard) also mark the task itself done.
      data:
        researchCompleted || verifyRerunAlreadyDone
          ? {
              workflowStatus: newStatus,
              status: 'done',
              completedAt: new Date(),
              updatedAt: new Date(),
            }
          : { workflowStatus: newStatus, updatedAt: new Date() },
    });
    // Record the transition + immediately verify invariants. We log
    // violations but DO NOT throw — the file was already saved on disk
    // and rolling back would create a worse "ghost" state.
    const violations = await checkWorkflowInvariants(taskId);
    // Invariant non-convergence (task 755): a violation code that keeps
    // recurring across newStatus-confirm cycles used to be logged forever
    // with no corrective action (task #572: the same missing_file:...plan.md
    // violation recorded twice, 2h43m apart). Checked BEFORE the transition
    // below so the recurrence window does not see this save's own row yet.
    // No windowStart boundary (unlike verify-self-repair's repair-budget
    // reset) — this HTTP-handler path has no "manual retry" reset concept,
    // so the full task history is compared.
    let invariantCutoffRecorded = false;
    if (violations.length > 0) {
      invariantCutoffRecorded = await attemptInvariantCutoff(
        taskId,
        currentStatus ?? null,
        violations.map((v) => `${v.code}:${v.message}`).join(' | '),
        null,
      ).catch((err) => {
        log.warn({ err, taskId }, '[Workflow] attemptInvariantCutoff threw — failing open');
        return false;
      });
      if (invariantCutoffRecorded) {
        await prisma.task
          .update({ where: { id: taskId }, data: { status: 'blocked', updatedAt: new Date() } })
          .catch(() => {});
        await markLatestExecutionFailed(
          taskId,
          `不変条件違反が複数サイクルで再発したためブロックしました: ${violations.map((v) => v.code).join(', ')}`,
        );
      }
    }
    // awaiting_question への遷移時のみ、復帰先 status を metadata に保存する
    const transitionMetadata: Record<string, unknown> = {
      sizeBytes: savedContent.length,
    };
    if (newStatus === 'awaiting_question' && currentStatus) {
      transitionMetadata.previousStatus = currentStatus;
    }
    // Skip the generic transition when the cutoff above already recorded its
    // OWN terminal transition for this save — recording both would duplicate
    // the same event (the same double-record shape verify-self-repair.ts
    // already guards against via repair.cutoffRecorded).
    if (!invariantCutoffRecorded) {
      await recordTransition({
        taskId,
        fromStatus: currentStatus ?? null,
        toStatus: newStatus,
        actor: 'system',
        cause: researchCompleted
          ? 'research_no_change_complete'
          : verifyRerunAlreadyDone
            ? 'verify_rerun_already_done'
            : `file_saved:${fileType}`,
        phase: fileType,
        metadata: transitionMetadata,
        invariantViolation: violations.length > 0,
        invariantMessage:
          violations.length > 0
            ? violations.map((v) => `${v.code}:${v.message}`).join(' | ')
            : undefined,
      });
    }
    if (violations.length > 0) {
      const missingFiles = violations
        .filter((v) => v.code === 'missing_file')
        .map((v) => {
          const m = v.message.match(/but (\S+\.md) is missing/);
          return m ? m[1] : 'unknown';
        });
      log.warn(
        {
          taskId,
          violations,
          missingFiles,
          hint:
            missingFiles.length > 0
              ? `save the missing file(s) via PUT /workflow/tasks/${taskId}/files/<type>, or reset status to draft`
              : 'check task.status consistency or open subtasks',
        },
        '[Workflow] Invariant violations detected after status update',
      );
      // Task 766: attempt code-specific self-repair AFTER the transition above
      // is fully recorded (never before — that would risk the double-record
      // shape task 674/705/710 already hit) and only when the non-convergence
      // cutoff did NOT already escalate this save to blocked.
      const missingFileViolation = violations.find((v) => v.code === 'missing_file');
      if (missingFileViolation && !invariantCutoffRecorded) {
        const { repairMissingFile } =
          await import('../../../../services/workflow/invariant-repair');
        const repair = await repairMissingFile(taskId, missingFileViolation).catch((err) => {
          log.warn({ err, taskId }, '[Workflow] repairMissingFile threw — failing open');
          return { repaired: false as const };
        });
        if (repair.repaired) {
          log.info(
            { taskId, newStatus: repair.newStatus },
            '[Workflow] missing_file violation self-repaired (workflowStatus rolled back)',
          );
        }
      }
    }
  }

  return { newStatus, researchCompleted, verifyRerunAlreadyDone, verifyRepairBounced };
}
