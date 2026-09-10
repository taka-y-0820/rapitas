/**
 * Intake Gate
 *
 * Runs once, just before the research phase, to raise a thin task spec to a
 * workable quality bar. It auto-enriches the spec (goals / constraints /
 * acceptance criteria) from the description, and — per policy — either pauses
 * for a single clarifying question or proceeds on best-guess with a recorded
 * low-confidence flag.
 *
 * Idempotent: re-running on an already-adequate (or already-asked) task is a
 * no-op, so it is safe to call on every `draft → research` advance, including
 * after a question is answered (status returns to draft and the gate re-runs).
 * Not responsible for launching the researcher — the orchestrator does that.
 */
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import {
  resolveWorkflowDir,
  readWorkflowFile,
  writeWorkflowFile,
} from '../workflow/workflow-file-utils';
import { recordTransition } from '../workflow/transition-recorder';
import { deriveTaskSpec, generateIntakeQuestions } from '../task/task-spec-deriver';
import {
  createNotification,
  notifyIntakeQuestionPending,
} from '../communication/notification-service';
import {
  extractReferencedTaskIds,
  findContaminatedCriteria,
  type ContaminatedCriterion,
} from './spec-coherence-checker';
import {
  checkSpecQuality,
  mergeSpecField,
  parseSpecArray,
  type SpecQualityInput,
  type SpecQualityResult,
} from './spec-quality-checker';
import { resolveIntakePolicy, decideIntake } from './intake-policy';
import { buildIntakeQuestion } from './intake-question-template';

const log = createLogger('intake-gate');

/** Result of {@link ensureIntakeReady}. */
export interface IntakeOutcome {
  /**
   * - `ready`: spec is adequate, proceed to research.
   * - `awaiting_question`: a clarifying question was raised; workflow paused.
   * - `proceed_low_confidence`: spec is thin but policy says proceed anyway.
   */
  status: 'ready' | 'awaiting_question' | 'proceed_low_confidence';
  /** Optional human-readable note for the caller's result/output. */
  message?: string;
}

/** The task fields the gate reads — typed loosely so a pre-migration Prisma
 * client (no goals/constraints/acceptanceCriteria columns) degrades gracefully
 * to "fields absent → treated as missing" instead of crashing. */
interface IntakeTaskRow extends SpecQualityInput {
  id: number;
  title: string;
  workflowStatus: string | null;
}

/**
 * Ensure a task's spec is good enough to run research autonomously.
 *
 * @param taskId - The task entering its research phase. / 調査フェーズに入るタスクID
 * @returns The intake outcome the orchestrator must act on. / オーケストレータが扱う結果
 */
export async function ensureIntakeReady(taskId: number): Promise<IntakeOutcome> {
  const row = await prisma.task.findUnique({ where: { id: taskId } });
  if (!row) return { status: 'ready' };

  // Read spec fields via a narrow cast (see IntakeTaskRow) so an unknown-column
  // client cannot throw on access — missing columns read as undefined.
  const task = row as unknown as IntakeTaskRow;

  // Coherence BEFORE thickness. A spec can be perfectly substantial and still
  // be about the wrong task — that is the path task 671 took, straight through
  // the adequate check and into ten repair rounds. Asked first because a thick
  // wrong spec is worse than a thin right one: the thin one gets questions, the
  // thick one gets built.
  const contaminated = await findLiftedCriteria(task).catch((err) => {
    log.warn({ err, taskId }, '[intake-gate] coherence check failed (non-fatal)');
    return [];
  });
  if (contaminated.length > 0) {
    // Ask once. If a question was already answered and the criteria still carry
    // another task's vocabulary, asking again would loop (task 363's shape), so
    // record it and let the run proceed — the diff review still catches it.
    if (!(await hasAnsweredIntakeQuestion(taskId))) {
      await raiseContaminationQuestion(task, contaminated);
      return {
        status: 'awaiting_question',
        message: '受入基準が別タスクの内容を含んでいるため確認の質問を作成しました',
      };
    }
    log.warn(
      { taskId, criteria: contaminated.map((c) => c.index) },
      '[intake-gate] criteria still look lifted after an answered question — proceeding',
    );
  }

  let quality = checkSpecQuality(task);
  if (quality.isAdequate) return { status: 'ready' };

  // 1) Auto-enrich from description (+ any prior answer in question.md). Failures
  //    are swallowed — the gate still asks/proceeds below.
  const enriched = await enrichSpec(taskId, task).catch((err) => {
    log.warn({ err, taskId }, '[intake-gate] enrichment failed (non-fatal)');
    return null;
  });
  if (enriched) {
    quality = checkSpecQuality(enriched);
    if (quality.isAdequate) {
      log.info({ taskId, score: quality.score }, '[intake-gate] spec enriched to adequate');
      return { status: 'ready' };
    }
  }

  // 2) Still thin → decide: keep asking until the user answers, or (once answered
  // but still thin) proceed on best-guess. The workflow must NOT advance while a
  // question is unanswered.
  const wasAnswered = await hasAnsweredIntakeQuestion(taskId);
  const { policy, source } = resolveIntakePolicy();
  const action = decideIntake(false, wasAnswered, policy);

  if (action === 'ask') {
    await raiseIntakeQuestion(task, quality);
    return {
      status: 'awaiting_question',
      message: '仕様が不十分なため確認の質問を作成しました（回答されるまで先に進みません）',
    };
  }

  await recordLowConfidence(task, quality, policy, wasAnswered);
  log.info(
    { taskId, score: quality.score, missing: quality.missing, policy, source, wasAnswered },
    '[intake-gate] proceeding with thin spec (best-guess)',
  );
  return {
    status: 'proceed_low_confidence',
    message: '仕様が不十分ですが、ポリシーにより best-guess で実行を継続します',
  };
}

