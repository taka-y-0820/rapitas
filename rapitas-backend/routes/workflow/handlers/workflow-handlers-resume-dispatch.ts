/**
 * Workflow Handlers / Resume Dispatch
 *
 * Single kind-based entry point for resolving an `awaiting_question` pause:
 * reads the pause's recorded (or derived) kind and routes to the reset-draft
 * path (spec_change) or the plan-preserving resume path (execution_continuation
 * / completion_confirmation), so the caller (HTTP `answer-question` handler,
 * the stale-question auto-answer heal pass) never has to pick between the two
 * underlying appliers itself. Split out of workflow-handlers-resume.ts (task
 * 902) to stay under the file-size ratchet. Not responsible for validating
 * the HTTP request — callers do that before invoking this.
 */
import { prisma } from '../../../config';
import { ConflictError, NotFoundError, ValidationError } from '../../../middleware/error-handler';
import type { TransitionActor } from '../../../services/workflow/transition-recorder';
import { withTaskLifecycleLock } from '../../../services/workflow/task-lifecycle-lock';
import { isLatestExecutionCancelled } from '../../../services/workflow/publication-cancellation-guard';
import {
  resolveExplicitOrDefaultKind,
  resolveQuestionAnswerStrategy,
  readQuestionMetadata,
  type QuestionKind,
} from '../../../services/workflow/question-kind-resolver';
import type { WorkflowStatus } from '../../../services/workflow/workflow-types';
import { applyIntakeQuestionAnswerLocked, type AnswerSelection } from './workflow-handlers-resume';
import { applyResumeFromQuestionAnswerLocked } from './workflow-handlers-resume-continuation';

/** Input to {@link applyQuestionAnswerByKind}. */
export interface ApplyQuestionAnswerByKindParams {
  taskId: number;
  /**
   * Answer text. Required for `spec_change` (rejected with a
   * `ValidationError` when absent — a resume-from-question caller with no
   * answer body must never silently treat an unconfirmed spec change as
   * answered). Optional for `execution_continuation`/`completion_confirmation`,
   * matching `resume-from-question`'s historical no-body shape. / 回答本文
   */
  answer?: string;
  /** Who is recorded as having answered. / 記録するactor */
  actor: TransitionActor;
  /** Label folded into question.md's answer heading (intake path only). / 回答元ラベル */
  sourceLabel?: string;
  selections?: AnswerSelection[];
  /** Extra fields merged into the recorded transition's metadata. / 追加メタデータ */
  extraMetadata?: Record<string, unknown>;
}

const VALID_KINDS = new Set<QuestionKind>([
  'spec_change',
  'execution_continuation',
  'completion_confirmation',
]);

/**
 * Guard 1/4: reject when the task's latest execution is cancelled/a stop is
 * on record. Called twice (before and after the reads below) — a stop may
 * land while those reads are in flight.
 *
 * @param taskId - Task being answered. / 対象タスク
 * @throws {ConflictError} `task_stopping` when the latest execution is cancelled.
 */
export async function assertTaskNotStopping(taskId: number): Promise<void> {
  if (await isLatestExecutionCancelled(taskId)) {
    throw new ConflictError('タスクの実行が停止されています', 'task_stopping');
  }
}

/**
 * Guard 2/4: reject when a NEWER `awaiting_question` pause has superseded
 * the one this call captured (e.g. a heal pass re-paused after the caller
 * read the question).
 *
 * @param taskId - Task being answered. / 対象タスク
 * @param capturedTransitionId - `WorkflowTransition.id` of the pause the caller answered. / 捕捉した遷移ID
 * @throws {ConflictError} `question_outdated` when a newer pause exists.
 */
