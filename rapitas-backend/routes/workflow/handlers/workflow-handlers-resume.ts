import { withTaskLifecycleLock } from '../../../services/workflow/task-lifecycle-lock';
/**
 * Workflow Handlers / Resume
 *
 * `awaiting_question` 状態から、保存された previousStatus に復帰する API ハンドラ。
 * question.md がユーザーによって解消（回答記入 or 削除）された後、エージェント実行を
 * 再開させるために呼ばれる。
 */

import { prisma } from '../../../config';
import { recordTransition } from '../../../services/workflow/transition-recorder';
import type { TransitionActor } from '../../../services/workflow/transition-recorder';
import { ValidationError, NotFoundError, ConflictError } from '../../../middleware/error-handler';
import { createLogger } from '../../../config';
import type { WorkflowStatus } from '../../../services/workflow/workflow-types';
import {
  archiveWorkflowFile,
  readWorkflowFile,
  writeWorkflowFile,
} from '../../../services/workflow/workflow-file-utils';
import { triggerReExecutionAfterAnswer } from './workflow-handlers-resume-redispatch';
import { applyQuestionAnswerByKind } from './workflow-handlers-resume-dispatch';
import type { QuestionKind } from '../../../services/workflow/question-kind-resolver';

const log = createLogger('routes:workflow:resume');

interface AnswerContext {
  params: { taskId: string };
  body?: { answer?: string; selections?: unknown } | unknown;
  set: { status?: number };
  headers?: Record<string, string | undefined>;
}

/** Callers permitted to answer a spec question, and how each is labelled. */
const ANSWER_SOURCE_LABELS: Record<string, string> = {
  ui: 'ユーザー選択',
  operator: 'オペレーター代理回答',
};

/** One question's audit record: which option (if any) the user picked. */
export interface AnswerSelection {
  questionId: string;
  selectedKey: string | null;
}

/**
 * Defensively parse the optional `selections` audit payload from a
 * structured (`json:options`) answer. Malformed/absent input yields
 * `undefined` rather than throwing — `selections` is an audit nicety, never
 * required to apply the answer itself (the `answer` string is authoritative).
 *
 * @param raw - The `selections` field from the request body, unvalidated. / 未検証の selections
 * @returns Parsed selections, or undefined when absent/empty/invalid. / パース結果
 */
