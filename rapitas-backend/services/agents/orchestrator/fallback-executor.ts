import { runMeasuredAgentAttempt } from './measured-agent-attempt';
/**
 * fallback-executor
 *
 * Runs a fallback agent after a primary agent's provider failure on the
 * manual/parallel execution path. Extracted verbatim from task-executor.ts
 * (file-size ratchet — that file may not grow), then instrumented with
 * recovery-metrics recording (task 641). Not responsible for DECIDING whether
 * a fallback is needed — that stays in fallback-decision.ts.
 */
import { agentFactory } from '../agent-factory';
import type { AgentConfigInput } from '../agent-factory';
import type { AgentTask, AgentExecutionResult } from '../base-agent';
import type { ExecutionFileLogger } from '../execution-file-logger';
import { createLogger } from '../../../config/logger';
import type {
  ExecutionOptions,
  ExecutionState,
  ActiveAgentInfo,
  OrchestratorContext,
} from './types';
import {
  setupQuestionDetectedHandler,
  setupOutputHandler,
  type LogChunkManager,
} from './execution-helpers';
import type { RecoveryAttemptInput } from '../../ai/recovery-metrics/recovery-metrics.types';

const logger = createLogger('task-executor');

/**
 * Fire-and-forget recovery-metrics write. Any failure is swallowed —
 * measurement must never affect the fallback execution it observes.
 */
function recordAttempt(input: RecoveryAttemptInput): void {
  void import('../../ai/recovery-metrics')
    .then(({ recordRecoveryAttempt }) => recordRecoveryAttempt(input, Date.now()))
    .catch(() => {});
}

/** Context for fallback execution */
export interface FallbackContext {
  ctx: OrchestratorContext;
  execution: { id: number };
  state: ExecutionState;
  agentInfo: ActiveAgentInfo;
  fileLogger: ExecutionFileLogger;
  logManager: LogChunkManager;
  options: ExecutionOptions;
  taskWithAnalysis: AgentTask;
}

/**
 * Execute with a fallback agent after primary agent failure.
 */
