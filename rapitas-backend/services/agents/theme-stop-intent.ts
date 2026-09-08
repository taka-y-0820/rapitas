/** Durable execution targets for one theme-stop request, independent of cancellation text. */
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma-postgres';
export const THEME_STOP_INTENT = 'theme_stop_execution_requested';

export async function recordThemeStopIntent(
  db: PrismaClient,
  themeId: number,
  executionIds: number[],
): Promise<string> {
  const requestId = randomUUID();
  const ids = [...new Set(executionIds)];
  await db.$transaction(
    async (tx) => {
      for (const executionId of ids) {
        const execution = await tx.agentExecution.findUnique({
          where: { id: executionId },
          select: { session: { select: { config: { select: { taskId: true } } } } },
        });
        if (!execution) throw new Error('Stop target execution missing');
        const taskId = execution.session.config.taskId;
        const task = await tx.task.findUnique({
          where: { id: taskId },
          select: { workflowStatus: true },
        });
        if (!task) throw new Error('Stop target task missing');
        await tx.workflowTransition.create({
          data: {
            taskId,
            executionId,
            actor: 'system',
            cause: THEME_STOP_INTENT,
            fromStatus: task.workflowStatus,
            toStatus: task.workflowStatus ?? 'draft',
            metadata: JSON.stringify({ requestId, themeId }),
          },
        });
      }
    },
    { isolationLevel: 'Serializable' },
  );
  return requestId;
}

/** Discover outstanding targets after restart without retaining an in-memory request id. */
export async function readPendingThemeStopTargets(
  db: PrismaClient,
  themeId: number,
): Promise<number[]> {
  if (!Number.isSafeInteger(themeId) || themeId <= 0) throw new Error('Invalid theme id');
  const rows = await db.workflowTransition.findMany({
    where: {
      cause: THEME_STOP_INTENT,
      task: { status: 'in-progress' },
      metadata: { contains: `"themeId":${themeId}` },
    },
    select: { executionId: true, metadata: true },
  });
  const ids: number[] = [];
  for (const row of rows) {
    const metadata = JSON.parse(row.metadata) as { themeId?: unknown };
    // SQL substring matching is only a prefilter (theme 1 must not match theme 10).
    if (metadata.themeId !== themeId) continue;
    if (!Number.isSafeInteger(row.executionId) || (row.executionId ?? 0) <= 0)
      throw new Error('Invalid stored stop execution');
    ids.push(row.executionId!);
  }
  return [...new Set(ids)];
}

export async function readThemeStopIntent(db: PrismaClient, requestId: string): Promise<number[]> {
  if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error('Invalid stop request id');
  const rows = await db.workflowTransition.findMany({
    where: { cause: THEME_STOP_INTENT, metadata: { contains: requestId } },
    select: { executionId: true, metadata: true },
    orderBy: { id: 'asc' },
  });
  const ids: number[] = [];
  for (const row of rows) {
    const metadata = JSON.parse(row.metadata) as { requestId?: unknown };
    if (metadata.requestId !== requestId) continue;
    if (!Number.isSafeInteger(row.executionId) || (row.executionId ?? 0) <= 0)
      throw new Error('Invalid stored stop execution');
    ids.push(row.executionId!);
  }
  return [...new Set(ids)];
}
