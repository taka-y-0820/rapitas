/**
 * Workflow Handlers / Resume Redispatch
 *
 * Best-effort auto-continuation helpers called after a workflow question is
 * resolved: re-triggering execution for an intake pause (no live process to
 * resume) and nudging the theme scheduler to reclaim an implementation-phase
 * task. Split out of workflow-handlers-resume.ts (task 830) to stay under the
 * file-size ratchet. Neither helper ever throws — a failed nudge must not
 * fail the caller's own response.
 */

import { createLogger } from '../../../config';
import { resolveTaskThemeId } from '../../../services/task/task-resolver';
import { WorkflowQueueService } from '../../../services/workflow/workflow-queue';
import {
  getAutoRunState,
  setCurrentTask,
} from '../../../services/workflow/auto-run/theme-auto-run-service';

const log = createLogger('routes:workflow:resume');

/**
 * Best-effort auto re-trigger after an intake question is answered.
 *
 * This pause never had a live agent process to resume (see
 * handleAnswerWorkflowQuestion's doc comment) — without this, a manually
 * executed task (auto-run disabled for its theme) just sat at
 * workflowStatus='draft' forever, needing the user to notice and click
 * "実行" again themselves. That silently contradicted the frontend's own
 * phase-completion message, which always claims "次のフェーズへ自動で進みます"
 * for the researcher phase regardless of whether it ended in a question.
 *
 * Uses workflow role selection and existing artifact reuse for manual resumes.
 * Active AutoRun themes use the scheduler queue and refresh the claim only
 * after enqueue succeeds. Other themes advance the workflow directly. Errors remain
 * best-effort and never undo the already persisted answer.
 *
 * @param taskId - Task whose question was just answered. / 回答されたタスクID
 */
export async function triggerReExecutionAfterAnswer(taskId: number): Promise<void> {
  try {
    const theme = await resolveTaskThemeId(taskId);
    const state = theme?.themeId ? await getAutoRunState(theme.themeId) : null;
    if (state?.enabled && state.status === 'running') {
      // The manual execute route rejects AUTO_RUN_ACTIVE. Queue through the
      // scheduler instead; a successful claim also rebases lastRunAt so the
      // question's waiting time cannot trip the resumed run's hard ceiling.
      await triggerRedispatchAfterResume(taskId);
      return;
    }

    // An answered workflow question must retain role selection and artifact
    // reuse. The generic execute route replays the task description instead.
    const { WorkflowOrchestrator } =
      await import('../../../services/workflow/workflow-orchestrator');
    void WorkflowOrchestrator.getInstance()
      .advanceWorkflow(taskId)
      .then((result) => {
        if (!result.success)
          log.warn({ taskId, result }, '[Workflow:Answer] Workflow resume failed');
      })
      .catch((err) => {
        log.warn({ taskId, err }, '[Workflow:Answer] Workflow resume failed');
      });
    log.info({ taskId }, '[Workflow:Answer] Workflow resume started after question answer');
  } catch (err) {
    log.warn({ err, taskId }, '[Workflow:Answer] Auto re-run trigger failed (non-fatal)');
  }
}

/**
 * Best-effort re-dispatch nudge after an implementation-phase question is
 * resolved (task 830).
 *
 * `applyResumeFromQuestionAnswer` only flips DB columns (workflowStatus, and
 * — via its own #804 backstop — task.status when it was 'todo'). Neither
 * actually makes the theme scheduler pick the task back up:
 * `ThemeAutoRun.currentTaskId` is left untouched, so if it was cleared (e.g.
 * a theme stop mid-question via `stopThemeExecutionImpl`/`finalizeStop`, then
 * re-armed by the idle-timer's manual-task-rearm path) the task sits as a
 * normal backlog item with no `WorkflowQueueItem` and no scheduler claim on
 * it — reproducing exactly the `status='todo'` × advanced `workflowStatus`
 * shape task 830 investigated, for however long it takes the theme to happen
 * to reselect it (or never, if another task keeps winning selection).
 *
 * Only acts when it is PROVABLY SAFE — the theme is enabled+running AND
 * either has no current task or is already tracking this exact task. It
 * NEVER reassigns a theme that is mid-flight on a DIFFERENT task: doing so
 * would let two agents run concurrently for the same theme (the "multiple
 * agents launched before others finished" class of bug guarded against
 * elsewhere in the auto-run scheduler). When the theme is genuinely busy
 * elsewhere, this task legitimately waits its turn — normal selection picks
 * it up once the current task frees the theme.
 *
 * `setCurrentTask` is only called AFTER `enqueue` has actually succeeded —
 * claiming the theme's `currentTaskId` for a task with no matching
 * `WorkflowQueueItem` would recreate the exact desync this nudge exists to
 * close, just with an extra, misleading "claimed" signal on top.
 *
 * Never throws — errors are logged and swallowed so a failed nudge cannot
 * fail the caller's own response; the task's own state was already durably
 * updated by the caller before this runs.
 *
 * @param taskId - Task that was just resumed. / 再開したタスクID
 */
export async function triggerRedispatchAfterResume(taskId: number): Promise<void> {
  try {
    const themeRef = await resolveTaskThemeId(taskId);
    const themeId = themeRef?.themeId;
    if (!themeId) return;

    const state = await getAutoRunState(themeId);
    if (!state || !state.enabled || state.status !== 'running') return;
    if (state.currentTaskId !== null && state.currentTaskId !== taskId) {
      // Theme is mid-flight on a different task — leave it to normal
      // backlog selection once that task completes.
      return;
    }

    try {
      await WorkflowQueueService.getInstance().enqueue({ taskId, themeId, priority: 50 });
    } catch (err) {
      log.warn(
        { err, taskId, themeId },
        '[Workflow:Resume] Redispatch enqueue failed — leaving ThemeAutoRun.currentTaskId untouched',
      );
      return;
    }

    await setCurrentTask(themeId, taskId);
    log.info({ taskId, themeId }, '[Workflow:Resume] Redispatch nudge applied after resume');
  } catch (err) {
    log.warn({ err, taskId }, '[Workflow:Resume] Redispatch nudge failed (non-fatal)');
  }
}