export async function executeWithFallbackAgent(
  fallbackCtx: FallbackContext,
  errorBlob: string,
  originalAgentConfig: AgentConfigInput,
): Promise<{
  result: AgentExecutionResult;
  fallbackSucceeded: boolean;
  newAgentConfig?: AgentConfigInput;
  newConfigId?: number;
}> {
  const { ctx, execution, state, agentInfo, fileLogger, logManager, options, taskWithAnalysis } =
    fallbackCtx;

  const { findFallbackAgentConfig } = await import('../../ai/agent-fallback');
  const fallback = await findFallbackAgentConfig(errorBlob, originalAgentConfig.type);

  if (!fallback?.agentConfig) {
    // Measurement: attribute the no-candidate miss (the "空振り" numerator).
    // findFallbackAgentConfig doesn't expose its classification, so re-run the
    // same lenient classify it used; an empty blob has nothing to attribute.
    if (errorBlob.trim()) {
      const { classifyAgentError } = await import('../../ai/agent-error-classifier');
      const { agentTypeToProvider } = await import('../../ai/agent-fallback');
      const hint = agentTypeToProvider(originalAgentConfig.type) ?? undefined;
      const classified = classifyAgentError(errorBlob, hint);
      recordAttempt({
        taskId: options.taskId,
        phase: 'manual',
        errorType: classified?.reason ?? 'unclassified',
        fromProvider: classified?.provider ?? hint ?? originalAgentConfig.type,
        fromModel: originalAgentConfig.modelId ?? null,
        strategy: 'none',
        outcome: 'no_candidate',
      });
      // Rule-based classification found nothing (task 612) — ask the LLM to
      // complete the diagnosis in the background. Never awaited: this must
      // not delay the no_candidate response.
      if (!classified) {
        void import('../../ai/error-diagnosis')
          .then(({ diagnoseErrorWithLlm }) =>
            diagnoseErrorWithLlm({
              taskId: options.taskId,
              phase: 'manual',
              fromProvider: hint ?? originalAgentConfig.type,
              fromModel: originalAgentConfig.modelId ?? null,
              errorBlob,
            }),
          )
          .catch(() => {});
      }
    }
    return { result: {} as AgentExecutionResult, fallbackSucceeded: false };
  }

  const fbType = (fallback.agentConfig as { agentType: string }).agentType;
  const fbName = (fallback.agentConfig as { name: string }).name;
  const fbId = (fallback.agentConfig as { id: number }).id;

  logger.warn(
    {
      originalAgent: originalAgentConfig.name,
      originalType: originalAgentConfig.type,
      fallbackAgent: fbName,
      fallbackType: fbType,
      cooledProvider: fallback.classified.provider,
      reason: fallback.classified.reason,
    },
    '[TaskExecutor] Provider failed — retrying with alternative agent config',
  );

  // Emit fallback banner
  const banner = `\n[フォールバック] ${fallback.classified.reason} を検出。${fbName} (${fbType}) で再実行します...\n`;
  state.output += banner;
  fileLogger.logOutput(banner, false);
  logManager.addChunk(banner, false);
  ctx.emitEvent({
    type: 'execution_output',
    executionId: execution.id,
    sessionId: options.sessionId,
    taskId: options.taskId,
    data: { output: banner, isError: false },
    timestamp: new Date(),
  });

  const newAgentConfig = await ctx.buildAgentConfigFromDb(fallback.agentConfig as never, options);
  const newAgent = agentFactory.createAgent(newAgentConfig);

  try {
    // Wire handlers onto fallback agent
    setupQuestionDetectedHandler(newAgent, {
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
      newAgent,
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

    // Update references
    agentInfo.agent = newAgent;
    await ctx.prisma.agentExecution.update({
      where: { id: execution.id },
      data: { agentConfigId: fbId },
    });

    ctx.emitEvent({
      type: 'execution_started',
      executionId: execution.id,
      sessionId: options.sessionId,
      taskId: options.taskId,
      data: {
        agentType: newAgentConfig.type,
        agentName: newAgentConfig.name,
        modelId: newAgentConfig.modelId,
        fallbackFrom: fallback.classified.provider,
      },
      timestamp: new Date(),
    });

    const retryStartedMs = Date.now();
    const retryResult = await runMeasuredAgentAttempt(
      () => newAgent.execute(taskWithAnalysis),
      fileLogger,
      () =>
        !ctx.isShuttingDown && !['cancelled', 'canceling', 'interrupted'].includes(state.status),
    );

    // Check if retry also failed
    const retryBlob = `${retryResult.errorMessage ?? ''}\n${
      typeof retryResult.output === 'string' ? retryResult.output.slice(-4000) : ''
    }`;
    const { classifyAgentError: reclassify } = await import('../../ai/agent-error-classifier');
    const { agentTypeToProvider } = await import('../../ai/agent-fallback');
    const retryHint = agentTypeToProvider(newAgentConfig.type) ?? undefined;
    const retryClassified = reclassify(retryBlob, { hint: retryHint, strict: true });
    const retryHasError = !!retryClassified?.retryWithFallback;
    const retryActuallySucceeded = retryResult.success && !retryHasError;

    // Measurement: record the fallback run's outcome. `model-strip` is the
    // model_unavailable "same provider, drop --model" retry (see agent-fallback).
    recordAttempt({
      taskId: options.taskId,
      phase: 'manual',
      errorType: fallback.classified.reason,
      fromProvider: fallback.classified.provider,
      fromModel: originalAgentConfig.modelId ?? null,
      toProvider: agentTypeToProvider(fbType) ?? fbType,
      strategy: fallback.classified.reason === 'model_unavailable' ? 'model-strip' : 'reroute',
      outcome: retryActuallySucceeded ? 'success' : 'failure',
      latencyMs: retryResult.executionTimeMs ?? Date.now() - retryStartedMs,
      costUsd: retryResult.costUsd ?? null,
      failureReason: retryActuallySucceeded ? null : (retryClassified?.reason ?? null),
    });

    return {
      result: retryResult,
      fallbackSucceeded: retryActuallySucceeded,
      newAgentConfig,
      newConfigId: fbId,
    };
  } finally {
    await agentFactory.removeAgent(newAgent.id);
  }
}
