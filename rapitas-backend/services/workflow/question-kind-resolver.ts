/**
 * Question Kind Resolver
 *
 * Decides WHY a workflow question was raised (`spec_change` /
 * `execution_continuation` / `completion_confirmation`) and which resume
 * strategy applies to that kind. A single source of truth shared by the
 * raise-time metadata writers (intake-gate.ts, status-transition.ts), the
 * answer-time dispatcher (workflow-handlers-resume.ts) and the auto-answer
 * heal pass, so the two moments a kind is computed can never drift apart.
 * Not responsible for persisting anything or calling any answer/resume logic.
 */

/** The three explicit reasons a question can pause the workflow. */
export type QuestionKind = 'spec_change' | 'execution_continuation' | 'completion_confirmation';

/** Decode the JSON text persisted by recordTransition; tolerate legacy objects. */
export function readQuestionMetadata(value: unknown): Record<string, unknown> {
  try {
    const decoded = typeof value === 'string' ? JSON.parse(value) : value;
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded : {};
  } catch {
    return {};
  }
}

/** Resume strategy a {@link QuestionKind} maps to. */
export type QuestionAnswerStrategy =
  | 'reset_draft'
  | 'resume_previous_with_answer'
  | 'resume_previous_no_gate';

/** Input to {@link resolveExplicitOrDefaultKind}. */
export interface ResolveQuestionKindInput {
  /** The `WorkflowTransition.cause` that raised the pause. / 一時停止を起こしたcause */
  cause: string | null | undefined;
  /** Kind explicitly named by the raising agent (e.g. via `json:options`), if any. / 明示指定されたkind */
  explicitKind?: string | null;
  /** `workflowStatus` immediately before the pause. / 一時停止直前のstatus */
  currentStatus: string | null | undefined;
}

/** Only these two kinds may ever be produced from a non-intake cause. */
const NON_INTAKE_EXPLICIT_KINDS = new Set<QuestionKind>([
  'execution_continuation',
  'completion_confirmation',
]);

/**
 * Determine the kind of a workflow question.
 *
 * `cause === 'intake_question'` always resolves to `spec_change`, ignoring
 * any explicit kind — an intake question pausing on unconfirmed requirements
 * must never skip the draft reset (an intake question answered as anything
 * else would let implementation proceed on an unconfirmed spec).
 *
 * For any other cause, an explicit `execution_continuation` /
 * `completion_confirmation` is honored as given; `spec_change` is never a
 * valid explicit value outside intake and is treated as absent. Absent an
 * explicit kind, `currentStatus === 'verify_done'` defaults to
 * `completion_confirmation` (the task 897 shape: a question raised while
 * sitting at verify_done, confirming completion), otherwise
 * `execution_continuation`.
 *
 * @param input - cause / explicitKind / currentStatus at the moment the
 *   question paused the workflow. / 一時停止発生時点の情報
 * @returns The resolved kind. / 解決されたkind
 */
export function resolveExplicitOrDefaultKind(input: ResolveQuestionKindInput): QuestionKind {
  const { cause, explicitKind, currentStatus } = input;

  if (cause === 'intake_question') return 'spec_change';

  if (
    typeof explicitKind === 'string' &&
    NON_INTAKE_EXPLICIT_KINDS.has(explicitKind as QuestionKind)
  ) {
    return explicitKind as QuestionKind;
  }

  return currentStatus === 'verify_done' ? 'completion_confirmation' : 'execution_continuation';
}

/**
 * Map a {@link QuestionKind} to the resume strategy the answer-confirmation
 * path must apply.
 *
 * @param kind - Resolved question kind. / 解決済みkind
 * @returns The strategy to apply when the question is answered. / 適用する戦略
 */
export function resolveQuestionAnswerStrategy(kind: QuestionKind): QuestionAnswerStrategy {
  switch (kind) {
    case 'spec_change':
      return 'reset_draft';
    case 'completion_confirmation':
      return 'resume_previous_no_gate';
    case 'execution_continuation':
    default:
      return 'resume_previous_with_answer';
  }
}
