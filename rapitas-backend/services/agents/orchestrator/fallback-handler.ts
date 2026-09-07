import { mergeFallbackSegmentTime } from './execution-attempt-metrics';
import { runMeasuredAgentAttempt } from './measured-agent-attempt';
/**
 * FallbackHandler
 *
 * Handles session resume failure fallback strategies for continuation execution.
 * Tries in order: --resume retry → --continue → new session with context.
 * Does NOT handle the primary continuation flow or timeout handling.
 */
import { agentFactory } from '../agent-factory';
import type { AgentConfigInput } from '../agent-factory';
import type { AgentTask, AgentExecutionResult } from '../base-agent';
import { ExecutionFileLogger } from '../execution-file-logger';
import { createLogger } from '../../../config/logger';
import type { ExecutionState, ActiveAgentInfo, OrchestratorContext } from './types';
import {
  createLogChunkManager,
  setupQuestionDetectedHandler,
  setupOutputHandler,
} from './execution-helpers';
import { isSessionResumeFailure } from '../session-resume-detector';

const logger = createLogger('fallback-handler');

/**
 * Wires up question-detected and output handlers on a fallback agent using the standard helpers.
 */
function attachFallbackHandlers(
  agent: ReturnType<typeof agentFactory.createAgent>,
  ctx: OrchestratorContext,
  executionId: number,
  sessionId: number,
  taskId: number,
  state: ExecutionState,
  agentInfo: ActiveAgentInfo,
  fileLogger: ExecutionFileLogger,
  logManager: ReturnType<typeof createLogChunkManager>,
  existingClaudeSessionId: string | null,
): void {
  setupQuestionDetectedHandler(agent, {
    prisma: ctx.prisma,
    executionId,
    sessionId,
    taskId,
    state,
    fileLogger,
    existingClaudeSessionId,
    emitEvent: (event) => ctx.emitEvent(event),
    startQuestionTimeout: (eid, tid, qk) => ctx.startQuestionTimeout(eid, tid, qk),
    getQuestionTimeoutInfo: (eid) => ctx.getQuestionTimeoutInfo(eid),
  });

  setupOutputHandler(
    agent,
    {
      prisma: ctx.prisma,
      executionId,
      sessionId,
      taskId,
      state,
      agentInfo,
      fileLogger,
      emitEvent: (event) => ctx.emitEvent(event),
    },
    logManager,
  );
}

/**
 * Orchestrates fallback attempts when the initial --resume call fails.
 * Sequence: --resume retry (after 3s delay) → --continue → new session with context.
 *
 * @param ctx - Orchestrator context / オーケストレーターコンテキスト
 * @param currentAgent - The failed agent instance to replace / 置き換える失敗したエージェントインスタンス
 * @param agentConfig - Agent configuration used for the original call / 元の呼び出しに使用したエージェント設定
 * @param agentTask - Task definition being executed / 実行中のタスク定義
 * @param agentInfo - Active agent tracking record / アクティブエージェント追跡レコード
 * @param execution - Execution DB record snapshot / 実行DBレコードスナップショット
 * @param state - Mutable execution state / 可変の実行状態
 * @param fileLogger - Execution file logger / 実行ファイルロガー
 * @param logManager - Chunk-based log manager / チャンクベースのログマネージャ
 * @param taskId - Task ID / タスクID
 * @param claudeSessionId - Original Claude session ID that failed / 失敗した元のClaudeセッションID
 * @returns Result from the first successful fallback attempt / 最初に成功したフォールバックの結果
 */
