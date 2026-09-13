/** Atomically admits an interrupted execution and its task into a resumed run. */
import type { OrchestratorContext } from './types';
import { ExecutionCancelledError } from '../execution-cancelled-error';

export async function transitionResumedExecution(
  prisma: OrchestratorContext['prisma'],
  executionId: number,
  taskId: number,
  output: string,
  assertAllowed: () => void,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    assertAllowed();
    // Claim the execution first. A stop in another process changes this row,
    // so a stale initial read cannot resurrect a cancelled execution.
    const claimed = await tx.agentExecution.updateMany({
      where: { id: executionId, status: 'interrupted' },
      data: { status: 'running', errorMessage: null, output },
    });
    if (claimed.count !== 1)
      throw new ExecutionCancelledError(`Resume execution ${executionId} is no longer interrupted`);
    assertAllowed();
    const task = await tx.task.updateMany({
      where: {
        id: taskId,
        status: { in: ['todo', 'in-progress'] },
        OR: [{ workflowStatus: null }, { workflowStatus: { not: 'completed' } }],
      },
      data: { status: 'in-progress' },
    });
    if (task.count !== 1)
      throw new ExecutionCancelledError(`Resume task ${taskId} is no longer eligible`);
    assertAllowed();
  });
}
