/**
 * Workflow Planner Context
 *
 * Assembles the prompt context string for the planner role (critic feedback/
 * lessons, memory, rejected plans, CBR case, playbook, research.md, subtask
 * split directive). Does not build contexts for other roles.
 */
import { observeWorkflowStage } from './workflow-stage-timing';
import { readWorkflowFile } from './workflow-file-utils';
import { buildMemoryContext } from './workflow-memory-context';
import { buildRejectedPlanContext } from './workflow-rejected-plan-context';
import { buildPlanRevisionContext } from './workflow-plan-revision-context';
import { buildCaseContext } from './workflow-case-context';
import { buildPlaybookContext } from '../memory/playbook/playbook-inject';
import { buildCriticFeedback, buildCriticLessonsSection } from './phase-critic';
import { buildSubtaskSplitDirective } from './subtask-split-policy';
import { recordContextMetrics } from './workflow-context-metrics';
import type { PlannerTexts } from './workflow-role-prompts';
import { prisma } from '../../config/database';
import { buildRequirementReplanContext } from './requirement-replan-context';

/**
 * Build the planner role's prompt context.
 *
 * @param taskId - Task id used to read prior artifacts and record metrics. / タスクID
 * @param task - Task title and description. / タスクのタイトルと説明
 * @param language - Output language. / 出力言語
 * @param mode - Resolved workflow mode (metrics recording only). / 解決済みワークフローモード
 * @param taskInfo - Pre-built task-info block. / タスク情報ブロック
 * @param texts - Planner prompt texts for the language. / planner用テキスト
 * @param questionFormat - question.md format guidance block. / question.md フォーマット規約
 * @param styleRule - Report style rule block. / 文体ルールブロック
 * @returns Assembled planner context string. / planner用コンテキスト文字列
 */
export async function buildPlannerContext(
  taskId: number,
  task: { title: string; description: string | null },
  language: 'ja' | 'en',
  mode: 'lightweight' | 'standard' | 'comprehensive',
  taskInfo: string,
  texts: PlannerTexts,
  questionFormat: string,
  styleRule: string,
): Promise<string> {
  const research = await readWorkflowFile(taskId, 'research');
  let ctx = taskInfo;
  const requirementReplan = await buildRequirementReplanContext(prisma, taskId, language);
  if (requirementReplan) ctx += `\n\n${requirementReplan}`;

  // A human asked for a targeted change to THIS plan. Leads the context: it is
  // a direct instruction about the document being written, so it outranks the
  // critic bounce and the cross-task lessons below, both of which are advice.
  // Carries the current plan with it so the planner revises rather than
  // re-derives — nothing else in this context includes plan.md.
  const planRevision = await buildPlanRevisionContext(
    taskId,
    await readWorkflowFile(taskId, 'plan'),
    language,
  );
  if (planRevision) {
    ctx += `

${planRevision}`;
  }
  // On a critic-gate bounce, lead with the issues the prior plan missed.
  const planCritic = await buildCriticFeedback(taskId, 'plan', language);
  if (planCritic) {
    ctx += `\n\n${planCritic}`;
  }
  // Cross-task learning loop — see the researcher case for rationale.
  const planLessons = await observeWorkflowStage(taskId, 'context.buildCriticLessonsSection', () =>
    buildCriticLessonsSection('plan', language),
  );
  if (planLessons) {
    ctx += `\n\n${planLessons}`;
  }
  // Recall prior knowledge for the planner too — recorded design decisions
  // and blocked-task lessons should shape the plan, not be re-discovered
  // (or re-violated) at implementation time. Previously only researcher and
  // implementer received memory, so the planner re-decided settled points.
  const plannerMemory = await observeWorkflowStage(taskId, 'context.buildMemoryContext', () =>
    buildMemoryContext(taskId, task, language),
  );
  if (plannerMemory) {
    ctx += `\n\n${plannerMemory}`;
  }
  // Recall human rejections of prior plans in this theme so the new plan
  // addresses them instead of repeating a turned-down design.
  const rejected = await buildRejectedPlanContext(taskId, language);
  if (rejected) {
    ctx += `\n\n${rejected}`;
  }
  // CBR (R9): the nearest SOLVED similar task's plan-that-worked — concrete
  // file layout / step ordering to adapt, stronger than abstract lessons.
  const plannerCase = await observeWorkflowStage(taskId, 'context.buildCaseContext', () =>
    buildCaseContext(taskId, task, language),
  );
  if (plannerCase) {
    ctx += `\n\n${plannerCase}`;
  }
  // Playbook: distilled procedure from same-shape completed tasks (at most
  // one, freshness-verified) — complements the single raw CBR case above.
  const plannerPlaybook = await observeWorkflowStage(taskId, 'context.buildPlaybookContext', () =>
    buildPlaybookContext(taskId, task, language),
  );
  if (plannerPlaybook) {
    ctx += `\n\n${plannerPlaybook}`;
  }
  if (research) {
    ctx += `\n\n${texts.researchHeader}\n\n${research}`;
  }
  ctx += `\n\n${texts.instruction}\n\n${texts.premortem}\n\n${texts.selfContainment}\n\n${questionFormat}`;
  // Align the planner with the subtask-split flag: '' when splitting is
  // enabled (CLAUDE.md Step 2.5 applies as-is), an explicit prohibition
  // when disabled (task 545 incident) — never concatenate the empty string.
  const splitDirective = buildSubtaskSplitDirective(language);
  if (splitDirective) {
    ctx += `\n\n${splitDirective}`;
  }
  ctx += `\n\n${styleRule}`;
  // prettier-ignore
  void recordContextMetrics(taskId, 'planner', mode, { taskInfo, critic: planCritic, lessons: planLessons, memory: plannerMemory, rejected, case: plannerCase, playbook: plannerPlaybook, research, styleRule });
  return ctx;
}
