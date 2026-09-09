/**
 * TaskExecutor
 *
 * Handles the execution logic for new tasks.
 */
import { ExecutionCancelledError } from '../execution-cancelled-error';
import { agentFactory } from '../agent-factory';
import { resolveAgentConfig } from './task-agent-config';
import type { AgentConfigInput } from '../agent-factory';
import type { AgentTask, AgentExecutionResult, BaseAgent } from '../base-agent';
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
  type LogChunkManager,
} from './execution-helpers';
import { buildShutdownErrorMessage } from './shutdown-error';
import { checkNeedsFallback } from './fallback-decision';
import { isSessionResumeFailure } from '../session-resume-detector';
import { executeWithFallbackAgent } from './fallback-executor';
import { startExecutionHeartbeat, stopExecutionHeartbeat } from './execution-heartbeat';
import { EXECUTION_OWNER_ID } from '../execution-owner';

import { appendEvent } from '../../memory/timeline';
import { memoryTaskQueue } from '../../memory';
import { buildTaskRAGContext } from '../../memory/rag/context-builder';
import { withLlmCallScope, getLlmCallCount } from '../../../utils/llm-call-context';

const logger = createLogger('task-executor');

/** Execution setup result containing all initialized resources */
interface ExecutionSetup {
  execution: { id: number };
  state: ExecutionState;
  agentInfo: ActiveAgentInfo;
  fileLogger: ExecutionFileLogger;
  logManager: LogChunkManager;
}

/**
 * Create execution record, state, and logger resources.
 */
async function createExecutionResources(
  ctx: OrchestratorContext,
  agent: BaseAgent,
  agentConfig: AgentConfigInput,
  resolvedAgentConfigId: number | undefined,
  task: AgentTask,
  options: ExecutionOptions,
): Promise<ExecutionSetup> {
  const execution = await ctx.prisma.agentExecution.create({
    data: {
      sessionId: options.sessionId,
      agentConfigId: resolvedAgentConfigId,
      command: task.description || task.title,
      status: 'pending',
      // Lease from birth: a row is never observable without an owner and a
      // fresh heartbeat, so the dead-lease sweeper needs no createdAt grace.
      ownerId: EXECUTION_OWNER_ID,
      heartbeatAt: new Date(),
    },
  });
  startExecutionHeartbeat(ctx.prisma, execution.id);

  // Claim the decisions that produced this run. The router picks the model
  // before this row exists, so recordDecision writes no executionId and the
  // consistency checker — which joins on it — discarded every trace on sight
  // (measured: 479/479 skipped as 「実行IDが未記録のため評価対象外」). Best-effort:
  // observability must never be able to fail a dispatch.
  void import('../../observability/decision-trace/execution-linker')
    .then(({ linkPendingDecisions }) => linkPendingDecisions(options.taskId, execution.id))
    .catch(() => {});

  const state: ExecutionState = {
    executionId: execution.id,
    sessionId: options.sessionId,
    agentId: agent.id,
    taskId: options.taskId,
    status: 'idle',
    startedAt: new Date(),
    output: '',
  };
  ctx.activeExecutions.set(execution.id, state);

  const fileLogger = new ExecutionFileLogger(
    execution.id,
    options.sessionId,
    options.taskId,
    task.title,
    agentConfig.type,
    agentConfig.name,
    agentConfig.modelId,
  );

  fileLogger.logExecutionStart(task.description || task.title, {
    workingDirectory: options.workingDirectory,
    timeout: options.timeout,
    requireApproval: options.requireApproval,
    agentConfigId: options.agentConfigId,
    hasAnalysisInfo: !!options.analysisInfo,
  });

  const agentInfo: ActiveAgentInfo = {
    agent,
    executionId: execution.id,
    sessionId: options.sessionId,
    taskId: options.taskId,
    state,
    lastOutput: '',
    lastSavedAt: new Date(),
    fileLogger,
  };
  ctx.activeAgents.set(execution.id, agentInfo);

  const logManager = createLogChunkManager({
    prisma: ctx.prisma,
    executionId: execution.id,
    initialSequenceNumber: 0,
  });

  return { execution, state, agentInfo, fileLogger, logManager };
}

