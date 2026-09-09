/**
 * Workflow Plan-Revision Context
 *
 * Turns a human's one-line "change the plan like this" instruction into a
 * planner prompt section carrying the CURRENT plan plus the instruction, so the
 * planner makes a targeted revision instead of re-deriving the whole document.
 *
 * Exists because the alternatives both cost more than they should: editing
 * plan.md by hand means reading ~14k characters to change one line and leaves
 * no record of why it changed, while a full regenerate discards the parts
 * nobody objected to. A rejection reason, meanwhile, only feeds the theme-wide
 * "do not repeat this" history (workflow-rejected-plan-context.ts) — it never
 * revises the plan of the task it was written for.
 *
 * Not responsible for dispatching the planner or for applying the edit.
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';

const log = createLogger('workflow:plan-revision-context');

/** Transition cause recorded when a human asks for a plan revision. */
export const PLAN_REVISION_CAUSE = 'plan_revision_requested';

const TEXT = {
  ja: {
    header: '# 計画の修正指示（人間からの依頼 — 最優先）',
    lead: [
      '以下の計画に対して、人間から修正指示が出ています。**ゼロから作り直さず、指示された箇所だけを直した改訂版**を保存してください。',
      '指摘されていない部分は、判断や理由付けも含めてそのまま維持すること。指示と矛盾する記述（「非対象」「却下した代替案」など）が残っていないか必ず確認して整合させること。',
    ].join('\n'),
    instructionHeader: '## 指示',
    planHeader: '## 現在の計画（この内容を改訂する）',
  },
  en: {
    header: '# Plan revision request (from a human — highest priority)',
    lead: [
      'A human asked for the plan below to be revised. Save a REVISED version that changes only what was asked — do not re-derive the plan from scratch.',
      'Keep everything that was not objected to, including its reasoning. Check for statements that now contradict the instruction (non-goals, rejected alternatives) and reconcile them.',
    ].join('\n'),
    instructionHeader: '## Instruction',
    planHeader: '## Current plan (revise this)',
  },
} as const;

/**
 * Render the revision section. Pure — testable without a database.
 *
 * @param instruction - The human's instruction. / 人間からの指示
 * @param currentPlan - The plan to revise. / 改訂対象の計画
 * @param language - Output language. / 出力言語
 * @returns Markdown section, or '' when there is nothing to inject. / 注入する節
 */
export function renderPlanRevision(
  instruction: string,
  currentPlan: string,
  language: 'ja' | 'en',
): string {
  const trimmed = instruction.trim();
  if (!trimmed) return '';
  const t = TEXT[language];
  // The revision must preserve untouched requirements, including gates at the
  // end of long plans. Truncation makes that instruction impossible to satisfy.
  return [
    t.header,
    '',
    t.lead,
    '',
    t.instructionHeader,
    trimmed,
    '',
    t.planHeader,
    currentPlan,
  ].join('\n');
}

/**
 * The revision instruction still awaiting application, if any.
 *
 * Staleness is decided by timestamp rather than a flag: a request older than
 * the current plan.md has already been applied by the run that saved it, so it
 * must not be injected again into an unrelated later planner run.
 *
 * @param taskId - Task being planned. / 対象タスクID
 * @returns The pending instruction, or null. / 未適用の指示、無ければ null
 */
export async function getPendingPlanRevision(taskId: number): Promise<string | null> {
  try {
    const [request, plan] = await Promise.all([
      prisma.workflowTransition.findFirst({
        where: { taskId, cause: PLAN_REVISION_CAUSE },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, metadata: true },
      }),
      prisma.workflowFile.findFirst({
        where: { taskId, fileType: 'plan' },
        select: { updatedAt: true },
      }),
    ]);
    if (!request) return null;
    if (plan && plan.updatedAt >= request.createdAt) return null;

    const parsed: unknown = JSON.parse(request.metadata ?? '{}');
    const instruction =
      parsed && typeof parsed === 'object'
        ? (parsed as { instruction?: unknown }).instruction
        : undefined;
    return typeof instruction === 'string' && instruction.trim() ? instruction : null;
  } catch (err) {
    log.warn({ err, taskId }, '[plan-revision] failed to read pending revision');
    return null;
  }
}

/**
 * Build the planner-context section for a pending revision.
 *
 * @param taskId - Task being planned. / 対象タスクID
 * @param currentPlan - plan.md as it stands. / 現在の plan.md
 * @param language - Output language. / 出力言語
 * @returns The section, or '' when no revision is pending. / 節、無ければ空文字
 */
export async function buildPlanRevisionContext(
  taskId: number,
  currentPlan: string | null,
  language: 'ja' | 'en',
): Promise<string> {
  if (!currentPlan) return '';
  const instruction = await getPendingPlanRevision(taskId);
  if (!instruction) return '';
  log.info({ taskId }, '[plan-revision] injecting revision instruction into planner context');
  return renderPlanRevision(instruction, currentPlan, language);
}
