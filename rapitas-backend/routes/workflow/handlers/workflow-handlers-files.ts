/**
 * Workflow File Handlers
 *
 * Route handlers for reading and writing workflow files (research, question, plan, verify).
 * handleSaveFile orchestrates the file-save pipeline stages under ./file-save/
 * (guards → content prep → status transition → critic gate → plan post-processing
 * → verify post-save automation: completion gate → adversarial review →
 * commit/PR completion) and assembles the HTTP response.
 * Not responsible for route registration, status updates, or the stage logic itself.
 */

import { prisma } from '../../../config';
import { NotFoundError, ValidationError, parseId } from '../../../middleware/error-handler';
import { createLogger } from '../../../config/logger';
import { VALID_FILE_TYPES, resolveWorkflowDir, getFileInfo } from '../core/workflow-helpers';
import { withTaskLifecycleLock } from '../../../services/workflow/task-lifecycle-lock';
import {
  validateFileType,
  resolveTargetTask,
  guardStatusTransition,
  guardParentSubtasksTerminal,
  prepareAndPersistContent,
  computeAndApplyStatusTransition,
  runPhaseCriticGate,
  runPlanPostProcessing,
  runVerifyPostSaveAutomation,
} from './file-save';

const log = createLogger('routes:workflow:handlers:files');

/**
 * Handler for GET /tasks/:taskId/files
 * Returns all workflow files and their metadata for a task.
 *
 * @param params - Route params containing taskId / ルートパラメータ
 * @param set - Elysia response set object / Elysiaレスポンス
 * @returns Workflow file list with status and path info
 * @throws {NotFoundError} When task does not exist
 * @throws {ValidationError} When taskId is invalid
 */
export async function handleGetFiles({
  params,
  set: _set,
}: {
  params: { taskId: string };
  set: { status: number };
}) {
  try {
    const taskId = parseId(params.taskId, 'task ID');

    const resolved = await resolveWorkflowDir(taskId);
    if (!resolved) {
      throw new NotFoundError('Task not found');
    }

    const { task, categoryId, themeId } = resolved;

    // Parallel retrieval of 4 file information
    const [research, question, plan, verify] = await Promise.all(
      VALID_FILE_TYPES.map((type) => getFileInfo(taskId, type)),
    );

    return {
      research,
      question,
      plan,
      verify,
      workflowStatus: task.workflowStatus || null,
      path: { taskId, categoryId, themeId },
    };
  } catch (err) {
    if (err instanceof ValidationError || err instanceof NotFoundError) throw err;
    log.error({ err: err }, 'Error fetching workflow files');
    throw err;
  }
}

/**
 * Handler for PUT /tasks/:taskId/files/:fileType
 * Saves a workflow file and auto-transitions workflow status.
 *
 * @param params - Route params with taskId and fileType / ルートパラメータ
 * @param body - Request body containing content and optional language / リクエストボディ
 * @param set - Elysia response set / Elysiaレスポンス
 * @returns Save result with updated workflow status and optional commit/PR info
 * @throws {ValidationError} When fileType or content is invalid
 * @throws {NotFoundError} When task does not exist
 */