/**
 * Criteria on this task that carry another task's subject matter.
 *
 * Only tasks this spec actually cites are considered, and never the task
 * itself — a task may legitimately quote its own title.
 *
 * The task's own text is passed through as well, because the second detection
 * path needs no lookup: a title of the form `#666「…」` carries the other
 * task's subject inside this one, and criteria drawn from that quoted span are
 * about the cited task by construction.
 */
async function findLiftedCriteria(task: IntakeTaskRow): Promise<ContaminatedCriterion[]> {
  const criteria = parseSpecArray(task.acceptanceCriteria);
  if (criteria.length === 0) return [];

  const ownText = `${task.title} ${task.description ?? ''}`;
  const ids = extractReferencedTaskIds(ownText).filter((id) => id !== task.id);
  if (ids.length === 0) return [];

  const referenced = await prisma.task.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true },
  });
  return findContaminatedCriteria(criteria, referenced, ownText);
}

/**
 * Pause the task and say which criteria belong to which other task.
 *
 * Deliberately concrete: it names the criterion, the phrase, and the task the
 * phrase came from, because that is what a reader needs to decide whether to
 * rewrite the criteria or keep them. The generic 「仕様が不十分」 question would
 * not have helped here — the spec was not insufficient, it was misdirected.
 */
async function raiseContaminationQuestion(
  task: IntakeTaskRow,
  contaminated: ContaminatedCriterion[],
): Promise<void> {
  const resolved = await resolveWorkflowDir(task.id);
  if (!resolved) {
    log.warn({ taskId: task.id }, '[intake-gate] cannot resolve workflow dir — skipping question');
    return;
  }
  const lines = [
    '# 仕様確認: 受入基準が別タスクの内容を含んでいます',
    '',
    `タスク「${task.title}」の受入基準に、参照している別タスクが導入した用語がそのまま現れています。`,
    'ゴールアンカー生成が観測元タスクの内容を取り込んだ可能性があります。',
    '',
    '## 該当する受入基準',
    '',
  ];
  for (const c of contaminated) {
    lines.push(`- 受入基準${c.index}: ${c.criterion}`);
    lines.push(
      `  - タスク #${c.sourceTaskId} の用語: ${c.phrases.map((p) => `「${p}」`).join(' ')}`,
    );
  }
  lines.push(
    '',
    '## 判断してください',
    '',
    `- **A: 受入基準はこのタスクのものではない** — 基準を書き直してください。このタスク（${task.title}）が実際に達成すべきことを基準にします`,
    '- **B: 受入基準は正しい** — 参照タスクと同じ用語を使うのが妥当な場合はこちらを選んでください。このまま実行します',
    '',
    'A の場合、受入基準を訂正してから回答してください（訂正すると修復予算もリセットされます）。',
  );
  await writeWorkflowFile(task.id, 'question', lines.join('\n'));

  const fromStatus = task.workflowStatus ?? 'draft';
  await prisma.task.update({
    where: { id: task.id },
    data: { workflowStatus: 'awaiting_question', updatedAt: new Date() },
  });
  await recordTransition({
    taskId: task.id,
    fromStatus,
    toStatus: 'awaiting_question',
    actor: 'system',
    cause: 'intake_question',
    phase: 'question',
    metadata: {
      previousStatus: fromStatus,
      kind: 'spec_change',
      reason: 'criteria_contamination',
      criteria: contaminated.map((c) => c.index),
      sourceTaskIds: [...new Set(contaminated.map((c) => c.sourceTaskId))],
    },
  });
  await notifyIntakeQuestionPending({ taskId: task.id, taskTitle: task.title }).catch(() => {});
}

/**
 * Derive a spec from the description (+ prior answer) and persist any net-new
 * items. Returns the post-merge spec view, or null when nothing was added.
 */
