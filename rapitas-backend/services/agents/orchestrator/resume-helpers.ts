/**
 * Resume Helpers
 *
 * Utility functions for building resume prompts and resolving agent configurations
 * from the database. Used exclusively by execution-resume.ts.
 */

import { narrowAgentType } from '../agent-factory';
import type { AgentConfigInput } from '../agent-factory';
import { resolveStoredSecret } from '../../../utils/common/secret-store';
import { createLogger } from '../../../config';
import type { OrchestratorContext } from './types';

const logger = createLogger('resume-helpers');

/**
 * Builds a resume prompt with context from the previous execution.
 *
 * @param task - Task record / タスクレコード
 * @param lastOutput - Tail of previous output / 前回出力の末尾
 * @param logSummary - Recent log entries / 最近のログエントリ
 * @param errorMessage - Interruption reason if any / 中断理由
 * @param workflowStatus - Current task workflowStatus, if known / 現在のタスクworkflowStatus
 * @returns Formatted prompt string / フォーマット済みプロンプト
 */
export function buildResumePrompt(
  task: { title: string; description: string | null },
  lastOutput: string,
  logSummary: string,
  errorMessage: string | null,
  workflowStatus?: string | null,
): string {
  let prompt = `# 作業再開

このタスクは以前のセッションで中断されました。作業を途中から再開してください。

## タスク情報
- タイトル: ${task.title}
- 説明: ${task.description || 'なし'}

## 前回の作業状況
以下は中断前の出力の最後の部分です：

\`\`\`
${lastOutput}
\`\`\`
`;

  // NOTE: logSummary was accepted as a parameter but never appended to the
  // prompt — the caller's last-50-chunk execution log context was silently
  // dropped, leaving the resumed agent without the log detail the parameter
  // exists to provide. Restored.
  if (logSummary.trim()) {
    prompt += `
## 直近のログ
\`\`\`
${logSummary}
\`\`\`
`;
  }

  if (errorMessage) {
    prompt += `
## 中断理由
${errorMessage}
`;
  }

  if (workflowStatus) {
    prompt += `
## 現在のワークフロー状態
このタスクの現在の workflowStatus は \`${workflowStatus}\` です。中断前に想定していたフェーズと異なっている可能性があります。
`;
  }

  prompt += `
## 指示
上記の情報を基に、中断されたタスクを続行してください。
- 既に完了した作業は繰り返さないでください
- 中断された地点から作業を再開してください
- ファイルを保存する前に、必ず GET /workflow/tasks/{タスクID}/files で現在保存済みの内容と workflowStatus を確認してください。直前の保存が拒否された場合は、同じ内容を再送信せず、エラーメッセージの指示に従ってください
- 不明な点があれば質問してください
`;

  return prompt;
}

/**
 * Resolves agent configuration from the database, decrypting the API key if present.
 * @returns Resolved AgentConfigInput, or fallback if DB record is missing / DB設定またはフォールバック
 */
export async function resolveAgentConfig(
  ctx: OrchestratorContext,
  agentConfigId: number,
  fallback: AgentConfigInput,
  resumeSessionId: string | null,
): Promise<AgentConfigInput> {
  const dbConfig = await ctx.prisma.aIAgentConfig.findUnique({
    where: { id: agentConfigId },
  });
  if (!dbConfig) {
    return fallback;
  }

  let decryptedApiKey: string | undefined;
  if (dbConfig.apiKeyEncrypted) {
    try {
      decryptedApiKey = resolveStoredSecret(dbConfig.apiKeyEncrypted) ?? undefined;
    } catch (e) {
      logger.error(
        { err: e, agentId: dbConfig.id },
        `[ResumeHelpers] Failed to decrypt API key for agent`,
      );
    }
  }

  return {
    type: narrowAgentType(dbConfig.agentType),
    name: dbConfig.name,
    endpoint: dbConfig.endpoint || undefined,
    apiKey: decryptedApiKey,
    modelId: dbConfig.modelId || undefined,
    workingDirectory: fallback.workingDirectory,
    timeout: fallback.timeout,
    dangerouslySkipPermissions: true,
    yoloMode: true,
    resumeSessionId: resumeSessionId || undefined,
    continueConversation: false,
  };
}