export async function handleSaveFile({
  params,
  body,
  set,
}: {
  params: { taskId: string; fileType: string };
  body: unknown;
  set: { status: number };
}) {
  try {
    const taskId = parseId(params.taskId, 'task ID');

    const fileType = validateFileType(params.fileType);

    const resolved = await resolveTargetTask(taskId);

    // NOTE: guardStatusTransition may fast-forward draft → research_done and
    // mutates resolved.task.workflowStatus in place — currentStatus below must
    // be read AFTER this call so it sees the fast-forwarded value.
    const guardResult = await guardStatusTransition(taskId, fileType, resolved);
    if (!guardResult.ok) {
      set.status = guardResult.httpStatus;
      return guardResult.body;
    }
    const currentStatusForGuard = guardResult.status;

    await guardParentSubtasksTerminal(taskId, fileType, currentStatusForGuard);

    const prep = await prepareAndPersistContent({
      taskId,
      fileType,
      body,
      currentStatusForGuard,
    });
    if (!prep.ok) {
      set.status = prep.status;
      return prep.body;
    }
    const { content, fileLanguage, savedContent } = prep;

    const currentStatus = resolved.task.workflowStatus;

    // Question saves (awaiting_question writes) are serialized on the same
    // taskId lock the scheduler's advanceActiveTask uses for its
    // resolveTaskWorkflowState read, so a scheduler tick can never observe a
    // stale workflowStatus mid-write and fall into the queue-loss re-enqueue
    // branch (task #901). research/plan/verify never write awaiting_question
    // and are excluded — verify in particular can run
    // runVerifyPostSaveAutomation for minutes, which must not block the
    // scheduler's same-task lock.
    const transition =
      fileType === 'question'
        ? await withTaskLifecycleLock(taskId, () =>
            computeAndApplyStatusTransition({ taskId, fileType, currentStatus, savedContent }),
          )
        : await computeAndApplyStatusTransition({ taskId, fileType, currentStatus, savedContent });
    let newStatus = transition.newStatus;

    const critic = await runPhaseCriticGate({
      taskId,
      fileType,
      newStatus,
      savedContent,
      workflowMode: resolved.task.workflowMode,
    });
    newStatus = critic.newStatus;
    const criticRejection = critic.criticRejection;

    const planPost = await runPlanPostProcessing({
      taskId,
      fileType,
      newStatus,
      content,
      fileLanguage,
    });
    newStatus = planPost.newStatus;
    const { autoApproved, splitResult } = planPost;

    // Completion gate → adversarial jury → commit/PR/merge, registered as ONE
    // in-flight unit before any of it runs (task 660: registering only the
    // commit/PR stage left the gate + jury unregistered and the runner blocked
    // task 658 mid-jury, 3.5 minutes before its PR landed).
    const commitPr = await runVerifyPostSaveAutomation({
      completionReceipt: transition.completionReceipt,
      taskId,
      fileType,
      newStatus,
      savedContent,
    });
    newStatus = commitPr.newStatus;
    const { taskMarkedDone, autoCommitPRResult } = commitPr;

    // Telemetry: a verify save that left the task BLOCKED by any gate (NOT a
    // self-repair bounce — those leave it in-progress for a re-run) is recorded
    // as a blocked outcome, so the per-theme difficulty signal reflects failures
    // as well as successes.
    if (fileType === 'verify' && !taskMarkedDone) {
      const cur = await prisma.task
        .findUnique({ where: { id: taskId }, select: { status: true } })
        .catch(() => null);
      if (cur?.status === 'blocked') {
        import('../../../services/workflow/outcome-telemetry')
          .then(({ recordTaskOutcome }) => recordTaskOutcome(taskId, 'blocked'))
          .catch(() => {});
      }
    }

    // Build response
    const response: Record<string, unknown> = {
      success: true,
      fileType,
      workflowStatus: newStatus || currentStatus,
      autoApproved,
    };

    if (splitResult) {
      response.subtaskSplit = splitResult;
    }

    if (criticRejection) {
      // Deliberately verbose and unambiguous: the saving agent reads this
      // response directly, and its own narration of it is what the user sees
      // in the execution log. A terse flag risks being paraphrased away as
      // "saved successfully" — spell out that this is expected self-repair
      // behavior, not a failure or a bug, so the agent reports it as such.
      response.criticGateRejected = true;
      response.message =
        `${criticRejection.phase}.md の内容は保存されましたが、自動品質レビュー（批評ゲート）が不合格と判定したためアーカイブされ、` +
        `workflowStatus は ${criticRejection.rolledBackTo} に巻き戻されました。これはバグではなく、内容を改善して再生成するための想定内の自己修復動作です。` +
        `再開後は次の指摘事項に対応した内容で ${criticRejection.phase}.md を再保存してください。`;
      response.criticReasons = criticRejection.reasons;
      if (criticRejection.severity !== undefined)
        response.criticSeverity = criticRejection.severity;
      log.info(
        {
          taskId,
          phase: criticRejection.phase,
          rolledBackTo: criticRejection.rolledBackTo,
          severity: criticRejection.severity,
          reasons: criticRejection.reasons,
        },
        '[Workflow] Save response includes critic-gate rejection details for the saving agent',
      );
    }

    if (fileType === 'verify' && newStatus === 'verify_done') {
      // Reflect actual DB state — taskMarkedDone gates on
      // commit/PR/merge success above.
      response.taskCompleted = taskMarkedDone;
      response.taskStatus = taskMarkedDone ? 'done' : 'in-progress';
      response.workflowStatus = taskMarkedDone ? 'completed' : 'verify_done';
      if (taskMarkedDone) response.completedAt = new Date().toISOString();

      if (autoCommitPRResult.autoCommitResult)
        response.autoCommit = autoCommitPRResult.autoCommitResult;
      if (autoCommitPRResult.autoPRResult) response.autoPR = autoCommitPRResult.autoPRResult;
      if (autoCommitPRResult.autoMergeResult)
        response.autoMerge = autoCommitPRResult.autoMergeResult;
      if (autoCommitPRResult.worktreeCleanupResult)
        response.worktreeCleanup = autoCommitPRResult.worktreeCleanupResult;
    }

    return response;
  } catch (err) {
    if (err instanceof ValidationError || err instanceof NotFoundError) throw err;
    log.error({ err: err }, 'Error saving workflow file');
    throw err;
  }
}

// NOTE: `_handlePlanAutoApprove` lived here previously. The same logic now
// lives in `services/workflow/plan-auto-approve.ts` so the orchestrator
// path (workflow-cli-executor) and this HTTP handler share a single
// source of truth — preventing drift like the recent "auto-approve does
// not fire when planner saves via writeWorkflowFile" regression.
