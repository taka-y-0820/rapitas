/** Stop an owned CLI and retain cancellation across result-persistence races. */
import { agentFactory } from '../agent-factory';
import { createLogger } from '../../../config/logger';
import type { OrchestratorContext } from './types';
const logger = createLogger('agent-orchestrator');

export async function stopOwnedExecution(
  ctx: OrchestratorContext,
  executionId: number,
): Promise<boolean> {
  ctx.cancelQuestionTimeout(executionId);
  ctx.releaseContinuationLock(executionId);

  const state = ctx.activeExecutions.get(executionId);
  if (!state) {
    logger.info(`[Orchestrator] stopExecution: No active execution found for ${executionId}`);
    return false;
  }

  const agent = agentFactory.getAgent(state.agentId);
  if (!agent) {
    logger.info(`[Orchestrator] stopExecution: No agent found for ${state.agentId}`);
    ctx.activeExecutions.delete(executionId);
    ctx.activeAgents.delete(executionId);
    return false;
  }

  // Preserve stop intent before process exit settles its execution promise.
  // Result/error persistence may fail independently (for example SQLite contention).
  state.status = 'cancelled';
  try {
    await agent.stop();
  } catch (error) {
    logger.error({ err: error }, `[Orchestrator] Error stopping agent`);
  }

  try {
    await ctx.prisma.agentExecution.update({
      where: { id: executionId },
      data: {
        status: 'cancelled',
        output: state.output,
        completedAt: new Date(),
        errorMessage: 'Cancelled by user',
      },
    });
  } catch (error) {
    // NOTE: The agent process is already stopped above; a DB write failure
    // here must not abort the rest of this method, or the in-memory
    // activeExecutions/activeAgents maps are left with a permanently
    // stale entry for an execution whose agent no longer exists — the
    // caller (e.g. stopAllForTasks) already treats stopExecution as
    // best-effort via `.catch(() => {})`, so this mirrors that contract.
    logger.error({ err: error }, `[Orchestrator] Failed to persist cancellation for execution`);
  }

  ctx.activeExecutions.delete(executionId);
  ctx.activeAgents.delete(executionId);
  await agentFactory.removeAgent(state.agentId);

  ctx.emitEvent({
    type: 'execution_cancelled',
    executionId,
    sessionId: state.sessionId,
    taskId: state.taskId,
    timestamp: new Date(),
  });

  logger.info(`[Orchestrator] Execution ${executionId} stopped and cleaned up`);
  return true;
}
