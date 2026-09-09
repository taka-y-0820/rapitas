import { writeBlockedTask } from './blocked-task-write';
/**
 * SubtaskCompletionHandler
 *
 * Monitors subtask completion and finalizes the parent task when all of its
 * subtasks are done. Generates the parent's integration verify.md and marks
 * the parent completed (or blocked, if a subtask failed).
 * Not responsible for running the subtasks themselves (see AIOrchestra).
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { realtimeService } from '../communication/realtime-service';
import { writeWorkflowFile } from './workflow-file-utils';
import { recordTransition } from './transition-recorder';
import { resolveTaskSubtaskInfo, resolveTaskWithThemeAndCategory } from '../task/task-resolver';
import { resolveAutomationPolicy, resolveLandingMode } from './automation-policy';
import { isAwaitingRequiredMerge } from './verify-settle-artifact-recovery';
import { holdForRequiredMerge } from './required-merge-hold';

const log = createLogger('subtask-completion');

/** Minimal subtask shape needed to judge completion. */
type SubtaskState = { status: string; workflowStatus: string | null };

// A subtask's progress is tracked across TWO fields (task.status and
// task.workflowStatus) that several code paths update independently, so they can
// momentarily diverge (e.g. auto-approve advances workflowStatus but not status).
// Judge completion from BOTH so a lagging field can never strand the parent.

/** A subtask is finished once verify passed OR its task reached a terminal status. */
export function isSubtaskFinished(s: SubtaskState): boolean {
  return (
    s.workflowStatus === 'completed' ||
    ['done', 'completed', 'failed', 'cancelled', 'archived'].includes(s.status)
  );
}

/** A subtask failed when its task was failed/cancelled. */
export function isSubtaskFailed(s: SubtaskState): boolean {
  return s.status === 'failed' || s.status === 'cancelled';
}

/** A subtask passed when it finished successfully (verify completed / done). */
export function isSubtaskPassed(s: SubtaskState): boolean {
  return (
    !isSubtaskFailed(s) &&
    (s.workflowStatus === 'completed' || s.status === 'done' || s.status === 'completed')
  );
}

/**
 * A parent may be finalized by its subtasks only if its own workflow actually
 * started. A plan-split parent is always dispatched first (workflowStatus
 * advances past draft before subtasks exist), so null/draft means the
 * "subtasks" are manual additions — finalizing then falsely completes a parent
 * whose research/plan/implement never ran (task 430: a lone manually-added
 * "test" subtask stamped the parent completed with a stub verify.md, and the
 * completed state blocks every later attempt to run the real workflow).
 *
 * @param parent - Parent task's workflow state. / 親タスクのワークフロー状態
 * @returns True when subtask completion may finalize the parent. / 確定可否
 */
export function isParentFinalizable(parent: { workflowStatus: string | null }): boolean {
  return parent.workflowStatus !== null && parent.workflowStatus !== 'draft';
}

/**
 * Check if all sibling subtasks are complete after one finishes.
 * If all done, generate the parent task's integration verify.md and finalize
 * the parent's status.
 *
 * NOTE: this is the single place that drives a split parent to completion, so
 * it writes verify.md to disk directly and sets the parent's terminal status
 * here instead of routing through the HTTP file-save handler (which would
 * reject verify.md unless the parent were in_progress). It then runs the auto-
 * commit/PR pipeline against the parent: in practice the agent often does the
 * whole implementation in the PARENT's worktree, and without this its changes
 * were stranded uncommitted (no other path commits a split parent).
 *
 * @param completedSubtaskId - ID of the just-completed subtask / 完了したサブタスクID
 */
