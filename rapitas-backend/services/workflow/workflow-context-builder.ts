/**
 * Workflow Context Builder
 *
 * Assembles the prompt context string passed to each workflow role's agent.
 * Reads previously created workflow files and combines them with task metadata
 * and role-specific instructions. Does not execute agents or write files.
 *
 * NOTE: Thin dispatcher (task 626 split) — the per-role assembly lives in
 * workflow-<role>-context.ts, static prompt texts in workflow-role-prompts.ts,
 * and mode directives in workflow-mode-directives.ts. This file keeps the
 * public API (`buildRoleContext` / `researchModeDirective` /
 * `applyPlanModeDirective`) importable from its original path.
 */
import type { WorkflowRole } from './workflow-types';
// NOTE: Style rules live in their own module (this file is over the size
// limit); they only ADD constraints — the machine-parsed verdict vocabulary in
// the role instructions below stays byte-identical.
import { REPORT_STYLE_RULE } from './workflow-style-rule';
import { buildRoleTexts } from './workflow-role-prompts';
import { buildResearcherContext } from './workflow-researcher-context';
import { buildPlannerContext } from './workflow-planner-context';
import { buildImplementerContext } from './workflow-implementer-context';
import { buildVerifierContext } from './workflow-verifier-context';

export { researchModeDirective, applyPlanModeDirective } from './workflow-mode-directives';

/**
 * Build the prompt context string appropriate for the given workflow role.
 *
 * Each role receives a tailored prompt that includes task metadata and any
 * previously generated workflow artifacts (research.md, plan.md, etc.).
 *
 * @param taskId - The task ID; also used to read prior workflow artifacts. / コンテキスト参照用タスクID（既存成果物の取得にも使用）
 * @param role - The workflow role about to execute. / 実行するワークフロールール
 * @param task - Task title and description. / タスクのタイトルと説明
 * @param language - Output language for instructions. / 指示の出力言語
 * @returns Assembled context string ready to be appended to the agent prompt. / エージェントプロンプトに付加するコンテキスト文字列
 */
export async function buildRoleContext(
  taskId: number,
  role: WorkflowRole,
  task: { title: string; description: string | null; acceptanceCriteria?: string | null },
  language: 'ja' | 'en' = 'ja',
  mode: 'lightweight' | 'standard' | 'comprehensive' = 'comprehensive',
): Promise<string> {
  const t = buildRoleTexts(taskId, task, language);
  const taskInfo = t.taskInfo;
  const styleRule = REPORT_STYLE_RULE[language];

  switch (role) {
    case 'researcher':
      return buildResearcherContext(
        taskId,
        task,
        language,
        mode,
        taskInfo,
        t.researcher,
        t.questionFormat,
        styleRule,
      );

    case 'planner':
      return buildPlannerContext(
        taskId,
        task,
        language,
        mode,
        taskInfo,
        t.planner,
        t.questionFormat,
        styleRule,
      );

    case 'implementer':
      return buildImplementerContext(
        taskId,
        task,
        language,
        mode,
        taskInfo,
        t.implementer,
        t.questionFormat,
        styleRule,
      );

    // NOTE: auto_verifier shares the verifier context — the shared builder
    // receives the dynamic `role` param (not a literal 'verifier') so both
    // role strings are measured under their own name. See
    // workflow-verifier-context.ts for the full rationale.
    case 'auto_verifier':
    case 'verifier':
      return buildVerifierContext(
        taskId,
        role,
        task,
        language,
        mode,
        taskInfo,
        t.verifier,
        styleRule,
      );

    default:
      return taskInfo;
  }
}
