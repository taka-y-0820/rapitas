/**
 * AgentKnowledgeSharing
 *
 * Injects learning results (success/failure patterns, prompt evolutions) from
 * previous agent executions as context for new agent runs.
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import {
  findRelevantPatterns,
  findRelevantKnowledgeForAgent,
  getLatestPromptEvolutions,
  generateWarnings,
  extractKeywords,
  inferTaskCategory,
  upsertPattern,
} from './agent-knowledge-sharing-lookup';

const log = createLogger('agent-knowledge-sharing');

interface SharedKnowledge {
  patterns: Array<{
    id: number;
    type: string;
    category: string;
    description: string;
    actions: string[];
    confidence: number;
    occurrences: number;
  }>;
  relevantKnowledge: Array<{
    id: number;
    title: string;
    content: string;
    category: string;
    confidence: number;
  }>;
  promptEvolutions: Array<{
    category: string;
    improvement: string;
    performanceDelta: number;
  }>;
  warnings: string[];
}

/**
 * Gather relevant learning patterns and knowledge as context before task execution.
 *
 * @param taskId - Target task ID / 対象タスクID
 * @param skipKnowledge - When true, returns an empty result without querying —
 *   used by the prompt A/B comparison runner to evaluate a "knowledge=without"
 *   arm without touching the real knowledge base. Defaults to false (current
 *   behavior, unchanged for all existing callers). / trueの場合クエリを行わず空を返す
 * @returns Shared knowledge context / 共有知識コンテキスト
 */
export async function gatherSharedKnowledge(
  taskId: number,
  skipKnowledge = false,
): Promise<SharedKnowledge> {
  const result: SharedKnowledge = {
    patterns: [],
    relevantKnowledge: [],
    promptEvolutions: [],
    warnings: [],
  };

  if (skipKnowledge) return result;

  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        theme: true,
        taskLabels: { include: { label: true } },
      },
    });

    if (!task) return result;

    result.patterns = await findRelevantPatterns(task);
    result.relevantKnowledge = await findRelevantKnowledgeForAgent(task);
    result.promptEvolutions = await getLatestPromptEvolutions();
    result.warnings = await generateWarnings(task);

    log.info(
      {
        taskId,
        patterns: result.patterns.length,
        knowledge: result.relevantKnowledge.length,
        evolutions: result.promptEvolutions.length,
        warnings: result.warnings.length,
      },
      'Shared knowledge gathered for task execution',
    );
  } catch (error) {
    log.error({ err: error, taskId }, 'Failed to gather shared knowledge');
  }

  return result;
}

/**
 * Convert shared knowledge into prompt text for injection during agent execution.
 */
export function formatKnowledgeContext(knowledge: SharedKnowledge): string {
  const sections: string[] = [];

  // Warnings take highest priority
  if (knowledge.warnings.length > 0) {
    sections.push(
      '⚠️ 過去の失敗パターンに基づく警告:\n' + knowledge.warnings.map((w) => `- ${w}`).join('\n'),
    );
  }

  const successPatterns = knowledge.patterns.filter((p) => p.type === 'success_strategy');
  if (successPatterns.length > 0) {
    sections.push(
      '✅ 過去の成功パターン:\n' +
        successPatterns
          .map(
            (p) =>
              `- ${p.description} (信頼度: ${Math.round(p.confidence * 100)}%, ${p.occurrences}回確認)`,
          )
          .join('\n'),
    );
  }

  if (knowledge.relevantKnowledge.length > 0) {
    sections.push(
      '📚 関連する既存ナレッジ:\n' +
        knowledge.relevantKnowledge
          .map((k) => `- [${k.category}] ${k.title}: ${k.content.slice(0, 150)}`)
          .join('\n'),
    );
  }

  // NOTE: promptEvolutions were fetched by gatherSharedKnowledge but never
  // rendered — a silent fetch-and-drop. Only measured improvements
  // (performanceDelta > 0) reach here, so surfacing them is safe.
  if (knowledge.promptEvolutions.length > 0) {
    sections.push(
      '🧬 効果が実証されたプロンプト改善:\n' +
        knowledge.promptEvolutions
          .map(
            (e) =>
              `- [${e.category}] ${e.improvement.slice(0, 200)} (改善幅: +${Math.round(e.performanceDelta * 100)}%)`,
          )
          .join('\n'),
    );
  }

  if (sections.length === 0) return '';

  return (
    '\n--- 学習データに基づくコンテキスト ---\n' +
    sections.join('\n\n') +
    '\n--- コンテキスト終了 ---\n'
  );
}

/**
 * Update learning patterns after agent execution completes.
 */
export async function updatePatternsFromExecution(
  taskId: number,
  success: boolean,
  executionId: number,
): Promise<void> {
  try {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: {
        taskLabels: { include: { label: true } },
      },
    });

    if (!task) return;

    const category = inferTaskCategory(
      task.title,
      task.taskLabels.map((tl) => tl.label.name),
    );

    if (success) {
      await upsertPattern({
        patternType: 'success_strategy',
        category,
        description: `${task.title}の実行パターン`,
        conditions: JSON.stringify({
          titleKeywords: extractKeywords(task.title),
          labels: task.taskLabels.map((tl) => tl.label.name),
          themeId: task.themeId,
        }),
        actions: JSON.stringify([`タスク「${task.title}」で成功した手法を適用`]),
        executionId,
      });
    } else {
      const execution = await prisma.agentExecution.findUnique({
        where: { id: executionId },
        select: { errorMessage: true },
      });

      await upsertPattern({
        patternType: 'failure_pattern',
        category,
        description: `${task.title}での失敗: ${execution?.errorMessage?.slice(0, 100) || '不明なエラー'}`,
        conditions: JSON.stringify({
          titleKeywords: extractKeywords(task.title),
          errorType: execution?.errorMessage?.slice(0, 50),
        }),
        actions: JSON.stringify(
          [
            '同様のタスクでは注意が必要',
            execution?.errorMessage ? `エラー内容: ${execution.errorMessage.slice(0, 200)}` : '',
          ].filter(Boolean),
        ),
        executionId,
      });
    }

    log.info({ taskId, success, executionId }, 'Patterns updated from execution');
  } catch (error) {
    log.error({ err: error, taskId }, 'Failed to update patterns from execution');
  }
}