export async function onSubtaskCompleted(completedSubtaskId: number): Promise<void> {
  try {
    const subtask = await resolveTaskSubtaskInfo(completedSubtaskId);

    if (!subtask?.parentId) return;

    const siblings = await prisma.task.findMany({
      where: { parentId: subtask.parentId },
      select: { id: true, title: true, status: true, workflowStatus: true },
    });

    // Finalize the parent once every subtask has reached a TERMINAL state
    // (done / failed / cancelled). Gating on "all done" alone would leave the
    // parent hanging forever if a subtask permanently failed. Completion is read
    // from BOTH status fields (see isSubtaskFinished) so a lagging field can't
    // strand the parent — the bug that previously lost a split parent's work.
    const stillRunning = siblings.filter((s) => !isSubtaskFinished(s));
    const doneCount = siblings.filter(isSubtaskPassed).length;
    const failedCount = siblings.filter(isSubtaskFailed).length;

    log.info(
      `[SubtaskCompletion] Subtask #${completedSubtaskId} done. Parent #${subtask.parentId}: ${doneCount}/${siblings.length} complete, ${stillRunning.length} still running`,
    );

    if (stillRunning.length > 0) return;

    // All subtasks complete — generate parent's integration verify.md
    const parentTask = await resolveTaskWithThemeAndCategory(subtask.parentId);

    if (!parentTask) return;

    // Idempotency guard: if the parent is already terminal, do not re-finalize
    // (sibling completions can race onto this handler concurrently). When the
    // workflow already finished (workflowStatus === 'completed') but `status`
    // hasn't caught up — e.g. syncParentStatusFromSubtasks had previously left
    // it at 'in-progress' from an ad-hoc subtask toggle — reconcile `status`
    // directly instead of re-running verify.md/auto-commit/PR.
    if (parentTask.workflowStatus === 'completed') {
      if (parentTask.status !== 'done') {
        await prisma.task.update({
          where: { id: parentTask.id },
          data: { status: 'done', completedAt: parentTask.completedAt ?? new Date() },
        });
        realtimeService.sendTaskUpdate(parentTask.id, 'task_completed', {
          taskId: parentTask.id,
          status: 'done',
          title: parentTask.title,
          priority: parentTask.priority,
          themeId: parentTask.themeId,
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }
    if (parentTask.status === 'done') {
      return;
    }

    if (!isParentFinalizable({ workflowStatus: parentTask.workflowStatus ?? null })) {
      log.info(
        `[SubtaskCompletion] Parent #${parentTask.id} workflow never started (workflowStatus=${parentTask.workflowStatus ?? 'null'}) — skipping finalization (manual subtasks, not a plan split)`,
      );
      return;
    }

    const allPassed = siblings.every(isSubtaskPassed);
    const verifyContent = buildIntegrationVerify(parentTask, siblings);

    // Write verify.md straight to the parent's workflow artifact (no HTTP round-trip).
    try {
      await writeWorkflowFile(parentTask.id, 'verify', verifyContent);
    } catch (err) {
      log.warn(
        { err, parentId: subtask.parentId },
        '[SubtaskCompletion] Failed to write integration verify.md (continuing to finalize status)',
      );
    }

    const fromWorkflowStatus = parentTask.workflowStatus ?? null;

    // When the parent must land via a MERGE, the commit/PR pipeline has to run
    // BEFORE the finalize decision: completion then depends on that PR being
    // merged, which the AutoMergeWatcher confirms. The pre-existing order
    // (finalize, then commit/PR) marked the parent done before its PR even
    // existed (task 895). Other landing modes keep the original order — their
    // completion point is verify itself, not the PR's fate.
    // Fail CLOSED to 'merge' when the policy cannot be read: the merge branch
    // holds instead of completing, which self-heals; guessing 'pr' would
    // irreversibly complete a parent whose merge may still be required.
    const landingMode = allPassed
      ? await resolveAutomationPolicy(prisma, parentTask.id)
          .then(resolveLandingMode)
          .catch(() => 'merge' as const)
      : 'none';
    if (allPassed && landingMode === 'merge') {
      await runParentAutoCommitAndPR(parentTask.id, verifyContent);
      if (await isAwaitingRequiredMerge(parentTask.id).catch(() => true)) {
        await holdForRequiredMerge({
          taskId: parentTask.id,
          fromStatus: fromWorkflowStatus,
          source: 'subtask-completion-handler',
          metadata: { subtaskCount: siblings.length, doneCount, failedCount },
        });
        // NOT task_completed: the parent is held, not complete.
        realtimeService.broadcast('tasks', 'task_updated', {
          taskId: parentTask.id,
          status: 'in-progress',
          workflowStatus: 'verify_done',
          timestamp: new Date().toISOString(),
        });
        log.info(
          `[SubtaskCompletion] Parent #${parentTask.id}: all subtasks passed and a PR is on record — awaiting the required merge before completion`,
        );
        return;
      }
    }

    // Finalize parent status. allPassed → done/completed; otherwise leave the
    // task blocked for the user to inspect the failed subtask(s).
    if (allPassed) {
      await prisma.task.update({
        where: { id: parentTask.id },
        data: { status: 'done', workflowStatus: 'completed', completedAt: new Date() },
      });
    } else {
      await writeBlockedTask(prisma, parentTask.id, { workflowStatus: 'verify_done' });
    }

    await recordTransition({
      taskId: parentTask.id,
      fromStatus: fromWorkflowStatus,
      toStatus: allPassed ? 'completed' : 'verify_done',
      actor: 'system',
      cause: allPassed ? 'all_subtasks_completed' : 'subtask_failed',
      phase: 'verify',
      metadata: {
        subtaskCount: siblings.length,
        doneCount,
        failedCount,
      },
    }).catch(() => {});

    realtimeService.broadcast('tasks', allPassed ? 'task_completed' : 'task_updated', {
      taskId: parentTask.id,
      status: allPassed ? 'done' : 'blocked',
      workflowStatus: allPassed ? 'completed' : 'verify_done',
      timestamp: new Date().toISOString(),
    });

    log.info(
      `[SubtaskCompletion] Parent task #${subtask.parentId} finalized: ${allPassed ? 'completed' : 'blocked'}`,
    );

    // Commit/PR the parent's worktree for the non-merge landing modes (merge
    // mode already ran it above). See runParentAutoCommitAndPR.
    if (allPassed && landingMode !== 'merge') {
      await runParentAutoCommitAndPR(parentTask.id, verifyContent);
    }
  } catch (error) {
    log.error(
      { err: error },
      `[SubtaskCompletion] Handler failed for subtask #${completedSubtaskId}`,
    );
  }
}

/**
 * Commit/PR the parent's worktree. A split parent's implementation usually lands
 * in ITS worktree (the agent does the work there rather than per subtask), but
 * no other path commits a split parent — so its changes were stranded
 * uncommitted and never reached the repo. Runs the same auto-commit/PR pipeline
 * the HTTP verify handler uses (it no-ops when the user hasn't enabled
 * auto-commit, and is gated by the verification check). Non-fatal by design.
 *
 * @param parentId - Parent task whose worktree is published. / 公開対象の親タスクID
 * @param verifyContent - Integration verify.md body used for the PR. / PR本文に使う統合verify.md
 */
async function runParentAutoCommitAndPR(parentId: number, verifyContent: string): Promise<void> {
  try {
    const { performAutoCommitAndPR } = await import('../../routes/workflow/workflow-auto-commit');
    await performAutoCommitAndPR(parentId, verifyContent);
  } catch (err) {
    log.warn({ err, parentId }, '[SubtaskCompletion] Parent auto-commit/PR failed (non-fatal)');
  }
}

/**
 * Build integration verify.md content from all subtask results.
 *
 * @param parentTask - The parent task being finalized. / 完了させる親タスク
 * @param subtasks - All sibling subtasks with their statuses. / 全サブタスク
 * @returns Markdown content for the parent's verify.md. / verify.md の内容
 */
function buildIntegrationVerify(
  parentTask: { id: number; title: string },
  subtasks: Array<{ id: number; title: string; status: string; workflowStatus: string | null }>,
): string {
  const lines: string[] = [];

  lines.push(`# Integration Verification: ${parentTask.title}`);
  lines.push('');
  lines.push(`## Subtask Summary`);
  lines.push('');

  let allPassed = true;

  for (const st of subtasks) {
    const passed = isSubtaskPassed(st);
    lines.push(`- ${passed ? '✅' : '❌'} #${st.id}: ${st.title}`);

    if (!passed) {
      allPassed = false;
    }
  }
  lines.push('');

  lines.push('## Integration Check');
  lines.push(`- [${allPassed ? 'x' : ' '}] All subtasks completed successfully`);
  lines.push('- [ ] No regression in existing functionality');
  lines.push('- [ ] Integration points between subtasks verified');
  lines.push('');

  lines.push('## Overall Result');
  lines.push(
    allPassed
      ? 'All subtasks completed. Ready for final review.'
      : 'Some subtasks have issues. Manual review required.',
  );

  return lines.join('\n');
}