/**
 * Setup event handlers for agent output and question detection.
 */
function setupAgentHandlers(
  ctx: OrchestratorContext,
  agent: BaseAgent,
  setup: ExecutionSetup,
  options: ExecutionOptions,
): void {
  const { execution, state, agentInfo, fileLogger, logManager } = setup;

  setupQuestionDetectedHandler(agent, {
    prisma: ctx.prisma,
    executionId: execution.id,
    sessionId: options.sessionId,
    taskId: options.taskId,
    state,
    fileLogger,
    emitEvent: (event) => ctx.emitEvent(event),
    startQuestionTimeout: (eid, tid, qk) => ctx.startQuestionTimeout(eid, tid, qk),
    getQuestionTimeoutInfo: (eid) => ctx.getQuestionTimeoutInfo(eid),
  });

  setupOutputHandler(
    agent,
    {
      prisma: ctx.prisma,
      executionId: execution.id,
      sessionId: options.sessionId,
      taskId: options.taskId,
      state,
      agentInfo,
      fileLogger,
      onOutput: options.onOutput,
      emitEvent: (event) => ctx.emitEvent(event),
    },
    logManager,
  );
}

/**
 * Load previous execution output for continuation mode.
 */
async function loadPreviousOutput(
  ctx: OrchestratorContext,
  executionId: number,
  options: ExecutionOptions,
): Promise<string> {
  if (!options.continueFromPrevious || !options.sessionId) {
    return '';
  }

  try {
    const previousExecution = await ctx.prisma.agentExecution.findFirst({
      where: {
        sessionId: options.sessionId,
        id: { not: executionId },
      },
      orderBy: { createdAt: 'desc' },
      select: { output: true },
    });

    if (previousExecution?.output) {
      logger.info(
        `[TaskExecutor] Previous execution output loaded for continuation (${previousExecution.output.length} chars)`,
      );
      return previousExecution.output;
    }
  } catch (error) {
    logger.error({ err: error }, '[TaskExecutor] Failed to load previous execution output');
  }

  return '';
}

/**
 * Build the initial message shown at execution start.
 */
function buildInitialMessage(
  agentConfig: AgentConfigInput,
  previousOutput: string,
  continueFromPrevious?: boolean,
): string {
  const agentLabel = agentConfig.modelId
    ? `${agentConfig.name} (${agentConfig.type}, model: ${agentConfig.modelId})`
    : `${agentConfig.name} (${agentConfig.type})`;

  if (continueFromPrevious && previousOutput) {
    return previousOutput + '\n[継続実行] 追加指示の実行を開始します...\n';
  }

  return `[実行開始] タスクの実行を開始します...\n[エージェント] ${agentLabel}\n`;
}

/**
 * Build task with RAG context and analysis info.
 */
async function buildTaskWithContext(
  task: AgentTask,
  options: ExecutionOptions,
): Promise<AgentTask> {
  let ragContext = '';
  try {
    ragContext = await buildTaskRAGContext({
      title: task.title,
      description: task.description,
      themeId: task.themeId,
    });
  } catch (err) {
    logger.debug({ err }, '[TaskExecutor] RAG context build failed, continuing without');
  }

  // Tell the agent which useful CLIs are installed on PATH (rg, jq, gh, …) so it
  // prefers them. The agent already has shell access; this only adds awareness.
  let cliContext = '';
  try {
    const { getAgentCliContext } = await import('../cli-availability');
    cliContext = await getAgentCliContext();
  } catch (err) {
    logger.debug({ err }, '[TaskExecutor] CLI availability context build failed, continuing');
  }

  const extraContext = [ragContext, cliContext].filter(Boolean).join('\n\n');

  const taskWithAnalysis: AgentTask = {
    ...task,
    analysisInfo: options.analysisInfo,
    ...(extraContext ? { description: `${task.description ?? ''}\n\n${extraContext}` } : {}),
    investigationMode: options.investigationMode ?? task.investigationMode,
    investigationOutputType: options.investigationOutputType ?? task.investigationOutputType,
    outputLastMessageFile: options.outputLastMessageFile ?? task.outputLastMessageFile,
  };

  if (options.analysisInfo) {
    logger.info(`[TaskExecutor] AI task analysis enabled`);
    logger.info(
      `[TaskExecutor] Analysis summary: ${options.analysisInfo.summary?.substring(0, 100)}`,
    );
    logger.info(`[TaskExecutor] Subtasks count: ${options.analysisInfo.subtasks?.length || 0}`);
  } else {
    logger.info(`[TaskExecutor] AI task analysis not provided`);
  }

  return taskWithAnalysis;
}