async function enrichSpec(taskId: number, task: IntakeTaskRow): Promise<SpecQualityInput | null> {
  const priorAnswer = await readWorkflowFile(taskId, 'question');
  const basis = [task.description ?? '', priorAnswer ?? ''].join('\n\n').trim();
  if (!basis) return null;

  const { spec, source } = await deriveTaskSpec(basis);
  if (source !== 'ai') return null;

  const goals = mergeSpecField(task.goals, spec.goals);
  const constraints = mergeSpecField(task.constraints, spec.constraints);
  const acceptanceCriteria = mergeSpecField(task.acceptanceCriteria, spec.acceptanceCriteria);

  const grew =
    goals.length > parseSpecArray(task.goals).length ||
    constraints.length > parseSpecArray(task.constraints).length ||
    acceptanceCriteria.length > parseSpecArray(task.acceptanceCriteria).length;
  if (!grew) return null;

  await prisma.task.update({
    where: { id: taskId },
    data: {
      goals: JSON.stringify(goals),
      constraints: JSON.stringify(constraints),
      acceptanceCriteria: JSON.stringify(acceptanceCriteria),
      updatedAt: new Date(),
    },
  });
  await recordTransition({
    taskId,
    fromStatus: task.workflowStatus ?? null,
    toStatus: task.workflowStatus ?? 'draft',
    actor: 'system',
    cause: 'intake_enriched',
    phase: 'research',
    metadata: {
      goals: goals.length,
      constraints: constraints.length,
      acceptanceCriteria: acceptanceCriteria.length,
    },
  });

  return { description: task.description, goals, constraints, acceptanceCriteria };
}

/**
 * Whether the USER has ANSWERED a prior intake question (the answer endpoint
 * records a `intake_question_answered` transition). Distinguishes "asked but
 * unanswered" (keep waiting) from "answered but still thin" (proceed best-guess).
 *
 * @param taskId - Task to check. / 対象タスク
 * @returns true when an answer was recorded. / 回答済みなら true
 */
async function hasAnsweredIntakeQuestion(taskId: number): Promise<boolean> {
  const answered = await prisma.workflowTransition
    .findFirst({ where: { taskId, cause: 'intake_question_answered' }, select: { id: true } })
    .catch(() => null);
  return answered !== null;
}

/** Write the clarifying question.md and move the task to awaiting_question. */
async function raiseIntakeQuestion(task: IntakeTaskRow, quality: SpecQualityResult): Promise<void> {
  const resolved = await resolveWorkflowDir(task.id);
  if (!resolved) {
    log.warn({ taskId: task.id }, '[intake-gate] cannot resolve workflow dir — skipping question');
    return;
  }
  // The executing agent (AI) proposes one focused question per missing field
  // (1問1答); buildIntakeQuestion falls back to a single heuristic goal question
  // when AI is unavailable/empty.
  const aiQuestions = await generateIntakeQuestions(
    task.title,
    task.description ?? '',
    quality.missing,
  ).catch(() => []);
  const body = buildIntakeQuestion({
    title: task.title,
    missing: quality.missing,
    reasons: quality.reasons,
    questions: aiQuestions,
  });
  await writeWorkflowFile(task.id, 'question', body);

  const fromStatus = task.workflowStatus ?? 'draft';
  await prisma.task.update({
    where: { id: task.id },
    data: { workflowStatus: 'awaiting_question', updatedAt: new Date() },
  });
  // previousStatus lets resume-from-question restore the pre-question status
  // (draft), which re-triggers this gate. It stays paused (asks again) until the
  // user answers — see hasAnsweredIntakeQuestion / decideIntake.
  await recordTransition({
    taskId: task.id,
    fromStatus,
    toStatus: 'awaiting_question',
    actor: 'system',
    cause: 'intake_question',
    phase: 'question',
    metadata: {
      previousStatus: fromStatus,
      kind: 'spec_change',
      missing: quality.missing,
      score: quality.score,
    },
  });
  // Surface the pause — an unanswered question NEVER advances on its own, so
  // silence here is worse than the low-confidence proceed case below (#578/#579
  // sat 4 days unseen). Best-effort like recordLowConfidence's notification.
  await notifyIntakeQuestionPending({ taskId: task.id, taskTitle: task.title }).catch(() => {});
}

/** Record (audit + notify) that we proceeded despite a thin spec. */
async function recordLowConfidence(
  task: IntakeTaskRow,
  quality: SpecQualityResult,
  policy: string,
  alreadyAsked: boolean,
): Promise<void> {
  const status = task.workflowStatus ?? 'draft';
  await recordTransition({
    taskId: task.id,
    fromStatus: status,
    toStatus: status,
    actor: 'system',
    cause: 'intake_low_confidence',
    phase: 'research',
    metadata: { missing: quality.missing, score: quality.score, policy, alreadyAsked },
  });
  // Surface it so "proceed on best-guess" is never silent (the anti-pattern).
  await createNotification({
    type: 'system',
    title: '仕様が不十分なまま実行',
    message: `タスク #${task.id}「${task.title}」は仕様が不十分ですが、ポリシーにより実行を継続します（要確認）。`,
    link: `/tasks?taskId=${task.id}`,
    metadata: { taskId: task.id, missing: quality.missing, score: quality.score },
  }).catch(() => {});
}
