/**
 * Workflow Handlers / Resume Continuation
 *
 * Resumes an `awaiting_question` task back to the status it was in before the
 * question was raised, WITHOUT resetting to `draft` or archiving plan.md —
 * the execution_continuation/completion_confirmation counterpart to
 * workflow-handlers-resume.ts's spec_change (draft-reset) path. Split out
 * (task 902) to stay under the file-size ratchet. Not responsible for
 * deciding WHICH kind applies — workflow-handlers-resume-dispatch.ts does
 * that and calls into this module.
 */
import { prisma } from '../../../config';
import { recordTransition } from '../../../services/workflow/transition-recorder';
import type { TransitionActor } from '../../../services/workflow/transition-recorder';
import { ValidationError, NotFoundError, ConflictError } from '../../../middleware/error-handler';
import { createLogger } from '../../../config';
import type { WorkflowStatus } from '../../../services/workflow/workflow-types';
import { resolveTaskWorkflowState } from '../../../services/task/task-resolver';
import {
  readWorkflowFile,
  writeWorkflowFile,
} from '../../../services/workflow/workflow-file-utils';
import { triggerRedispatchAfterResume } from './workflow-handlers-resume-redispatch';
import {
  readQuestionMetadata,
  type QuestionKind,
} from '../../../services/workflow/question-kind-resolver';
import { applyQuestionAnswerByKind } from './workflow-handlers-resume-dispatch';

const log = createLogger('routes:workflow:resume');

interface ResumeContext {
  params: { taskId: string };
  body?: unknown;
  set: { status?: number };
}

/** Input to {@link applyResumeFromQuestionAnswer}. */
export interface ApplyResumeAnswerParams {
  taskId: number;
  /** Who is recorded as having resolved the pause (HTTP callers always pass 'user'). / 記録するactor */
  actor: TransitionActor;
  /**
   * Answer text to append to question.md as an audit trail, WITHOUT
   * archiving (unlike the intake path — plan保持のまま resumeStatus へ復帰する
   * execution_continuation/completion_confirmation kind向け). Omitted/empty
   * leaves question.md untouched — existing callers (auto-answer heal pass's
   * `file_saved:question` branch) that never passed an answer keep their
   * current behavior unchanged. / question.mdへ追記する回答本文
   */
  answer?: string;
  /**
   * Recorded in the transition's metadata only — no additional gate logic is
   * invoked. A `completion_confirmation` answer resumes to `previousStatus`
   * (typically `verify_done`) and relies on the existing periodic
   * reconcilers (e.g. workflow-runner-verify-settle.ts) to settle
   * commit/PR/merge completion; this flag is purely an audit marker
   * distinguishing that resume from a plain execution_continuation one. /
   * 完了確認由来の復帰であることの監査記録のみ（追加の副作用は起こさない）
   */
  recheckCompletionGate?: boolean;
  /** Extra fields merged into the recorded transition's metadata. / 追加メタデータ */
  extraMetadata?: Record<string, unknown>;
}

/**
 * Core logic to resume an `awaiting_question` task back to the status it was
 * in before the question was raised.
 *
 * 復帰先 status は `WorkflowTransition` の最新 `to_status='awaiting_question'`
 * 行の `metadata.previousStatus` から取得する。metadata に値が無い古い遷移は
 * `in_progress` を fallback に使う。question.md は archive しない — 実装フェーズ発
 * の質問は plan.md が生きたままの状態で再開する必要があるため。
 *
 * Transport-agnostic on purpose: {@link handleResumeFromQuestion} (HTTP,
 * `actor:'user'`) and the stale-question auto-answer heal pass (in-process,
 * `actor:'system'`) both call this directly.
 *
 * @param params - Resume request. / 再開リクエスト
 * @returns 新しい workflowStatus と復帰先の根拠 / 復帰した状態オブジェクト
 * @throws {ValidationError} status が awaiting_question でない場合
 * @throws {NotFoundError} タスクが見つからない場合
 */