// Provider fallback and recovery metrics are handled in fallback-executor.ts.

/**
 * Merge the primary agent's CLI segment time into a fallback result.
 *
 * Adopting a fallback result wholesale used to discard the failed primary
 * agent's executionTimeMs, under-recording active time (task #560). Time is
 * the only field merged — every other field must reflect the fallback run.
 *
 * @param primary - Result of the failed primary agent run. / 失敗した一次実行の結果
 * @param fallback - Result of the fallback agent run. / フォールバック実行の結果
 * @returns Fallback result with both segments' executionTimeMs summed. / 両セグメント合算済みの結果
 */
export function mergeFallbackSegmentTime(
  primary: AgentExecutionResult,
  fallback: AgentExecutionResult,
): AgentExecutionResult {
  const primaryMs = primary.executionTimeMs ?? 0;
  if (primaryMs <= 0) return fallback;
  return { ...fallback, executionTimeMs: (fallback.executionTimeMs ?? 0) + primaryMs };
}

/**
 * Handle successful execution - memory system and auto-complete.
 */
function handleExecutionSuccess(
  ctx: OrchestratorContext,
  execution: { id: number },
  result: AgentExecutionResult,
  agentType: string,
  options: ExecutionOptions,
): void {
  const { investigationMode, autoCompleteTask, taskId } = options;

  // Memory system: timeline event + distillation
  if (result.success && investigationMode) {
    logger.info(
      { executionId: execution.id, taskId },
      '[TaskExecutor] Investigation mode: deferring agent_execution_completed timeline event to post-handler',
    );
  } else {
    const eventType = result.success ? 'agent_execution_completed' : 'agent_execution_failed';
    appendEvent({
      eventType,
      actorType: 'agent',
      actorId: agentType,
      payload: { executionId: execution.id, taskId, success: result.success },
      correlationId: `execution_${execution.id}`,
    }).catch((err) => logger.debug({ err }, '[TaskExecutor] Timeline event failed'));
  }

  if (!result.success) return;

  // Enqueue distillation
  memoryTaskQueue.enqueue('distill', { executionId: execution.id }, 1).catch((err) => {
    logger.debug({ err }, '[TaskExecutor] Distillation enqueue failed');
  });

  // Auto-complete task
  const shouldAutoComplete = autoCompleteTask !== false && taskId && !result.waitingForInput;
  if (shouldAutoComplete) {
    autoCompleteTaskDurable(ctx.prisma, taskId, execution.id).catch((err) => {
      logger.error(
        { err, taskId, executionId: execution.id },
        '[TaskExecutor] Unexpected error in auto-complete retry helper',
      );
    });
  }
}

/**
 * Marks a task `done` after a successful agent run, retrying once on failure
 * and escalating via Notification if the write still doesn't land.
 *
 * A bare `.catch(() => log.warn(...))` on this write used to leave a
 * genuinely-successful task stuck at its prior (non-terminal) status forever
 * on a transient DB error, with only a warn-level log nobody would see.
 *
 * @param prisma - Orchestrator's Prisma client / オーケストレーターのPrismaクライアント
 * @param taskId - Task to mark done / 完了にするタスク
 * @param executionId - Execution that produced the success, for log context / ログ用の実行ID
 */
