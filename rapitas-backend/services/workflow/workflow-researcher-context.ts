/**
 * Workflow Researcher Context
 *
 * Assembles the prompt context string for the researcher role (memory,
 * hypothesis ledger, critic feedback/lessons, mode directive, playbook).
 * Does not build contexts for other roles.
 */
import { observeWorkflowStage } from './workflow-stage-timing';
import { buildMemoryContext } from './workflow-memory-context';
import { buildHypothesisContext } from './workflow-hypothesis-context';
import { buildPlaybookContext } from '../memory/playbook/playbook-inject';
import { buildCriticFeedback, buildCriticLessonsSection } from './phase-critic';
import { recordContextMetrics } from './workflow-context-metrics';
import { researchModeDirective } from './workflow-mode-directives';
import type { ResearcherTexts } from './workflow-role-prompts';

/**
 * Build the researcher role's prompt context.
 *
 * @param taskId - Task id used to read prior artifacts and record metrics. / タスクID
 * @param task - Task title and description. / タスクのタイトルと説明
 * @param language - Output language. / 出力言語
 * @param mode - Resolved workflow mode. / 解決済みワークフローモード
 * @param taskInfo - Pre-built task-info block. / タスク情報ブロック
 * @param texts - Researcher prompt texts for the language. / researcher用テキスト
 * @param questionFormat - question.md format guidance block. / question.md フォーマット規約
 * @param styleRule - Report style rule block. / 文体ルールブロック
 * @returns Assembled researcher context string. / researcher用コンテキスト文字列
 */
export async function buildResearcherContext(
  taskId: number,
  task: { title: string; description: string | null },
  language: 'ja' | 'en',
  mode: 'lightweight' | 'standard' | 'comprehensive',
  taskInfo: string,
  texts: ResearcherTexts,
  questionFormat: string,
  styleRule: string,
): Promise<string> {
  // Inject prior knowledge so research starts from what we already learned
  // (similar tasks, past concerns, lessons) instead of a blank slate.
  const memory = await observeWorkflowStage(taskId, 'context.buildMemoryContext', () =>
    buildMemoryContext(taskId, task, language),
  );
  const memoryBlock = memory ? `\n\n${memory}` : '';
  // Hypothesis ledger: surface open conjectures to test + proven findings, and
  // tell the researcher to record evidence / file new hypotheses as it learns.
  const hypothesis = await buildHypothesisContext(taskId, language);
  const hypothesisBlock = hypothesis ? `\n\n${hypothesis}` : '';
  // On a critic-gate bounce, lead with the issues the prior research missed.
  const critic = await buildCriticFeedback(taskId, 'research', language);
  const criticBlock = critic ? `\n\n${critic}` : '';
  // Cross-task learning loop: recurring critic findings from PAST tasks,
  // injected BEFORE generation so known misses are prevented instead of
  // bounced (the gate stays for novel misses).
  const lessons = await observeWorkflowStage(taskId, 'context.buildCriticLessonsSection', () =>
    buildCriticLessonsSection('research', language),
  );
  const lessonsBlock = lessons ? `\n\n${lessons}` : '';
  // Mode-aware framing: in lightweight mode NO plan phase follows, so research
  // must be implementation-ready; in plan modes research can defer detailed
  // steps to the planner. Without this, research.md was always written
  // assuming a plan would follow — wrong for lightweight tasks.
  const modeBlock = `\n\n${researchModeDirective(mode, language)}`;
  // Playbook: at most ONE freshness-verified procedure doc distilled from
  // past same-shape completed tasks — research starts from experience.
  const playbook = await observeWorkflowStage(taskId, 'context.buildPlaybookContext', () =>
    buildPlaybookContext(taskId, task, language),
  );
  const playbookBlock = playbook ? `\n\n${playbook}` : '';
  // prettier-ignore
  void recordContextMetrics(taskId, 'researcher', mode, { taskInfo, critic: criticBlock, lessons: lessonsBlock, mode: modeBlock, memory: memoryBlock, playbook: playbookBlock, hypothesis: hypothesisBlock, styleRule });
  return `${taskInfo}${criticBlock}${lessonsBlock}${modeBlock}${memoryBlock}${playbookBlock}${hypothesisBlock}\n\n${texts.instruction}\n\n${texts.premiseAudit}\n\n${texts.items}\n\n${texts.output}\n\n${questionFormat}\n\n${styleRule}`;
}