export async function applyResumeFromQuestionAnswerLocked(
  params: ApplyResumeAnswerParams,
): Promise<{
  taskId: number;
  fromStatus: WorkflowStatus;
  toStatus: WorkflowStatus;
  source: 'transition_metadata' | 'fallback';
}> {
  const { taskId, actor, answer, recheckCompletionGate, extraMetadata } = params;

  const task = await resolveTaskWorkflowState(taskId);
  if (!task) {
    throw new NotFoundError('Task not found');
  }

  if (task.workflowStatus !== 'awaiting_question') {
    throw new ValidationError(
      `Cannot resume: task ${taskId} is in status "${task.workflowStatus}", expected "awaiting_question"`,
    );
  }

  // 直近の awaiting_question 遷移ログから previousStatus を読み出す
  const lastWaitingTransition = await prisma.workflowTransition.findFirst({
    where: { taskId, toStatus: 'awaiting_question' },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true, fromStatus: true },
  });

  let resumeStatus: WorkflowStatus = 'in_progress';
  let source: 'transition_metadata' | 'fallback' = 'fallback';
  if (lastWaitingTransition) {
    const meta = readQuestionMetadata(lastWaitingTransition.metadata);
    const prev = meta?.previousStatus;
    if (typeof prev === 'string' && prev !== 'awaiting_question') {
      resumeStatus = prev as WorkflowStatus;
      source = 'transition_metadata';
    } else if (
      lastWaitingTransition.fromStatus &&
      lastWaitingTransition.fromStatus !== 'awaiting_question'
    ) {
      // metadata 欠落でも fromStatus が残っていれば優先する
      resumeStatus = lastWaitingTransition.fromStatus as WorkflowStatus;
      source = 'transition_metadata';
    }
  }

  log.info(
    `[Workflow:Resume] Task ${taskId}: awaiting_question → ${resumeStatus} (source=${source}, actor=${actor})`,
  );

  // Append-only audit trail — mirrors applyIntakeQuestionAnswerLocked's
  // question.md append, but NEVER archives: execution_continuation /
  // completion_confirmation answers are not a spec change, so plan.md (and
  // question.md itself) must survive the resume intact. Uses the internal
  // writeWorkflowFile choke point directly (not the public PUT route) —
  // going through the route would re-trigger the awaiting_question
  // transition and loop.
  if (answer) {
    const questionContent = await readWorkflowFile(taskId, 'question');
    if (questionContent != null) {
      const answerBlock = `\n\n## 回答\n${answer}`;
      await writeWorkflowFile(taskId, 'question', `${questionContent}${answerBlock}`).catch(
        () => {},
      );
    }
  }

  await prisma.task.update({
    where: { id: taskId },
    data: { workflowStatus: resumeStatus, updatedAt: new Date() },
  });

  // Status-desync backstop (task #804; mirrors the executor epilogue's #706
  // fix): this handler advances workflowStatus but left task.status alone,
  // so a task whose status had reverted to 'todo' (stale-heartbeat lease
  // sweep) stayed desynced until the next dispatch. Conditional so a
  // concurrent 'blocked' set by another actor is never clobbered.
  await prisma.task.updateMany({
    where: { id: taskId, status: 'todo' },
    data: { status: 'in-progress' },
  });

  await recordTransition({
    taskId,
    fromStatus: 'awaiting_question',
    toStatus: resumeStatus,
    actor,
    cause: 'question_resolved',
    metadata: {
      source,
      ...(recheckCompletionGate ? { recheckCompletionGate: true } : {}),
      ...(extraMetadata ?? {}),
    },
  });

  // Errors are logged inside triggerRedispatchAfterResume and never thrown —
  // a failed nudge must not fail this response (the resume itself is already
  // durably recorded above).
  await triggerRedispatchAfterResume(taskId);

  return {
    taskId,
    fromStatus: 'awaiting_question',
    toStatus: resumeStatus,
    source,
  };
}

/**
 * HTTP entry point for {@link applyResumeFromQuestionAnswer}: validates
 * taskId and maps thrown errors to the response status, then delegates.
 *
 * @param ctx - Elysia ハンドラコンテキスト
 * @returns 解決されたkindと復帰先status / 適用結果
 * @throws {ValidationError} taskId が不正、または `spec_change` kind に回答本文なしで呼ばれた場合
 * @throws {NotFoundError} タスクが見つからない場合、または保留中の質問がない場合
 * @throws {ConflictError} 停止中・古い質問・同時回答のいずれか
 */
export async function handleResumeFromQuestion({ params, set }: ResumeContext): Promise<{
  taskId: number;
  ok: true;
  toStatus: WorkflowStatus;
  resolvedKind: QuestionKind;
}> {
  const taskId = parseInt(params.taskId, 10);
  if (Number.isNaN(taskId)) {
    set.status = 400;
    throw new ValidationError('Invalid taskId');
  }

  try {
    const result = await applyResumeFromQuestionAnswer({ taskId, actor: 'user' });
    return {
      taskId: result.taskId,
      ok: true,
      toStatus: result.toStatus,
      resolvedKind: result.kind,
    };
  } catch (err) {
    if (err instanceof NotFoundError) set.status = 404;
    else if (err instanceof ValidationError) set.status = 400;
    else if (err instanceof ConflictError) set.status = 409;
    throw err;
  }
}

/**
 * Legacy public entry point for the `resume-from-question` endpoint /
 * auto-answer heal pass. Resolves the recorded (or derived) `kind` for the
 * task's pending question and delegates to {@link applyQuestionAnswerByKind}
 * — the same kind-based routing and competing-answer guards `answer-question`
 * uses, so a caller cannot bypass either by choosing this endpoint over the
 * other (task 902). `spec_change` questions are rejected (no answer body):
 * this endpoint's historical no-body shape must never silently treat an
 * unconfirmed spec change as answered.
 *
 * Deliberately UNLOCKED here — {@link applyQuestionAnswerByKind} already
 * wraps itself with `withTaskLifecycleLock`; wrapping again for the same
 * taskId would deadlock (the outer lock's own release only fires after the
 * inner call returns, which it never does while waiting on the outer lock).
 *
 * @param params - taskId/actor (+ optional extraMetadata) to answer with. / 復帰リクエスト
 * @returns The task id, resulting status, and resolved kind. / 適用結果
 */
export function applyResumeFromQuestionAnswer(params: {
  taskId: number;
  actor: TransitionActor;
  extraMetadata?: Record<string, unknown>;
}): ReturnType<typeof applyQuestionAnswerByKind> {
  return applyQuestionAnswerByKind({
    taskId: params.taskId,
    actor: params.actor,
    extraMetadata: params.extraMetadata,
  });
}
