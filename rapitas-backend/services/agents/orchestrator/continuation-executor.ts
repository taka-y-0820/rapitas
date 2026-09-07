import { mergeFallbackSegmentTime } from './execution-attempt-metrics';
import { runMeasuredAgentAttempt } from './measured-agent-attempt';
/**
 * ContinuationExecutor
 *
 * Handles continuation execution after question responses.
 * Agent config building lives in continuation-agent-config.ts.
 * Resume failure fallbacks live in fallback-handler.ts.
 * Timeout handling lives in timeout-handler.ts.
 */
import { agentFactory } from '../agent-factory';
import type { AgentTask, AgentExecutionResult } from '../base-agent';
import { ExecutionFileLogger } from '../execution-file-logger';
import { createLogger } from '../../../config/logger';
import type {
  ExecutionOptions,
  ExecutionState,
  ActiveAgentInfo,
  OrchestratorContext,
} from './types';
import {
  createLogChunkManager,
  setupQuestionDetectedHandler,
  setupOutputHandler,
  saveExecutionResult,
  emitResultEvent,
  handleExecutionError,
} from './execution-helpers';
import { isSessionResumeFailure } from '../session-resume-detector';
import { applyTaskStatusFromWorkflow } from '../../workflow/apply-task-status-from-workflow';
import { handleResumeFailureFallbacks } from './fallback-handler';
import { buildContinuationAgentConfig } from './continuation-agent-config';
import { buildShutdownErrorMessage } from './shutdown-error';
import { withLlmCallScope, getLlmCallCount } from '../../../utils/llm-call-context';

const logger = createLogger('continuation-executor');

/**
 * Continue conversation (answer to question) - external API entry point.
 * Acquires continuation lock before delegating to the internal implementation.
 *
 * @param ctx - Orchestrator context / オーケストレーターコンテキスト
 * @param executionId - ID of the execution to continue / 継続する実行ID
 * @param response - User's response to the question / 質問へのユーザーの回答
 * @param options - Optional execution options / 任意の実行オプション
 * @returns Agent execution result / エージェント実行結果
 * @throws {Error} When execution not found or already running / 実行が見つからないか既に実行中の場合
 */
export async function executeContinuation(
  ctx: OrchestratorContext,
  executionId: number,
  response: string,
  options: Partial<ExecutionOptions> = {},
): Promise<AgentExecutionResult> {
  if (!ctx.tryAcquireContinuationLock(executionId, 'user_response')) {
    logger.info(
      `[ContinuationExecutor] Skipping continuation for execution ${executionId} - already being processed`,
    );
    return {
      success: false,
      output: '',
      errorMessage: 'This execution is already being processed',
    };
  }

  try {
    const execution = await ctx.prisma.agentExecution.findUnique({
      where: { id: executionId },
      include: { session: { include: { config: { include: { task: true } } } } },
    });

    if (!execution) {
      throw new Error(`Execution not found: ${executionId}`);
    }

    if (execution.status === 'running') {
      logger.info(`[ContinuationExecutor] Execution ${executionId} is already running, skipping`);
      return { success: false, output: '', errorMessage: 'Execution is already running' };
    }

    if (execution.status !== 'waiting_for_input') {
      logger.info(
        `[ContinuationExecutor] Execution ${executionId} is not waiting for input (status: ${execution.status})`,
      );
      return {
        success: false,
        output: '',
        errorMessage: `Execution is not waiting for input: ${execution.status}`,
      };
    }

    ctx.cancelQuestionTimeout(executionId);
    return await executeContinuationInternal(ctx, executionId, response, options);
  } catch (error) {
    throw error;
  } finally {
    ctx.releaseContinuationLock(executionId);
  }
}

/**
 * Continue conversation - when lock is already acquired by the caller.
 *
 * @param ctx - Orchestrator context / オーケストレーターコンテキスト
 * @param executionId - ID of the execution to continue / 継続する実行ID
 * @param response - User's response to the question / 質問へのユーザーの回答
 * @param options - Optional execution options / 任意の実行オプション
 * @returns Agent execution result / エージェント実行結果
 */
export async function executeContinuationWithLock(
  ctx: OrchestratorContext,
  executionId: number,
  response: string,
  options: Partial<ExecutionOptions> = {},
): Promise<AgentExecutionResult> {
  try {
    return await executeContinuationInternal(ctx, executionId, response, options);
  } finally {
    ctx.releaseContinuationLock(executionId);
  }
}