export async function autoCompleteTaskDurable(
  prisma: OrchestratorContext['prisma'],
  taskId: number,
  executionId: number,
): Promise<void> {
  const attempt = () =>
    prisma.task
      .update({ where: { id: taskId }, data: { status: 'done', completedAt: new Date() } })
      .then(() => true)
      .catch(() => false);

  if (await attempt()) {
    logger.info(
      { taskId, executionId },
      '[TaskExecutor] Task auto-completed on successful agent execution',
    );
    return;
  }

  logger.warn(
    { taskId, executionId },
    '[TaskExecutor] Failed to auto-complete task — retrying once',
  );
  if (await attempt()) {
    logger.info({ taskId, executionId }, '[TaskExecutor] Task auto-completed on retry');
    return;
  }

  logger.error(
    { taskId, executionId },
    '[TaskExecutor] Failed to auto-complete task twice — task may remain stuck; notifying',
  );
  // Dynamic import mirrors the pre-existing durable-blocked-write pattern
  // (avoids an orchestrator -> routes/services import cycle) — best-effort,
  // must never throw.
  import('../../communication/notification-service')
    .then(({ createNotification }) =>
      createNotification({
        type: 'system',
        title: 'タスク自動完了の記録に失敗',
        message: `タスク #${taskId} はエージェントの実行に成功しましたが、完了状態への更新に失敗しました。手動で確認してください。`,
        link: `/tasks?taskId=${taskId}`,
        metadata: { taskId, executionId, reason: 'auto_complete_write_failed' },
      }),
    )
    .catch(() => {});
}

/**
 * Execute a task.
 */
