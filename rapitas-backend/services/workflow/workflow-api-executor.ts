/**
 * Workflow API Executor
 *
 * Calls API-type workflow agents (anthropic-api, openai, azure-openai) directly,
 * receives text output, persists the execution record in the database, and saves
 * the resulting workflow file. Does not spawn subprocesses.
 */
import { prisma } from '../../config';
import { createLogger } from '../../config/logger';
import { writeWorkflowFile } from './workflow-file-utils';
import { callAnthropicAPI, callOpenAIAPI, decryptApiKey } from './workflow-api-callers';
import { resolveTaskWithTheme } from '../task/task-resolver';
import type { RoleTransition, WorkflowAdvanceResult } from './workflow-types';
import { assessComplexity } from '../local-llm/complexity-assessor';
import { sendAIMessage } from '../../utils/ai-client';
import { writeBlockedStatusDurable } from './durable-blocked-write';

const log = createLogger('workflow-api-executor');

/**
 * Call an API agent directly, receive text output, and save the workflow file on its behalf.
 *
 * @param taskId - Task being processed. / 処理中のタスクID
 * @param task - Task title and description. / タスクのタイトルと説明
 * @param agentConfig - Agent configuration including API key and endpoint. / APIキーとエンドポイントを含むエージェント設定
 * @param systemPrompt - System prompt content. / システムプロンプト内容
 * @param context - Role context assembled by buildRoleContext. / buildRoleContextで組み立てられたロールコンテキスト
 * @param transition - Current role transition definition. / 現在のロール遷移定義
 * @param language - Output language. / 出力言語
 * @param advanceWorkflow - Callback to start the next phase (for auto-advance). / 次フェーズを開始するコールバック
 * @param getOrCreateDevConfig - Callback to resolve the dev config record. / devConfigレコードを解決するコールバック
 * @returns Phase execution result. / フェーズ実行結果
 * @throws Re-throws API errors after recording the failure in the DB. / DB記録後にAPIエラーを再スロー
 */
/**
 * Write an execution's terminal state AND record it in the learning ledger.
 *
 * Every terminal write in this file goes through here. The API path updates the
 * execution row directly and never calls `saveExecutionResult`, so a bare update
 * leaves the run absent from `WorkflowLearningRecord` — an outcome that happened
 * but was never learned from.
 *
 * @param executionId - Execution reaching its terminal state. / 終端に達する実行ID
 * @param status - Terminal status to write. / 書き込む終端ステータス
 * @param data - Additional columns to write alongside it. / 併せて書き込む列
 */
async function finalizeExecution(
  executionId: number,
  status: 'completed' | 'failed',
  data: Record<string, unknown>,
): Promise<void> {
  await prisma.agentExecution.update({ where: { id: executionId }, data: { status, ...data } });
  try {
    const { recordExecutionOutcome } = await import('../self-learning/workflow-learning-recorder');
    await recordExecutionOutcome(prisma as never, executionId, status);
  } catch {
    // Ledger bookkeeping must never fail the run it is describing.
  }
}

