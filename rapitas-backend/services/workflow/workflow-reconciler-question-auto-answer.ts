/**
 * Workflow Reconciler / Question Auto-Answer
 *
 * Auto-adopts a question's recommended option when it has sat unanswered in
 * `awaiting_question` past a timeout, so an operator's absence (nights,
 * incident response) no longer stalls a task indefinitely. Not responsible
 * for raising questions, rendering them, or the manual answer/resume paths —
 * only for this one unattended-timeout heal pass.
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import {
  TERMINAL_TASK_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
} from './workflow-reconciler-question-pause';
import {
  parseQuestionOptionsBlock,
  isQuestionBlockEligibleForAutoAnswer,
  composeAutoAnswerText,
} from './question-options-parser';
import { applyQuestionAnswerByKind } from '../../routes/workflow/handlers/workflow-handlers-resume-dispatch';
import { writeWorkflowFile } from './workflow-file-utils';
import { notifyQuestionAutoAnswered } from '../communication/notification-service';

const log = createLogger('workflow-reconciler');

/** Default wait before a stale question's recommended option is auto-adopted (60 minutes). */
const DEFAULT_AUTO_ANSWER_MS = 60 * 60 * 1000;

/**
 * Give an in-flight manual answer time to land before auto-answering. Mirrors
 * QUESTION_PAUSE_SETTLE_MS in workflow-reconciler-question-pause.ts — without
 * this, a user answering right at the timeout boundary could race the heal
 * pass.
 */
const SETTLE_WINDOW_MS = 2 * 60 * 1000;

/** Marks a transition recorded by this heal pass — also the once-per-task guard. */
const AUTO_ANSWER_REASON = 'auto_recommended';

/**
 * Substring matched against `WorkflowTransition.metadata` (a String column,
 * not native JSON — see prisma/schema/workflow.prisma) to find a prior
 * auto-answer for this task. Deliberately unbounded (no `take`/window): the
 * once-per-task cap is a LIFETIME guarantee (plan.md §データモデル/状態管理 —
 * "WorkflowTransition 履歴の metadata.reason === 'auto_recommended' 件数を都度
 * カウント"), so limiting the scan to the N most recent transitions would let
 * the guard miss an old marker once a task accumulates more than N
 * transitions and auto-answer a second time.
 */
const AUTO_ANSWER_METADATA_MARKER = `"reason":"${AUTO_ANSWER_REASON}"`;

/** Causes this heal pass is allowed to act on, mapped to their resume path. */
const ELIGIBLE_CAUSES = new Set(['intake_question', 'file_saved:question']);

/**
 * Resolve the configured auto-answer timeout, falling back to the default
 * (with a warning) on a missing/non-positive value.
 */