function parseSelections(raw: unknown): AnswerSelection[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AnswerSelection[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (typeof o.questionId !== 'string' || !o.questionId.trim()) continue;
    out.push({
      questionId: o.questionId,
      selectedKey: typeof o.selectedKey === 'string' ? o.selectedKey : null,
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Input to {@link applyIntakeQuestionAnswer}. */
export interface ApplyIntakeAnswerParams {
  taskId: number;
  answer: string;
  /** Who is recorded as having answered (HTTP callers always pass 'user'). / 記録するactor */
  actor: TransitionActor;
  /** Label folded into the description/question.md answer headings (e.g. 'ユーザー選択'). / 回答元ラベル */
  sourceLabel: string;
  selections?: AnswerSelection[];
  /** Extra fields merged into the recorded transition's metadata. / 追加メタデータ */
  extraMetadata?: Record<string, unknown>;
}

/**
 * Core logic for applying an answer to a workflow QUESTION (the intake quality
 * gate's `question.md` asking for goals/constraints/acceptance, or any
 * spec-clarification question). The answer is appended to the task description
 * as a 仕様補足 section AND seeded into the structured `goals` field so the
 * intake gate sees a non-empty spec instead of re-asking; question.md is
 * archived and the workflow is reset to `draft` so research re-runs with the
 * enrichment.
 *
 * Transport-agnostic on purpose: {@link handleAnswerWorkflowQuestion} (HTTP,
 * `actor:'user'`) and the stale-question auto-answer heal pass (in-process,
 * `actor:'system'`) both call this directly so the goals/question.md/plan.md
 * handling never drifts between the two callers.
 *
 * @param params - Answer to apply. / 適用する回答
 * @returns The task id and the status it was reset to. / 反映後の状態
 * @throws {NotFoundError} タスクが見つからない場合
 */
export async function applyIntakeQuestionAnswerLocked(params: ApplyIntakeAnswerParams): Promise<{
  taskId: number;
  ok: true;
  toStatus: WorkflowStatus;
}> {
  const { taskId, answer, actor, sourceLabel, selections, extraMetadata } = params;

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, description: true, goals: true, workflowStatus: true, status: true },
  });
  if (!task) {
    throw new NotFoundError('Task not found');
  }

  // Seed the structured goals so the intake gate sees a non-empty spec (else it
  // re-asks the same question on the re-run).
  let goals: string[] = [];
  try {
    const parsed = JSON.parse(task.goals ?? '[]');
    if (Array.isArray(parsed)) goals = parsed.filter((g): g is string => typeof g === 'string');
  } catch {
    /* malformed goals JSON — start fresh */
  }
  if (!goals.includes(answer)) goals.push(answer);

  const clarified = `${task.description ?? ''}\n\n## 仕様補足（${sourceLabel}）\n${answer}`.trim();

  // This intake pause never had a live agent session (question.md was saved
  // then the process exited) — the researcher's own execution loop
  // misreported that pause as a phase failure, which left task.status
  // stuck at 'blocked' (see workflow-cli-executor.ts's awaiting_question
  // handling). Answering only resets workflowStatus; without also clearing
  // a stale 'blocked' here, the task stays permanently unschedulable even
  // after the user answers (WorkflowOrchestrator refuses to advance any
  // 'blocked' task). Only touch it when 'blocked' — never override a
  // status set for an unrelated reason.
  const statusUpdate = task.status === 'blocked' ? { status: 'todo' as const } : {};

  await prisma.task.update({
    where: { id: taskId },
    data: {
      description: clarified,
      goals: JSON.stringify(goals),
      workflowStatus: 'draft',
      updatedAt: new Date(),
      ...statusUpdate,
    },
  });

  // Append the answer to question.md BEFORE archiving, so the archived
  // WorkflowFileVersion keeps an audit trail of what was actually answered
  // (writeWorkflowFile itself moves the pre-append content into
  // WorkflowFileVersion, then archiveWorkflowFile moves the appended version
  // there too — archiveWorkflowFile's own signature is unchanged).
  const questionContent = await readWorkflowFile(taskId, 'question');
  if (questionContent != null) {
    const answerBlock = `\n\n## 回答（${sourceLabel}）\n${answer}`;
    await writeWorkflowFile(taskId, 'question', `${questionContent}${answerBlock}`).catch(() => {});
  }

  // Archive question.md so it is no longer a pending question.
  await archiveWorkflowFile(taskId, 'question').catch(() => {});

  // The plan was derived from the spec as it stood BEFORE this answer, so it
  // now contradicts it. Archive it too and let the planner regenerate.
  //
  // Task 662 is what this costs otherwise: an operator answer widened the scope
  // to include a UI card, the implementer built exactly that, and the
  // adversarial reviewer — which reads plan.md, not the task description —
  // rejected the diff four times in a row for violating the stale plan's
  // 「非対象（やらないこと）: UIカードの新規追加」. The planner tried to rewrite it
  // and was refused (`transition_rejected`: plan is not an allowed file type at
  // plan_approved), so nothing could break the loop. Keeping the plan is not
  // even the cheap option: one planner re-run cost ~$1 on that task, the four
  // wasted implement+verify cycles cost ~$8.
  //
  // Unconditional on purpose. Detecting whether an answer 'materially' changes
  // scope is the same kind of guess that keeps being wrong; regenerating one
  // cheap phase is the reliable option.
  await archiveWorkflowFile(taskId, 'plan').catch(() => {});

  await recordTransition({
    taskId,
    fromStatus: (task.workflowStatus as WorkflowStatus) ?? 'draft',
    toStatus: 'draft',
    actor,
    cause: 'intake_question_answered',
    metadata: { ...(selections ? { selections } : {}), ...(extraMetadata ?? {}) },
  });

  log.info(
    { taskId, actor },
    '[Workflow:Answer] Recorded answer to workflow question; reset to draft',
  );

  // Errors are logged inside triggerReExecutionAfterAnswer and never thrown —
  // a failed auto re-run must not fail this response (the answer itself is
  // already durably recorded above; the user can still re-run manually).
  await triggerReExecutionAfterAnswer(taskId);

  return { taskId, ok: true, toStatus: 'draft' };
}

/**
 * HTTP entry point for {@link applyIntakeQuestionAnswer}: validates the
 * request (taskId, `X-Rapitas-Source` header, non-blank answer) and maps
 * thrown errors to the response status, then delegates.
 *
 * Without this, an intake `question.md` was displayed in the Q&A tab but had no
 * answer path (the interactive panel only handled live mid-execution questions),
 * so the user could not actually answer the agent.
 *
 * @param ctx - Elysia handler context with { answer, selections? } body. / 回答ボディ
 * @returns The task id and the status it was reset to. / 反映後の状態
 * @throws {ValidationError} taskId 不正 / answer 未指定
 * @throws {NotFoundError} タスクが見つからない場合
 */
export async function handleAnswerWorkflowQuestion({
  params,
  body,
  set,
  headers,
}: AnswerContext): Promise<{
  taskId: number;
  ok: true;
  toStatus: WorkflowStatus;
  /** Kind resolved for this answer — surfaced for observability; the UI does not parse it. / 解決されたkind */
  resolvedKind: QuestionKind;
}> {
  const taskId = parseInt(params.taskId, 10);
  if (Number.isNaN(taskId)) {
    set.status = 400;
    throw new ValidationError('Invalid taskId');
  }

  // A spec question is a decision the WORKFLOW is not entitled to make for
  // itself. Task 662 asked whether its 「視覚的に区別できる」 acceptance criterion
  // could be met with no UI, then answered itself 「UI追加なし」 through a shell
  // curl — and the archive recorded it as 「ユーザー選択」. The verifier then
  // correctly failed that criterion twice (it says 視覚的に; the diff had no UI)
  // and the task blocked on non-convergence. The escalation was right; the
  // scope waiver behind it was never granted by anyone.
  //
  // Mirrors the guard on PUT /tasks/:id/status (workflow-handlers-plan.ts):
  // server-internal callers never go through HTTP, so legitimate traffic here
  // always carries the header.
  const rawSource = headers?.['x-rapitas-source'];
  const answerSource = typeof rawSource === 'string' ? rawSource.toLowerCase() : '';
  if (!ANSWER_SOURCE_LABELS[answerSource]) {
    log.warn(
      { taskId, source: rawSource ?? null, ua: headers?.['user-agent'] ?? null },
      '[Workflow:Answer] Rejected spec answer: missing X-Rapitas-Source header (likely an agent shell-call)',
    );
    await recordTransition({
      taskId,
      fromStatus: null,
      toStatus: 'awaiting_question',
      actor: 'system',
      cause: 'spec_answer_blocked',
      metadata: { reason: 'missing X-Rapitas-Source header', source: rawSource ?? null },
      invariantViolation: true,
      invariantMessage: 'Agent attempted to answer its own spec question',
    }).catch(() => {});
    set.status = 400;
    throw new ValidationError(
      '仕様質問への回答には X-Rapitas-Source ヘッダ(ui|operator)が必要です。' +
        'エージェントが自身の仕様質問に回答することは許可されていません。',
    );
  }

  const answer =
    typeof (body as { answer?: string })?.answer === 'string'
      ? (body as { answer: string }).answer.trim()
      : '';
  if (!answer) {
    set.status = 400;
    throw new ValidationError('answer is required');
  }
  const selections = parseSelections((body as { selections?: unknown })?.selections);

  try {
    const result = await applyQuestionAnswerByKind({
      taskId,
      answer,
      actor: 'user',
      sourceLabel: ANSWER_SOURCE_LABELS[answerSource],
      selections,
    });
    return {
      taskId: result.taskId,
      ok: true,
      toStatus: result.toStatus,
      resolvedKind: result.kind,
    };
  } catch (err) {
    if (err instanceof NotFoundError) set.status = 404;
    else if (err instanceof ConflictError) set.status = 409;
    throw err;
  }
}

export function applyIntakeQuestionAnswer(
  params: Parameters<typeof applyIntakeQuestionAnswerLocked>[0],
) {
  return withTaskLifecycleLock(params.taskId, () => applyIntakeQuestionAnswerLocked(params));
}

// Resume (execution_continuation/completion_confirmation) applier + its HTTP
// handler now live in workflow-handlers-resume-continuation.ts (task 902,
// split to stay under the file-size ratchet). Re-exported here so existing
// importers of this module keep working unchanged.
export {
  applyResumeFromQuestionAnswerLocked,
  applyResumeFromQuestionAnswer,
  handleResumeFromQuestion,
  type ApplyResumeAnswerParams,
} from './workflow-handlers-resume-continuation';
