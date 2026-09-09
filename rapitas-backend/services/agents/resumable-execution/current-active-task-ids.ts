/**
 * Current Active Task IDs
 *
 * Resolves which task IDs currently have a LIVE execution (worker process or
 * main-process auto-run orchestrator), so callers can avoid double-counting a
 * task's stale `interrupted` row alongside its fresh running one. Not
 * responsible for deciding resumability — see resumable-execution-policy.ts.
 */
import { prisma } from '../../../config/database';
import { orchestrator } from '../../core/orchestrator-instance';

/**
 * Union of execution IDs the worker subprocess and the main-process
 * auto-run orchestrator both consider currently active. Manual executions run
 * in the worker; auto-run/workflow executions run in the main process — a
 * task can only be considered "live" by checking both.
 *
 * @returns Deduplicated list of currently active execution IDs / 現在アクティブな実行ID一覧
 */
export async function getCurrentActiveExecutionIds(): Promise<number[]> {
  const workerManager = orchestrator as unknown as {
    getActiveExecutionIdsAsync?: () => Promise<number[]>;
  };
  const workerActiveIds = workerManager.getActiveExecutionIdsAsync
    ? await workerManager.getActiveExecutionIdsAsync()
    : orchestrator.getActiveExecutions().map((e: { executionId: number }) => e.executionId);

  const { AgentOrchestrator } = await import('../agent-orchestrator');
  const mainActiveIds = AgentOrchestrator.getInstance(prisma)
    .getActiveAgentInfos()
    .map((i: { executionId: number }) => i.executionId);

  return Array.from(new Set([...workerActiveIds, ...mainActiveIds]));
}

/**
 * Resolves task IDs that have at least one `running`/`waiting_for_input`
 * execution among the given (currently active) execution IDs. Deliberately
 * has no `take` limit — dedup correctness must not depend on a display page
 * size.
 *
 * @param activeExecutionIds - Execution IDs considered live / 現在アクティブな実行ID一覧
 * @returns Set of task IDs with a live execution / ライブ実行を持つタスクID集合
 */
export async function getLiveTaskIdsForActiveExecutions(
  activeExecutionIds: number[],
): Promise<Set<number>> {
  if (activeExecutionIds.length === 0) return new Set();

  const liveExecutions = await prisma.agentExecution.findMany({
    where: {
      status: { in: ['running', 'waiting_for_input'] },
      id: { in: activeExecutionIds },
    },
    select: { session: { select: { config: { select: { task: { select: { id: true } } } } } } },
  });

  const liveTaskIds = new Set<number>();
  for (const execution of liveExecutions) {
    const taskId = execution.session.config?.task?.id;
    if (taskId != null) liveTaskIds.add(taskId);
  }
  return liveTaskIds;
}