export async function executeAPIAgent(
  taskId: number,
  task: { title: string; description: string | null },
  agentConfig: {
    id: number;
    agentType: string;
    name: string;
    modelId: string | null;
    apiKeyEncrypted: string | null;
    endpoint: string | null;
  },
  systemPrompt: string,
  context: string,
  transition: RoleTransition,
  language: 'ja' | 'en',
  advanceWorkflow: (taskId: number, language: 'ja' | 'en') => Promise<WorkflowAdvanceResult>,
  getOrCreateDevConfig: (taskId: number) => Promise<{ id: number }>,
): Promise<WorkflowAdvanceResult> {
  const devConfig = await getOrCreateDevConfig(taskId);
  const session = await prisma.agentSession.create({
    data: { configId: devConfig.id, mode: `workflow-${transition.role}`, status: 'active' },
  });

  const execution = await prisma.agentExecution.create({
    data: {
      sessionId: session.id,
      agentConfigId: agentConfig.id,
      command: `[workflow-${transition.role}] ${task.title}`,
      status: 'running',
    },
  });

  // Same claim as the CLI path (task-executor.ts): the routing decision is
  // recorded before this row exists, so it carries no executionId and the
  // consistency checker cannot join it to an outcome. Best-effort.
  void import('../observability/decision-trace/execution-linker')
    .then(({ linkPendingDecisions }) => linkPendingDecisions(taskId, execution.id))
    .catch(() => {});

  try {
    let apiKey = '';
    if (agentConfig.apiKeyEncrypted) {
      apiKey = await decryptApiKey(agentConfig.apiKeyEncrypted);
    }

    // NOTE: Include theme workingDirectory in context so the API agent
    // generates code paths relative to the target project, not rapitas.
    const taskWithTheme = await resolveTaskWithTheme(taskId);
    const themeWorkDir = taskWithTheme?.theme?.workingDirectory || null;

    const languageInstructions = {
      ja: 'すべての出力を日本語で記述してください。',
      en: 'Write all output in English.',
    };
    let enhancedSystemPrompt = systemPrompt + '\n\n' + languageInstructions[language];

    if (themeWorkDir && transition.role === 'implementer') {
      enhancedSystemPrompt += `\n\n## 作業ディレクトリ\nこのタスクの実装は以下のディレクトリで行ってください: ${themeWorkDir}\nrapitasプロジェクト内にファイルを作成しないでください。`;
    }

    let output = '';
    const startTime = Date.now();

    // NOTE: Complexity-based local LLM routing — low-complexity researcher/verifier phases
    // use Ollama with RAG to reduce API costs while maintaining quality.
    const complexity = assessComplexity(task, transition.role, context.length);

    if (complexity.canUseLocalLLM) {
      log.info(
        { role: transition.role, score: complexity.score, reasons: complexity.reasons },
        '[WorkflowAPIExecutor] Delegating to local LLM (low complexity)',
      );
      try {
        const localResponse = await sendAIMessage({
          provider: 'ollama',
          messages: [{ role: 'user', content: context }],
          systemPrompt: enhancedSystemPrompt,
          maxTokens: 4096,
          enableRAG: true,
          skipCache: false,
        });
        output = localResponse.content;
      } catch (localError) {
        // NOTE: Fall through to paid API if local LLM fails.
        log.warn(
          { err: localError },
          '[WorkflowAPIExecutor] Local LLM failed, falling back to paid API',
        );
        output = '';
      }
    }

    if (!output) {
      if (agentConfig.agentType === 'anthropic-api') {
        output = await callAnthropicAPI(
          apiKey,
          agentConfig.modelId || 'claude-sonnet-4-20250514',
          enhancedSystemPrompt,
          context,
        );
      } else if (agentConfig.agentType === 'openai') {
        output = await callOpenAIAPI(
          apiKey,
          agentConfig.modelId || 'gpt-4o',
          enhancedSystemPrompt,
          context,
        );
      } else if (agentConfig.agentType === 'azure-openai') {
        output = await callOpenAIAPI(
          apiKey,
          agentConfig.modelId || 'gpt-4o',
          enhancedSystemPrompt,
          context,
          agentConfig.endpoint || undefined,
        );
      } else {
        throw new Error(`未対応のAPIエージェントタイプ: ${agentConfig.agentType}`);
      }
    }

    const executionTimeMs = Date.now() - startTime;
    let repairEntryStatus: WorkflowAdvanceResult['status'] | undefined;

    if (transition.outputFile && output.trim()) {
      // Critic-rejection guard: mirror the CLI executor — if the phase critic
      // already bounced this phase's artifact while the API call was running,
      // saving the output would resurrect the rejected content.
      const { criticRejectedSince } = await import('./phase-critic/critic-rejection-guard');
      if (await criticRejectedSince(taskId, transition.outputFile, new Date(startTime))) {
        log.warn(
          { taskId, role: transition.role, outputFile: transition.outputFile },
          '[WorkflowAPIExecutor] Critic rejected this artifact mid-run — skipping save (would resurrect the rejected content)',
        );
        await finalizeExecution(execution.id, 'completed', {
          output: output.substring(0, 10000),
          executionTimeMs,
        }).catch(() => {});
        await prisma.agentSession
          .update({
            where: { id: session.id },
            data: {
              status: 'completed',
              completedAt: new Date(),
              errorMessage:
                '品質批評ゲートが成果物を差し戻したため、この実行の保存はスキップされました。',
            },
          })
          .catch(() => {});
        return {
          success: false,
          role: transition.role,
          status: transition.nextStatus,
          error: 'Phase critic rejected the artifact; a regeneration run will replace it.',
          executionId: execution.id,
        };
      }
      // Strip any stray ANSI/log noise before persisting. API agents return text
      // directly (not stdout), so contamination is rare — fall back to the raw
      // output when the sanitiser finds no report rather than dropping a valid
      // response. The CLI path (the real contamination source) is stricter.
      const { extractMarkdownFromOutput } = await import('./workflow-file-utils');
      const cleaned = extractMarkdownFromOutput(output, transition.outputFile) ?? output;
      const persistedOutput = await writeWorkflowFile(taskId, transition.outputFile, cleaned);

      // verify.md honesty gate + self-repair — API agents save directly here
      // (bypassing the workflow file HTTP handler), so without this they could
      // advance a hallucinated "all pass" verify.md straight to verify_done and
      // auto-PR. Mirror the CLI path: validate, and on failure bounce back to
      // the implementer (bounded) instead of advancing.
      let resolvedNextStatus: string = transition.nextStatus;
      if (transition.outputFile === 'verify') {
        const { validateVerify } = await import('./phase-output-validator');
        const verifyValidation = validateVerify(persistedOutput);
        if (!verifyValidation.ok && verifyValidation.severity >= 80) {
          const { attemptVerifyRepair } = await import('./verify-self-repair');
          // CAS snapshot: the repair's compare-and-swap needs the status the
          // task is ACTUALLY at right now (the verifier's entry status —
          // transition.nextStatus is not persisted yet at this point, so
          // passing it would make every legitimate bounce read as stale).
          const live = await prisma.task
            .findUnique({ where: { id: taskId }, select: { workflowStatus: true } })
            .catch(() => null);
          const repair = await attemptVerifyRepair(
            taskId,
            live?.workflowStatus ?? null,
            verifyValidation.summary,
            persistedOutput,
          );
          if (repair.bounced && repair.newStatus) {
            resolvedNextStatus = repair.newStatus;
            repairEntryStatus = repair.newStatus as WorkflowAdvanceResult['status'];
          } else if (repair.stale) {
            // The workflow moved past the evaluated status while this verdict
            // was computed — do not advance to verify_done AND do not block.
            log.warn(
              { taskId, summary: verifyValidation.summary },
              '[WorkflowAPIExecutor] stale verify failure — workflow moved on; skipping block',
            );
            await finalizeExecution(execution.id, 'completed', {
              output: output.substring(0, 10000),
              executionTimeMs,
            }).catch(() => {});
            return {
              success: false,
              role: transition.role,
              status: transition.nextStatus,
              error: '検証結果が古いため適用しませんでした（ワークフローは先へ進んでいます）',
            };
          } else {
            // Exhausted — block; do NOT advance to verify_done. This write is
            // what actually STOPS the verify self-repair loop, so a swallowed
            // failure here (mirroring the workflow-orchestrator plan-replan
            // incident) could let it re-enter on the next poll. Retry once,
            // then notify a human on continued failure.
            await writeBlockedStatusDurable({
              taskId,
              log,
              source: 'WorkflowAPIExecutor',
              notification: {
                title: 'ブロック処理の書き込みに失敗',
                message: `タスク #${taskId} を blocked にする更新が2回失敗しました（検証自己修復の上限到達）。手動確認が必要です。`,
              },
            });
            await finalizeExecution(execution.id, 'completed', {
              output: output.substring(0, 10000),
              executionTimeMs,
            }).catch(() => {});
            await prisma.agentSession
              .update({
                where: { id: session.id },
                data: {
                  status: 'failed',
                  completedAt: new Date(),
                  errorMessage: `検証に失敗したためブロックしました: ${verifyValidation.summary}`,
                },
              })
              .catch(() => {});
            return {
              success: false,
              role: transition.role,
              status: transition.nextStatus,
              error: verifyValidation.summary,
              executionId: execution.id,
            };
          }
        }
      }

      // The repair transaction already committed this exact version and its queue receipt.
      if (!repairEntryStatus)
        await prisma.task.update({
          where: { id: taskId },
          data: { workflowStatus: resolvedNextStatus },
        });
    } else if (transition.outputFile) {
      throw new Error(`${transition.outputFile}.md was not generated`);
    } else {
      await prisma.task.update({
        where: { id: taskId },
        data: { workflowStatus: transition.nextStatus },
      });
    }

    await finalizeExecution(execution.id, 'completed', {
      output: output.substring(0, 10000), // Truncate to 10000 chars for DB
      executionTimeMs,
    });
    await prisma.agentSession.update({
      where: { id: session.id },
      data: { status: 'completed', completedAt: new Date() },
    });

    const finalResult: WorkflowAdvanceResult = {
      success: true,
      role: transition.role,
      status: repairEntryStatus ?? transition.nextStatus,
      output: output.substring(0, 2000), // Truncate to 2000 chars for response
      executionId: execution.id,
    };

    if (transition.role === 'implementer') {
      log.info('[WorkflowAPIExecutor] Implementer done, auto-starting verifier...');
      // NOTE: 1s delay to ensure DB updates have committed before the next phase reads them.
      // The rejection handler lives INSIDE the callback — a try/catch around
      // setTimeout() itself never observes a rejection from the async callback,
      // since that callback runs later, after this function has already returned.
      // Wrapping the outer call instead silently dropped auto-advance failures
      // as unhandled promise rejections.
      setTimeout(() => {
        advanceWorkflow(taskId, language).catch((error) => {
          log.error({ err: error }, '[WorkflowAPIExecutor] Failed to auto-advance to verifier');
        });
      }, 1000);
    }

    return finalResult;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await finalizeExecution(execution.id, 'failed', { output: `Error: ${errorMessage}` });
    await prisma.agentSession.update({
      where: { id: session.id },
      data: { status: 'completed', completedAt: new Date() },
    });
    throw error;
  }
}
