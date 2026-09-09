import type { FallbackContext } from './fallback-executor';
import type { AgentExecutionResult } from '../base-agent';

/** Read durable stop state before fallback work; a failed read must prevent spawning. */
export async function stoppedFallbackResult(context: FallbackContext): Promise<{
  result: AgentExecutionResult;
  fallbackSucceeded: false;
} | null> {
  const row = await context.ctx.prisma.agentExecution.findUnique({
    where: { id: context.execution.id },
    select: { status: true, session: { select: { status: true } } },
  });
  if (!row) throw new Error('Fallback execution record is missing');
  const stopped = ['canceling', 'cancelling', 'cancelled', 'canceled'];
  if (
    !context.ctx.isShuttingDown &&
    !stopped.includes(context.state.status) &&
    !stopped.includes(row.status) &&
    !stopped.includes(row.session.status)
  )
    return null;
  context.fileLogger.logWarn('Stop request observed; suppressing provider fallback');
  return {
    result: {
      success: false,
      output: context.state.output ?? '',
      failureType: 'cancelled',
      errorMessage: 'Execution stopped before fallback',
    },
    fallbackSucceeded: false,
  };
}
