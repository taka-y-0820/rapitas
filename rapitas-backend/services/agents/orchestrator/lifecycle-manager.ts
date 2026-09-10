/**
 * LifecycleManager
 *
 * Signal handlers, graceful shutdown, and agent state persistence.
 */
import { createLogger } from '../../../config/logger';
import type { PrismaClientInstance, ActiveAgentInfo, ExecutionState } from './types';
import type { QuestionTimeoutManager } from './question-timeout-manager';
import { stopAllPreviewSessions } from '../preview/preview-session-manager';
import { recordTransition } from '../../workflow/transition-recorder';

/**
 * How long a graceful shutdown may take when triggered by an uncaught
 * exception before the process leaves anyway. Short on purpose: the supervisor
 * restarts us, and a hung exit is worse than an abrupt one.
 */
const UNCAUGHT_SHUTDOWN_TIMEOUT_MS = 10_000;

const logger = createLogger('lifecycle-manager');

/**
 * Context required for lifecycle management.
 */
export type LifecycleContext = {
  prisma: PrismaClientInstance;
  activeAgents: Map<number, ActiveAgentInfo>;
  activeExecutions: Map<number, ExecutionState>;
  questionTimeoutManager: QuestionTimeoutManager;
  serverStopCallback: (() => Promise<void> | void) | null;
  getIsShuttingDown: () => boolean;
  setIsShuttingDown: (value: boolean) => void;
};

/**
 * Save a specific agent's state to the database.
 */
export async function saveAgentState(
  prisma: PrismaClientInstance,
  executionId: number,
  info: ActiveAgentInfo,
  status: 'interrupted' | 'failed',
): Promise<void> {
  const errorMessage =
    status === 'interrupted'
      ? `プロセスが中断されました。\n\n【最後の出力】\n${info.lastOutput.slice(-1000)}`
      : `プロセスが異常終了しました。\n\n【最後の出力】\n${info.lastOutput.slice(-1000)}`;

  const saved = await prisma.agentExecution.updateMany({
    where: {
      id: executionId,
      status: { in: ['pending', 'running', 'waiting_for_input', 'interrupted'] },
    },
    data: {
      status,
      output: info.state.output,
      errorMessage,
      completedAt: new Date(),
    },
  });
  // A concurrent stop or normal completion owns the terminal state.
  if (saved.count !== 1) return;

  try {
    await prisma.agentSession.updateMany({
      where: {
        id: info.sessionId,
        status: { in: ['pending', 'active', 'running', 'waiting_for_input', 'interrupted'] },
      },
      data: {
        status: 'interrupted',
        lastActivityAt: new Date(),
      },
    });
  } catch (error) {
    logger.error(
      { err: error, sessionId: info.sessionId },
      `[LifecycleManager] Failed to update session`,
    );
  }

  try {
    const task = await prisma.task.findUnique({
      where: { id: info.taskId },
      select: { id: true, status: true, workflowStatus: true },
    });
    if (task && task.status === 'in-progress') {
      const reverted = await prisma.task.updateMany({
        where: { id: info.taskId, status: 'in-progress', workflowStatus: task.workflowStatus },
        data: { status: 'todo' },
      });
      if (reverted.count !== 1) return;
      logger.info(`[LifecycleManager] Task ${info.taskId} reverted to 'todo' during shutdown`);
      // Record the revert so isWithinRecoveryGrace (incident-signature-detectors.ts)
      // can grant this deliberate `status='todo'` × advanced `workflowStatus`
      // shape its recovery grace period (task 709: previously unrecorded,
      // causing an immediate Pattern B false positive — task #602).
      await recordTransition({
        taskId: info.taskId,
        fromStatus: task.workflowStatus,
        toStatus: task.workflowStatus ?? 'draft',
        actor: 'system',
        cause: 'agent_lifecycle_shutdown_revert',
        metadata: { reason: 'backend_shutdown_revert' },
      }).catch(() => {});
    }
  } catch (error) {
    logger.error({ err: error, taskId: info.taskId }, `[LifecycleManager] Failed to update task`);
  }
}

/**
 * Save state for all active agents.
 */
export async function saveAllAgentStates(
  prisma: PrismaClientInstance,
  activeAgents: Map<number, ActiveAgentInfo>,
): Promise<void> {
  logger.info(`[LifecycleManager] Saving state for ${activeAgents.size} active agents...`);

  for (const [executionId, info] of activeAgents) {
    try {
      await saveAgentState(prisma, executionId, info, 'interrupted');
    } catch (error) {
      logger.error(
        { err: error, executionId },
        `[LifecycleManager] Failed to save state for execution`,
      );
    }
  }
}