export async function executeTask(
  ctx: OrchestratorContext,
  task: AgentTask,
  options: ExecutionOptions,
): Promise<AgentExecutionResult> {
  // NOTE: Early guard — prevents AgentExecution DB record from being created during shutdown.
  if (ctx.isShuttingDown) {
    throw new Error(buildShutdownErrorMessage('start new execution'));
  }

  // Resolve agent configuration
  let { agentConfig, resolvedAgentConfigId } = await resolveAgentConfig(ctx, options);
  const agent = agentFactory.createAgent(agentConfig);

  // Create execution resources
  const setup = await createExecutionResources(
    ctx,
    agent,
    agentConfig,
    resolvedAgentConfigId,
    task,
    options,
  );
  const { execution, state, agentInfo, fileLogger, logManager } = setup;

  // Check for shutdown
  if (ctx.isShuttingDown) {
    ctx.activeAgents.delete(execution.id);
    ctx.activeExecutions.delete(execution.id);
    const shutdownMsg = buildShutdownErrorMessage('start new execution');
    fileLogger.logWarn(shutdownMsg);
    await fileLogger.flush();
    throw new Error(shutdownMsg);
  }

  // Setup handlers
  setupAgentHandlers(ctx, agent, setup, options);
  const cleanupLogHandler = logManager.cleanup;

  // Emit start event
  ctx.emitEvent({
    type: 'execution_started',
    executionId: execution.id,
    sessionId: options.sessionId,
    taskId: options.taskId,
    data: {
      agentType: agentConfig.type,
      agentName: agentConfig.name,
      modelId: agentConfig.modelId,
    },
    timestamp: new Date(),
  });

  // Load previous output for continuation
  const previousOutput = await loadPreviousOutput(ctx, execution.id, options);
  const initialMessage = buildInitialMessage(
    agentConfig,
    previousOutput,
    options.continueFromPrevious,
  );
  state.output = initialMessage;

  await ctx.prisma.agentExecution.update({
    where: { id: execution.id },
    data: { status: 'running', startedAt: new Date(), output: initialMessage },
  });

  try {
    // Build task with context
    const taskWithAnalysis = await buildTaskWithContext(task, options);

    // Execute agent (wrapped in ALS scope to capture sendAIMessage calls from main process)
    let result = await withLlmCallScope(async () => {
      options.assertExecutionAllowed?.();
      let r = await agent.execute(taskWithAnalysis);
      logger.info(
        `[TaskExecutor] Execution result - success: ${r.success}, waitingForInput: ${r.waitingForInput}, questionType: ${r.questionType}, question: ${r.question?.substring(0, 100)}`,
      );

      // A resumed CLI session can be gone on the CLI's side (pruned transcript,
      // or a worktree recreated between attempts). That is a latency
      // optimisation failing, NOT a task failure — every phase prompt is
      // self-contained, so retry once cold rather than failing the phase.
      // Deliberately placed before the provider-fallback check so a missing
      // session is never misread as a provider outage.
      if (agentConfig.resumeSessionId && isSessionResumeFailure(r, agentConfig.resumeSessionId)) {
        logger.warn(
          { taskId: options.taskId, resumeSessionId: agentConfig.resumeSessionId },
          '[TaskExecutor] --resume rejected by the CLI — retrying once as a fresh session',
        );
        fileLogger.logWarn(
          `--resume ${agentConfig.resumeSessionId} was rejected. Retrying as a fresh session.`,
          { claudeSessionId: agentConfig.resumeSessionId, fallbackStage: 'phase_resume_coldstart' },
        );
        await agentFactory.removeAgent(agent.id);
        agentConfig = { ...agentConfig, resumeSessionId: undefined, continueConversation: false };
        const freshAgent = agentFactory.createAgent(agentConfig);
        agentInfo.agent = freshAgent;
        setupAgentHandlers(ctx, freshAgent, setup, options);
        options.assertExecutionAllowed?.();
        r = await freshAgent.execute(taskWithAnalysis);
      }

      // Check for fallback need
      const { needsFallback, errorBlob } = await checkNeedsFallback(
        r,
        agentConfig.type,
        options.disableFallback,
        execution.id,
      );

      // Execute fallback if needed
      let fallbackSucceeded = false;
      if (needsFallback && !options.disableFallback) {
        const fallbackResult = await executeWithFallbackAgent(
          { ctx, execution, state, agentInfo, fileLogger, logManager, options, taskWithAnalysis },
          errorBlob,
          agentConfig,
        );

        if (fallbackResult.result.failureType === 'cancelled')
          r = mergeFallbackSegmentTime(r, fallbackResult.result);
        if (fallbackResult.newAgentConfig) {
          // NOTE: keep the primary run's CLI segment time — replacing the
          // result wholesale would discard it and under-record executionTimeMs.
          r = mergeFallbackSegmentTime(r, fallbackResult.result);
          fallbackSucceeded = fallbackResult.fallbackSucceeded;
          agentConfig = fallbackResult.newAgentConfig;
          resolvedAgentConfigId = fallbackResult.newConfigId;
        }
      }

      // Mark as failed if fallback didn't succeed — but only when the original
      // run itself failed (success:false). If the primary agent exited cleanly
      // (success:true) and we detected a possible provider error in its output
      // but have no fallback, trust the exit-0 result rather than overriding
      // it to failure. Codex CLI exits 0 on quota errors; Claude CLI does not,
      // so a clean Claude exit reliably means the run completed.
      if (needsFallback && !fallbackSucceeded && !r.success) {
        r = {
          ...r,
          errorMessage:
            r.errorMessage ||
            'Provider failure detected and no fallback agent completed successfully',
        };
      }

      // Merge Tier 2 (ALS sendAIMessage calls) into Tier 1 (CLI num_turns / API apiCalls)
      const alsCount = getLlmCallCount();
      if (alsCount > 0) {
        r = { ...r, llmCallCount: (r.llmCallCount ?? 0) + alsCount };
      }
      return r;
    });

    // Save result
    await saveExecutionResult(
      ctx.prisma,
      execution.id,
      options.sessionId,
      state,
      result,
      fileLogger,
      undefined,
      { investigationMode: options.investigationMode },
    );
    emitResultEvent(result, execution.id, options.sessionId, options.taskId, (event) =>
      ctx.emitEvent(event),
    );

    // Handle success (memory, auto-complete)
    handleExecutionSuccess(ctx, execution, result, agentConfig.type, options);

    return result;
  } catch (error) {
    await handleExecutionError(
      ctx.prisma,
      execution.id,
      options.sessionId,
      options.taskId,
      state,
      error,
      fileLogger,
      (event) => ctx.emitEvent(event),
      'Execution',
    );
    if (state.status === 'cancelled')
      throw new ExecutionCancelledError('Execution cancelled; result persistence did not complete');
    throw error;
  } finally {
    stopExecutionHeartbeat(execution.id);
    await cleanupLogHandler();
    await fileLogger.flush();
    ctx.activeExecutions.delete(execution.id);
    ctx.activeAgents.delete(execution.id);
    await agentFactory.removeAgent(agent.id);
  }
}