export async function handleResumeFailureFallbacks(
  ctx: OrchestratorContext,
  currentAgent: ReturnType<typeof agentFactory.createAgent>,
  agentConfig: AgentConfigInput,
  agentTask: AgentTask,
  agentInfo: ActiveAgentInfo,
  execution: {
    id: number;
    sessionId: number;
    claudeSessionId: string | null;
    output: string | null;
  },
  state: ExecutionState,
  fileLogger: ExecutionFileLogger,
  logManager: ReturnType<typeof createLogChunkManager>,
  taskId: number,
  claudeSessionId: string,
): Promise<AgentExecutionResult> {
  logger.info(`[FallbackHandler] Session resume failed. Retrying --resume after delay...`);
  fileLogger.logWarn(
    `Session resume failed with --resume ${claudeSessionId}. Retrying after 3s delay.`,
    { claudeSessionId, fallbackStage: 'resume_retry' },
  );

  await agentFactory.removeAgent(currentAgent.id);
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Retry with --resume
  const retryAgent = agentFactory.createAgent(agentConfig);
  attachFallbackHandlers(
    retryAgent,
    ctx,
    execution.id,
    execution.sessionId,
    taskId,
    state,
    agentInfo,
    fileLogger,
    logManager,
    execution.claudeSessionId,
  );
  agentInfo.agent = retryAgent;

  const retryMessage = `\n[セッション再開] --resume の再試行を行っています...\n`;
  state.output += retryMessage;
  ctx.emitEvent({
    type: 'execution_output',
    executionId: execution.id,
    sessionId: execution.sessionId,
    taskId,
    data: { output: retryMessage },
    timestamp: new Date(),
  });

  const retryResult = await runMeasuredAgentAttempt(
    () => retryAgent.execute(agentTask),
    fileLogger,
    () => !ctx.isShuttingDown && !['cancelled', 'canceling', 'interrupted'].includes(state.status),
  );
  if (!isSessionResumeFailure(retryResult, claudeSessionId)) {
    return retryResult;
  }

  // Fall back to --continue
  logger.info(`[FallbackHandler] --resume retry also failed. Attempting --continue...`);
  fileLogger.logWarn(`--resume retry also failed. Attempting --continue fallback.`, {
    claudeSessionId,
    fallbackStage: 'continue_fallback',
  });
  await agentFactory.removeAgent(retryAgent.id);

  const fallbackAgent = agentFactory.createAgent({
    ...agentConfig,
    resumeSessionId: undefined,
    continueConversation: true,
  });
  attachFallbackHandlers(
    fallbackAgent,
    ctx,
    execution.id,
    execution.sessionId,
    taskId,
    state,
    agentInfo,
    fileLogger,
    logManager,
    execution.claudeSessionId,
  );
  agentInfo.agent = fallbackAgent;

  const fallbackMessage = `\n[セッション再開] --resume が失敗したため、--continue で再試行しています...\n`;
  state.output += fallbackMessage;
  ctx.emitEvent({
    type: 'execution_output',
    executionId: execution.id,
    sessionId: execution.sessionId,
    taskId,
    data: { output: fallbackMessage },
    timestamp: new Date(),
  });

  const fallbackResult = await runMeasuredAgentAttempt(
    () => fallbackAgent.execute(agentTask),
    fileLogger,
    () => !ctx.isShuttingDown && !['cancelled', 'canceling', 'interrupted'].includes(state.status),
  );
  if (!isSessionResumeFailure(fallbackResult, claudeSessionId)) {
    return mergeFallbackSegmentTime(retryResult, fallbackResult);
  }

  // Final fallback: start new session with context
  logger.info(`[FallbackHandler] --continue also failed. Starting new session with context...`);
  fileLogger.logWarn(`--continue fallback also failed. Starting new session with context.`, {
    claudeSessionId,
    fallbackStage: 'new_session',
  });
  await agentFactory.removeAgent(fallbackAgent.id);

  const newAgent = agentFactory.createAgent({
    ...agentConfig,
    resumeSessionId: undefined,
    continueConversation: false,
  });
  attachFallbackHandlers(
    newAgent,
    ctx,
    execution.id,
    execution.sessionId,
    taskId,
    state,
    agentInfo,
    fileLogger,
    logManager,
    null,
  );
  agentInfo.agent = newAgent;

  const previousContext = (execution.output || '').slice(-2000);
  const contextPrompt = `以下は前回のタスク実行の継続です。前回のコンテキスト（最後の部分）:\n\n${previousContext}\n\n前回の質問に対するユーザーの回答: ${agentTask.title}\n\n上記の回答を踏まえて、タスクの実行を継続してください。`;

  const newSessionMessage = `\n[セッション再開] 新しいセッションでコンテキストを引き継いで実行を継続します...\n`;
  state.output += newSessionMessage;
  ctx.emitEvent({
    type: 'execution_output',
    executionId: execution.id,
    sessionId: execution.sessionId,
    taskId,
    data: { output: newSessionMessage },
    timestamp: new Date(),
  });

  const finalResult = await runMeasuredAgentAttempt(
    () =>
      newAgent.execute({
        id: taskId,
        title: contextPrompt,
        description: contextPrompt,
        workingDirectory: agentTask.workingDirectory,
      }),
    fileLogger,
    () => !ctx.isShuttingDown && !['cancelled', 'canceling', 'interrupted'].includes(state.status),
  );
  return mergeFallbackSegmentTime(
    mergeFallbackSegmentTime(retryResult, fallbackResult),
    finalResult,
  );
}