/**
 * Perform graceful shutdown.
 */
export async function gracefulShutdown(
  ctx: LifecycleContext,
  options?: { skipServerStop?: boolean },
): Promise<void> {
  if (ctx.getIsShuttingDown()) {
    logger.info('[LifecycleManager] Shutdown already in progress');
    return;
  }

  ctx.setIsShuttingDown(true);
  logger.info(
    `[LifecycleManager] Starting graceful shutdown with ${ctx.activeAgents.size} active agents`,
  );

  const shutdownTimeout = 30000;
  const startTime = Date.now();

  try {
    ctx.questionTimeoutManager.cancelAllTimeouts();
    ctx.questionTimeoutManager.clearAllLocks();

    // Live-preview sessions spawn a playwright-worker.mjs Node child process
    // (plus the browser it launched) that nothing else kills on shutdown —
    // stop them here so a restart while a preview is open/starting can't
    // leave that process tree orphaned.
    await stopAllPreviewSessions().catch((err) => {
      logger.error({ err }, '[LifecycleManager] Failed to stop preview sessions during shutdown');
    });

    const stopPromises = Array.from(ctx.activeAgents.entries()).map(async ([executionId, info]) => {
      try {
        logger.info(`[LifecycleManager] Stopping agent for execution ${executionId}...`);

        await Promise.race([
          info.agent.stop(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Stop timeout')), 10000)),
        ]);

        await saveAgentState(ctx.prisma, executionId, info, 'interrupted');
        logger.info(
          `[LifecycleManager] Agent for execution ${executionId} stopped and state saved`,
        );
      } catch (error) {
        logger.error({ err: error, executionId }, `[LifecycleManager] Error stopping agent`);
        try {
          await saveAgentState(ctx.prisma, executionId, info, 'interrupted');
        } catch (saveError) {
          logger.error({ err: saveError, executionId }, `[LifecycleManager] Failed to save state`);
        }
      }
    });

    await Promise.race([
      Promise.all(stopPromises),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Shutdown timeout')),
          shutdownTimeout - (Date.now() - startTime),
        ),
      ),
    ]);

    logger.info('[LifecycleManager] Graceful shutdown completed');
  } catch (error) {
    logger.error({ err: error }, '[LifecycleManager] Graceful shutdown error');
    await saveAllAgentStates(ctx.prisma, ctx.activeAgents);
  } finally {
    ctx.activeAgents.clear();
    ctx.activeExecutions.clear();

    if (ctx.serverStopCallback && !options?.skipServerStop) {
      try {
        logger.info('[LifecycleManager] Stopping server listener...');
        await ctx.serverStopCallback();
        logger.info('[LifecycleManager] Server listener stopped');
      } catch (error) {
        logger.error({ err: error }, '[LifecycleManager] Failed to stop server listener');
      }
    }
  }
}

/**
 * Register signal handlers for graceful shutdown.
 */
export function setupSignalHandlers(
  shutdownFn: () => Promise<void>,
  saveStatesFn: () => Promise<void>,
): void {
  const handleShutdown = async (signal: string) => {
    logger.info(`[LifecycleManager] Received ${signal}, initiating graceful shutdown...`);
    await shutdownFn();
  };

  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));

  process.on('uncaughtException', async (error) => {
    logger.error({ err: error }, '[LifecycleManager] Uncaught exception');
    // Exiting is the right call — an uncaught exception leaves state we cannot
    // vouch for — but the exit must actually happen. A graceful shutdown that
    // hangs leaves a process that is neither dead nor serving: it keeps the
    // port bound, answers nothing, and the supervisor sees a live PID and does
    // not restart it. That is precisely the state observed on 2026-08-27, when
    // a backend held port 3001 against its own replacement.
    //
    // So: try to shut down cleanly, but leave regardless.
    const forced = setTimeout(() => {
      logger.error(
        { timeoutMs: UNCAUGHT_SHUTDOWN_TIMEOUT_MS },
        '[LifecycleManager] Graceful shutdown did not finish — exiting anyway',
      );
      process.exit(1);
    }, UNCAUGHT_SHUTDOWN_TIMEOUT_MS);
    forced.unref?.();
    try {
      await shutdownFn();
    } catch (err) {
      logger.error({ err }, '[LifecycleManager] Shutdown threw during uncaught-exception handling');
    }
    clearTimeout(forced);
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason) => {
    logger.error({ err: reason }, '[LifecycleManager] Unhandled rejection');
    await saveStatesFn();
  });

  logger.info('[LifecycleManager] Signal handlers registered for graceful shutdown');
}
