/**
 * Execution Resume
 *
 * Resumes a single interrupted execution, rebuilding the agent and replaying state.
 * Not responsible for startup-time batch recovery — see stale-execution-recovery.ts.
 */

import { join } from 'path';
import { agentFactory } from '../agent-factory';
import type { AgentConfigInput } from '../agent-factory';
import type { AgentTask, AgentExecutionResult } from '../base-agent';
import { ExecutionFileLogger } from '../execution-file-logger';
import { createLogger, getProjectRoot } from '../../../config';
import type {
  ExecutionState,
  ExecutionOptions,
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
import { buildResumePrompt, resolveAgentConfig } from './resume-helpers';
import { classifySessionFailureReason } from '../claude-code/failure-reason-markers';
import { buildShutdownErrorMessage } from './shutdown-error';
import { withLlmCallScope, getLlmCallCount } from '../../../utils/llm-call-context';
import {
  acquireTaskExecutionLock,
  releaseTaskExecutionLock,
  WORKFLOW_LOCK_TTL_MS,
} from '../task-execution-lock';

const logger = createLogger('execution-resume');

/**
 * Thrown when resumeInterruptedExecution() cannot acquire the shared
 * task-execution lock because another run (manual, workflow-orchestrator, or
 * a concurrent resume) already holds it for the same task. Treated as a
 * benign skip by resume-completion.ts, not a failed execution.
 */
export class ResumeLockConflictError extends Error {
  constructor(taskId: number) {
    super(`Task ${taskId} already has an agent execution in progress — refusing duplicate resume`);
    this.name = 'ResumeLockConflictError';
  }
}

/**
 * Resumes an interrupted execution from its last known state.
 * @throws {Error} When execution is not found, not interrupted, or has no task / 実行が見つからない場合
 * @throws {ResumeLockConflictError} When the task-execution lock is already held for this task / 排他ロック競合時
 */
export async function resumeInterruptedExecution(
  ctx: OrchestratorContext,
  executionId: number,
  options: Partial<ExecutionOptions> = {},
): Promise<AgentExecutionResult> {
  const execution = await ctx.prisma.agentExecution.findUnique({
    where: { id: executionId },
    include: {
      session: {
        include: {
          config: {
            include: {
              task: {
                include: { theme: true },
              },
            },
          },
        },
      },
      executionLogs: {
        orderBy: { sequenceNumber: 'asc' },
      },
    },
  });

  if (!execution) {
    throw new Error(`Execution not found: ${executionId}`);
  }

  if (execution.status !== 'interrupted') {
    throw new Error(`Execution is not in interrupted state: ${execution.status}`);
  }

  const task = execution.session.config?.task;
  if (!task) {
    throw new Error(`Task not found for execution: ${executionId}`);
  }

  const taskId = task.id;
  if (!acquireTaskExecutionLock(taskId, WORKFLOW_LOCK_TTL_MS)) {
    throw new ResumeLockConflictError(taskId);
  }

  try {
    // CRITICAL: Require explicit workingDirectory to prevent accidental modification of rapitas source
    const workingDirectory = task.theme?.workingDirectory || options.workingDirectory;
    if (!workingDirectory) {
      throw new Error(
        `Task ${task.id} rejected: workingDirectory not configured for theme "${task.theme?.name || 'unknown'}". Please set the working directory in theme settings.`,
      );
    }
    // NOTE: Log warning when workingDirectory overlaps with rapitas project — allowed but flagged
    const projectRoot = getProjectRoot();
    if (
      workingDirectory === projectRoot ||
      workingDirectory.startsWith(join(projectRoot, 'rapitas-'))
    ) {
      logger.warn(
        `[ExecutionResume] Task ${task.id}: workingDirectory overlaps with rapitas project (${workingDirectory}). Proceeding as user-intended.`,
      );
    }

    const claudeSessionId = execution.claudeSessionId;

    logger.info(`[ExecutionResume] Resuming interrupted execution ${executionId}`);
    logger.info(`[ExecutionResume] Task: ${task.title} (ID: ${task.id})`);
    logger.info(
      `[ExecutionResume] Claude Session ID: ${claudeSessionId || '(なし - 新規セッションで開始)'}`,
    );
    logger.info(`[ExecutionResume] Working Directory: ${workingDirectory}`);

    if (!claudeSessionId) {
      logger.warn(
        `[ExecutionResume] WARNING: No Claude session ID found for execution ${executionId}. Starting as new session.`,
      );
    }

    const previousOutput = execution.output || '';
    const lastOutput = previousOutput.slice(-3000);
    const logSummary = execution.executionLogs
      .slice(-50)
      .map((log: { logChunk: string }) => log.logChunk)
      .join('');

    const resumePrompt = buildResumePrompt(
      task,
      lastOutput,
      logSummary.slice(-2000),
      execution.errorMessage,
      task.workflowStatus,
    );

    // Structural gap this closes (task 900): this crash-recovery path does
    // NOT go through phase-session-resume.ts's exclusion guard, so a session
    // whose most recent resume already failed with "Prompt is too long" would
    // otherwise be resumed unconditionally after every server restart.
    // buildResumePrompt is already short, so only the --resume flag changes.
    let resumeSessionIdForCli = claudeSessionId;
    if (claudeSessionId) {
      try {
        const failedResume = await ctx.prisma.agentExecution.findFirst({
          where: { claudeSessionId, status: 'failed' },
          orderBy: { id: 'desc' },
          select: { errorMessage: true },
        });
        if (
          failedResume &&
          classifySessionFailureReason(failedResume.errorMessage) === 'prompt_too_long'
        ) {
          logger.info(
            `[ExecutionResume] Session ${claudeSessionId} last failed with a prompt-too-long error — cold-starting instead of resuming (execution ${executionId}).`,
          );
          resumeSessionIdForCli = null;
        }
      } catch (err) {
        logger.warn({ err }, `[ExecutionResume] prompt-too-long lookup failed — resuming anyway`);
      }
    }

    let agentConfig: AgentConfigInput = {
      type: 'claude-code',
      name: 'Claude Code Agent',
      workingDirectory,
      timeout: options.timeout || 900000,
      dangerouslySkipPermissions: true,
      resumeSessionId: resumeSessionIdForCli || undefined,
      continueConversation: false,
    };

    if (execution.agentConfigId) {
      agentConfig = await resolveAgentConfig(
        ctx,
        execution.agentConfigId,
        agentConfig,
        resumeSessionIdForCli,
      );
    }

    const agent = agentFactory.createAgent(agentConfig);

    const fileLogger = new ExecutionFileLogger(
      execution.id,
      execution.sessionId,
      taskId,
      task.title,
      agentConfig.type,
      agentConfig.name,
      agentConfig.modelId,
    );
    fileLogger.logExecutionStart(`[Resume] Resuming interrupted execution`, {
      claudeSessionId,
      workingDirectory,
      previousOutputLength: previousOutput.length,
      errorMessage: execution.errorMessage,
    });

    const state: ExecutionState = {
      executionId: execution.id,
      sessionId: execution.sessionId,
      agentId: agent.id,
      taskId,
      status: 'running',
      startedAt: new Date(),
      output: previousOutput,
    };
    ctx.activeExecutions.set(execution.id, state);

    const agentInfo: ActiveAgentInfo = {
      agent,
      executionId: execution.id,
      sessionId: execution.sessionId,
      taskId,
      state,
      lastOutput: lastOutput,
      lastSavedAt: new Date(),
      fileLogger,
    };
    ctx.activeAgents.set(execution.id, agentInfo);

    if (ctx.isShuttingDown) {
      ctx.activeAgents.delete(execution.id);
      ctx.activeExecutions.delete(execution.id);
      const shutdownMsg = buildShutdownErrorMessage('resume execution');
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

    const cleanupLogHandler = logManager.cleanup;

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

    const resumeMessage = `\n[再開] 中断された作業を再開します...\n`;
    state.output += resumeMessage;

    await ctx.prisma.agentExecution.update({
      where: { id: execution.id },
      data: {
        status: 'running',
        errorMessage: null,
        output: state.output,
      },
    });

    ctx.emitEvent({
      type: 'execution_started',
      executionId: execution.id,
      sessionId: execution.sessionId,
      taskId,
      data: { resumed: true },
      timestamp: new Date(),
    });

    try {
      const agentTask: AgentTask = {
        id: taskId,
        title: task.title,
        description: resumePrompt,
        workingDirectory,
      };

      const result = await withLlmCallScope(async () => {
        let r = await agent.execute(agentTask);

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
        'Resume execution',
      );
      throw error;
    } finally {
      await cleanupLogHandler();
      await fileLogger.flush();
      ctx.activeExecutions.delete(execution.id);
      ctx.activeAgents.delete(execution.id);
      await agentFactory.removeAgent(agent.id);
    }
  } finally {
    releaseTaskExecutionLock(taskId);
  }
}

// buildResumePrompt and resolveAgentConfig are implemented in ./resume-helpers.ts
// and re-exported here for backward compatibility.
export { buildResumePrompt } from './resume-helpers';