function resolveAutoAnswerTimeoutMs(): number {
  const raw = process.env.RAPITAS_QUESTION_AUTO_ANSWER_MS;
  const parsed = parseInt(raw ?? '', 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (raw) {
    log.warn(
      { raw },
      '[reconciler] RAPITAS_QUESTION_AUTO_ANSWER_MS is invalid — falling back to the 60-minute default',
    );
  }
  return DEFAULT_AUTO_ANSWER_MS;
}

/** One `awaiting_question` task snapshot considered by this heal pass. */
interface CandidateTask {
  id: number;
  title: string;
  status: string;
  workflowStatus: string | null;
}

/**
 * Auto-adopt the recommended option of stale, unattended `awaiting_question`
 * questions.
 *
 * A task is only touched when ALL of the following hold:
 *  - Its `question.md` has sat unmodified past the configured timeout.
 *  - No transition happened inside the settle window (nothing may be landing).
 *  - This task has never been auto-answered before (once per task, lifetime).
 *  - The transition that raised the pause has a recognized `cause`
 *    (`intake_question` or `file_saved:question`) — an unrecognized cause is
 *    left for a human rather than guessed at.
 *  - `question.md` parses as a `json:options` block and EVERY question in it
 *    is eligible (no `freeTextRequired`, a valid non-gate-mutating
 *    `recommended` option, a non-empty `recommendedReason`).
 *
 * @param now - Current time (injectable for tests). / 現在時刻
 * @returns Scan/auto-answer/skip counts. / 走査・自動採用・スキップ件数
 */
export async function healStaleQuestionAutoAnswer(
  now: Date = new Date(),
): Promise<{ scanned: number; autoAnswered: number; skipped: number }> {
  const nowMs = now.getTime();
  const timeoutMs = resolveAutoAnswerTimeoutMs();

  const tasks = await prisma.task
    .findMany({
      where: { workflowStatus: 'awaiting_question' },
      select: { id: true, title: true, status: true, workflowStatus: true },
    })
    .catch(() => [] as CandidateTask[]);

  let scanned = 0;
  let autoAnswered = 0;
  let skipped = 0;

  for (const task of tasks) {
    scanned++;
    try {
      const handled = await tryAutoAnswerOne(task, nowMs, timeoutMs);
      if (handled) autoAnswered++;
      else skipped++;
    } catch (err) {
      skipped++;
      log.warn(
        { err, taskId: task.id },
        '[reconciler] healStaleQuestionAutoAnswer: task failed — skipping and continuing',
      );
    }
  }

  return { scanned, autoAnswered, skipped };
}

/** Attempt to auto-answer a single candidate task. Returns true when adopted. */
async function tryAutoAnswerOne(
  task: CandidateTask,
  nowMs: number,
  timeoutMs: number,
): Promise<boolean> {
  if (TERMINAL_TASK_STATUSES.has(task.status)) return false;
  if (task.workflowStatus && TERMINAL_WORKFLOW_STATUSES.has(task.workflowStatus)) return false;

  const questionFile = await prisma.workflowFile
    .findFirst({
      where: { taskId: task.id, fileType: 'question' },
      select: { content: true, updatedAt: true },
    })
    .catch(() => null);
  if (!questionFile) return false;
  if (nowMs - questionFile.updatedAt.getTime() < timeoutMs) return false;

  const lastTransition = await prisma.workflowTransition
    .findFirst({
      where: { taskId: task.id },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    .catch(() => null);
  if (lastTransition && nowMs - lastTransition.createdAt.getTime() < SETTLE_WINDOW_MS) return false;

  // Lifetime (unbounded) check — see AUTO_ANSWER_METADATA_MARKER's doc comment.
  const priorAutoAnswer = await prisma.workflowTransition
    .findFirst({
      where: { taskId: task.id, metadata: { contains: AUTO_ANSWER_METADATA_MARKER } },
      select: { id: true },
    })
    .catch(() => null);
  if (priorAutoAnswer) return false;

  const pauseTransition = await prisma.workflowTransition
    .findFirst({
      where: { taskId: task.id, toStatus: 'awaiting_question' },
      orderBy: { createdAt: 'desc' },
      select: { cause: true },
    })
    .catch(() => null);
  const cause = pauseTransition?.cause;
  if (!cause || !ELIGIBLE_CAUSES.has(cause)) return false;

  const block = parseQuestionOptionsBlock(questionFile.content);
  if (!block) return false;

  const eligibility = isQuestionBlockEligibleForAutoAnswer(block);
  if (!eligibility.eligible) {
    log.info(
      { taskId: task.id, reason: eligibility.reason },
      '[reconciler] healStaleQuestionAutoAnswer: question not eligible for auto-answer',
    );
    return false;
  }

  const elapsedMinutes = Math.round((nowMs - questionFile.updatedAt.getTime()) / 60_000);
  const firstQuestion = block.questions[0];
  const recommendedOption = firstQuestion.options.find((o) => o.key === firstQuestion.recommended);
  const recommendedLabel = recommendedOption?.label ?? firstQuestion.recommended;

  const extraMetadata = {
    reason: AUTO_ANSWER_REASON,
    recommended: block.questions.map((q) => ({ questionId: q.id, key: q.recommended })),
    autoAnswerTimeoutMs: timeoutMs,
  };

  const noteBlock =
    `\n\n## 自動採用（無応答タイムアウト）\n` +
    `${elapsedMinutes}分間ユーザーの応答が無かったため、推奨選択肢「${recommendedLabel}」を自動採用しました。` +
    `変更する場合は基準を訂正して再実行してください。`;
  await writeWorkflowFile(task.id, 'question', `${questionFile.content}${noteBlock}`).catch(
    (err) => {
      log.warn(
        { err, taskId: task.id },
        '[reconciler] failed to append auto-answer note to question.md',
      );
    },
  );

  const { answerText, selections } = composeAutoAnswerText(block);

  // kindベースの単一ディスパッチに統一（task 902）— cause文字列による2値分岐
  // (intake_question/file_saved:question)をここで再実装せず、answer-question
  // ハンドラと同じ resolveExplicitOrDefaultKind/resolveQuestionAnswerStrategy を
  // 共有する。
  await applyQuestionAnswerByKind({
    taskId: task.id,
    answer: answerText,
    actor: 'system',
    sourceLabel: '推奨案の自動採用（無応答タイムアウト）',
    selections,
    extraMetadata,
  });

  await notifyQuestionAutoAnswered(task.id, task.title, recommendedLabel, elapsedMinutes).catch(
    (err) => {
      log.warn({ err, taskId: task.id }, '[reconciler] failed to send auto-answer notification');
    },
  );

  log.info(
    { taskId: task.id, cause, recommendedLabel, elapsedMinutes },
    '[reconciler] healStaleQuestionAutoAnswer: auto-adopted recommended option',
  );
  return true;
}
