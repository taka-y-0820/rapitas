/** Drains both process-local execution owners before the server exits. */
import { prisma } from '../../config/database';
import { orchestrator } from '../core/orchestrator-instance';

export class ExecutionOwnersShutdownError extends Error {
  constructor(readonly errors: unknown[]) {
    super('Execution owner shutdown failed');
    this.name = 'ExecutionOwnersShutdownError';
  }
}

export async function shutdownExecutionOwners(): Promise<void> {
  const { AgentOrchestrator } = await import('../agents/agent-orchestrator');
  const owners = [orchestrator, AgentOrchestrator.getInstance(prisma)];
  // A failed worker IPC must not skip main-process workflow shutdown (or vice versa).
  const results = await Promise.allSettled(
    owners.map(async (owner) => owner.gracefulShutdown({ skipServerStop: true })),
  );
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length) throw new ExecutionOwnersShutdownError(errors);
}