/**
 * Internal continuation implementation shared by executeContinuation,
 * executeContinuationWithLock, and timeout auto-continue.
 *
 * @param ctx - Orchestrator context / オーケストレーターコンテキスト
 * @param executionId - ID of the execution to continue / 継続する実行ID
 * @param response - Response string sent as the next agent message / 次のエージェントメッセージとして送る応答文字列
 * @param options - Optional execution options / 任意の実行オプション
 * @returns Agent execution result / エージェント実行結果
 * @throws {Error} When execution not found / 実行が見つからない場合
 */
export async function executeContinuationInternal(
  ctx: OrchestratorContext,
  executionId: number,
  response: string,
  options: Partial<ExecutionOptions> = {},
): Promise<AgentExecutionResult> {
  const execution = await ctx.prisma.agentExecution.findUnique({
    where: { id: executionId },
    include: { session: { include: { config: { include: { task: true } } } } },
  });

  if (!execution) {
    throw new Error(`Execution not found: ${executionId}`);
  }

  const task = execution.session.config?.task;
  const claudeSessionId = execution.claudeSessionId;
  logger.info(`[ContinuationExecutor] Resuming execution with claudeSessionId: ${claudeSessionId}`);

  // Resolve persisted agent config if set
  const dbConfig = execution.agentConfigId
    ? await ctx.prisma.aIAgentConfig.findUnique({ where: { id: execution.agentConfigId } })
    : null;

  const agentConfig = buildContinuationAgentConfig(execution, options, dbConfig);
  let agent = agentFactory.createAgent(agentConfig);
  const taskId = execution.session.config?.taskId || 0;

  const fileLogger = new ExecutionFileLogger(
    execution.id,
    execution.sessionId,
    taskId,
    task?.title || `Task ${taskId}`,
    agentConfig.type,
    agentConfig.name,
    agentConfig.modelId,
  );
  fileLogger.logExecutionStart(`[Continuation] User response: ${response.substring(0, 200)}`, {
    claudeSessionId,
    previousStatus: execution.status,
  });
  fileLogger.logQuestionAnswered(response, 'user');

  const state: ExecutionState = {
    executionId: execution.id,
    sessionId: execution.sessionId,
    agentId: agent.id,
    taskId,
    status: 'running',
    startedAt: new Date(),
    output: execution.output || '',
  };
  ctx.activeExecutions.set(execution.id, state);

  const agentInfo: ActiveAgentInfo = {
    agent,
    executionId: execution.id,
    sessionId: execution.sessionId,
    taskId,
    state,
    lastOutput: execution.output || '',
    lastSavedAt: new Date(),
    fileLogger,
  };
  ctx.activeAgents.set(execution.id, agentInfo);

  if (ctx.isShuttingDown) {
    ctx.activeAgents.delete(execution.id);
    ctx.activeExecutions.delete(execution.id);
    const shutdownMsg = buildShutdownErrorMessage('continue execution');
    fileLogger.logWarn(shutdownMsg);
    await fileLogger.flush();
    throw new Error(shutdownMsg);
  }

  setupQuestionDetectedHandler(agent, {
    prisma: ctx.prisma,
    executionId: execution.id,
    sessionId: execution.sessionId,
    taskId,
    state,
    fileLogger,
    existingClaudeSessionId: execution.claudeSessionId,
    emitEvent: (event) => ctx.emitEvent(event),
    startQuestionTimeout: (eid, tid, qk) => ctx.startQuestionTimeout(eid, tid, qk),
    getQuestionTimeoutInfo: (eid) => ctx.getQuestionTimeoutInfo(eid),
  });

  const existingLogs = await ctx.prisma.agentExecutionLog.findMany({
    where: { executionId: execution.id },
    orderBy: { sequenceNumber: 'desc' },
    take: 1,
  });

  const logManager = createLogChunkManager({
    prisma: ctx.prisma,
    executionId: execution.id,
    initialSequenceNumber: existingLogs.length > 0 ? existingLogs[0].sequenceNumber + 1 : 0,
  });

  setupOutputHandler(
    agent,
    {
      prisma: ctx.prisma,
      executionId: execution.id,
      sessionId: execution.sessionId,
      taskId,
      state,
      agentInfo,
      fileLogger,
      onOutput: options.onOutput,
      emitEvent: (event) => ctx.emitEvent(event),
    },
    logManager,
  );

  const continueMessage = `\n[継続] ユーザーからの回答を受け取りました。実行を継続します...\n`;
  state.output += continueMessage;

  await ctx.prisma.agentExecution.update({
    where: { id: execution.id },
    data: {
      status: 'running',
      question: null,
      questionType: null,
      questionDetails: null,
      output: state.output,
    },
  });

  try {
    // NOTE: Include the original task context so the agent knows to continue the task,
    // not just respond to the answer. Without this, the agent treats the user's answer
    // as the entire task and may immediately complete.
    const continuationPrompt = [
      `# 質問への回答を受け取りました。元のタスクの実行を継続してください。`,
      ``,
      `## 元のタスク`,
      `タイトル: ${task?.title || `Task ${taskId}`}`,
      task?.description ? `説明: ${task.description.slice(0, 500)}` : '',
      ``,
      `## ユーザーからの回答`,
      response,
      ``,
      `## 指示`,
      `上記の回答を踏まえて、元のタスクの実行を継続してください。`,
      `回答の確認だけで完了せず、タスク本来の作業を最後まで実行してください。`,
    ]
      .filter(Boolean)
      .join('\n');

    const agentTask: AgentTask = {
      id: taskId,
      title: task?.title || `Task ${taskId}`,
      description: continuationPrompt,
      workingDirectory: task?.workingDirectory || undefined,
    };

    let result = await withLlmCallScope(async () => {
      let r = await runMeasuredAgentAttempt(
        () => agent.execute(agentTask),
        fileLogger,
        () =>
          !ctx.isShuttingDown && !['cancelled', 'canceling', 'interrupted'].includes(state.status),
      );

      // Fallback on --resume failure
      if (isSessionResumeFailure(r, claudeSessionId)) {
        r = mergeFallbackSegmentTime(
          r,
          await handleResumeFailureFallbacks(
            ctx,
            agent,
            agentConfig,
            agentTask,
            agentInfo,
            execution,
            state,
            fileLogger,
            logManager,
            taskId,
            claudeSessionId!,
          ),
        );
      }

      // Merge Tier 2 (ALS sendAIMessage calls) into Tier 1 (CLI num_turns)
      const alsCount = getLlmCallCount();
      if (alsCount > 0) {
        r = { ...r, llmCallCount: (r.llmCallCount ?? 0) + alsCount };
      }
      return r;
    });

    await saveExecutionResult(
      ctx.prisma,
      execution.id,
      execution.sessionId,
      state,
      result,
      fileLogger,
      {
        artifacts: execution.artifacts,
        tokensUsed: execution.tokensUsed,
        executionTimeMs: execution.executionTimeMs,
        claudeSessionId: execution.claudeSessionId,
        cpuTimeMs: execution.cpuTimeMs,
        peakRssKb: execution.peakRssKb,
      },
    );
    emitResultEvent(result, execution.id, execution.sessionId, taskId, (event) =>
      ctx.emitEvent(event),
    );

    // NOTE: This is the gap that let a task's execution log read "completed"
    // while Task.status/workflowStatus silently sat stale — every OTHER
    // launch path (execute-route → execute-post-handler, continue-route →
    // continue-post-handler) runs an equivalent epilogue after the CLI exits;
    // this question-answer continuation path previously only called
    // saveExecutionResult (AgentExecution row only) and returned. Skip when
    // the agent asked ANOTHER question — the workflow is still paused, not
    // finished.
    if (!result.waitingForInput) {
      await applyTaskStatusFromWorkflow(ctx.prisma, taskId, '[ContinuationExecutor]');
    }

    return result;
  } catch (error) {
    await handleExecutionError(
      ctx.prisma,
      execution.id,
      execution.sessionId,
      taskId,
      state,
      error,
      fileLogger,
      (event) => ctx.emitEvent(event),
      'Continuation',
    );
    // Mirrors continue-post-handler.ts's handleContinueError: an uncaught
    // continuation failure must not leave the task stuck showing
    // 'in-progress' with no execution actually running.
    await ctx.prisma.task
      .update({ where: { id: taskId }, data: { status: 'todo' } })
      .catch((e: unknown) =>
        logger.error(
          { err: e },
          `[ContinuationExecutor] Failed to reset task ${taskId} to todo after error`,
        ),
      );
    throw error;
  } finally {
    await logManager.cleanup();
    await fileLogger.flush();
    ctx.activeExecutions.delete(execution.id);
    ctx.activeAgents.delete(execution.id);
    // NOTE: Remove agentInfo.agent (not the stale `agent` local), because
    // handleResumeFailureFallbacks swaps agentInfo.agent to a new agent
    // instance on --resume failure. Removing the original `agent` here left
    // every post-fallback agent permanently registered in AgentFactory's
    // activeAgents map (fallback-handler.ts only ever removes the *previous*
    // agent in its chain, never the final one it returns).
    await agentFactory.removeAgent(agentInfo.agent.id);
  }
}

// Re-export timeout handler for backward compatibility
export { handleQuestionTimeout } from './timeout-handler';