export async function assertQuestionNotOutdated(
  taskId: number,
  capturedTransitionId: number,
): Promise<void> {
  const latestPause = await prisma.workflowTransition.findFirst({
    where: { taskId, toStatus: 'awaiting_question' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  if (latestPause?.id !== capturedTransitionId) {
    throw new ConflictError('この質問は既に別の質問に置き換わっています', 'question_outdated');
  }
}

/**
 * Guard 3/4: compare-and-swap claim on the pause — only proceed while
 * `task.workflowStatus` is still exactly `awaiting_question`. A concurrent
 * answer landing first flips the affected-row count to 0.
 *
 * @param taskId - Task being answered. / 対象タスク
 * @throws {ConflictError} `question_already_answered` when the CAS touch affects 0 rows.
 */
export async function claimQuestionAnswerSlot(taskId: number): Promise<void> {
  const cas = await prisma.task.updateMany({
    where: { id: taskId, workflowStatus: 'awaiting_question' },
    data: { updatedAt: new Date() },
  });
  if (cas.count === 0) {
    throw new ConflictError('この質問は既に回答済みです', 'question_already_answered');
  }
}

/**
 * Resolve the currently-pending question's kind and answer it via the
 * strategy that kind maps to.
 *
 * Guards, in order (each rejects with NO state change on failure):
 *  1. {@link assertTaskNotStopping} — 409 `task_stopping`.
 *  2. No `awaiting_question` transition exists for the task — 404.
 *  3. `kind==='spec_change'` with no `answer` — 400 `ValidationError` (a
 *     resume-from-question caller must never silently treat an unconfirmed
 *     spec change as answered).
 *  4. {@link assertQuestionNotOutdated} — 409 `question_outdated`.
 *  5. {@link assertTaskNotStopping} again (a stop may land while the above
 *     reads were in flight) — 409 `task_stopping`.
 *  6. {@link claimQuestionAnswerSlot} — 409 `question_already_answered`.
 *
 * @param params - Answer to apply. / 適用する回答
 * @returns The task id, resulting status, and the kind that was resolved. / 適用結果
 * @throws {NotFoundError} No pending question is on record for the task.
 * @throws {ValidationError} `spec_change` kind answered with no `answer` text.
 * @throws {ConflictError} One of the competing-answer conditions above.
 */
export function applyQuestionAnswerByKind(params: ApplyQuestionAnswerByKindParams): Promise<{
  taskId: number;
  ok: true;
  toStatus: WorkflowStatus;
  kind: QuestionKind;
}> {
  return withTaskLifecycleLock(params.taskId, () => applyQuestionAnswerByKindLocked(params));
}

async function applyQuestionAnswerByKindLocked(params: ApplyQuestionAnswerByKindParams): Promise<{
  taskId: number;
  ok: true;
  toStatus: WorkflowStatus;
  kind: QuestionKind;
}> {
  const { taskId, answer, actor, sourceLabel, selections, extraMetadata } = params;

  await assertTaskNotStopping(taskId);

  const target = await prisma.workflowTransition.findFirst({
    where: { taskId, toStatus: 'awaiting_question' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, cause: true, fromStatus: true, metadata: true },
  });
  if (!target) {
    throw new NotFoundError('No pending question found for this task');
  }

  const meta = readQuestionMetadata(target.metadata);
  const recordedKind = meta?.kind;
  const kind =
    typeof recordedKind === 'string' && VALID_KINDS.has(recordedKind as QuestionKind)
      ? (recordedKind as QuestionKind)
      : resolveExplicitOrDefaultKind({
          cause: target.cause,
          currentStatus:
            typeof meta?.previousStatus === 'string' ? meta.previousStatus : target.fromStatus,
        });

  // A resume-from-question caller (no answer body) must never silently treat
  // an unconfirmed spec change as answered — reject explicitly instead of
  // falling through to a draft reset with an empty/undefined answer.
  if (kind === 'spec_change' && !answer) {
    throw new ValidationError(
      'この質問は仕様変更(spec_change)です。回答本文なしでは処理できません。' +
        '回答本文付きの answer-question API を使用してください。',
    );
  }

  await assertQuestionNotOutdated(taskId, target.id);
  await assertTaskNotStopping(taskId);
  await claimQuestionAnswerSlot(taskId);

  const strategy = resolveQuestionAnswerStrategy(kind);
  if (strategy === 'reset_draft') {
    // Guaranteed non-empty here — the spec_change/no-answer combination was
    // already rejected above, and reset_draft only ever maps from spec_change.
    const result = await applyIntakeQuestionAnswerLocked({
      taskId,
      answer: answer as string,
      actor,
      sourceLabel: sourceLabel ?? 'answer-question',
      selections,
      extraMetadata: { ...(extraMetadata ?? {}), kind },
    });
    return { ...result, kind };
  }

  const result = await applyResumeFromQuestionAnswerLocked({
    taskId,
    actor,
    answer,
    recheckCompletionGate: strategy === 'resume_previous_no_gate',
    extraMetadata: { ...(extraMetadata ?? {}), kind, ...(sourceLabel ? { sourceLabel } : {}) },
  });
  return { taskId: result.taskId, ok: true, toStatus: result.toStatus, kind };
}
