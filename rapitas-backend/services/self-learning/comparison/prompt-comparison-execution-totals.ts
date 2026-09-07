/** Sum the complete terminal session attempt, including failed fallback executions. */
export interface TrialExecutionMeasurement {
  id: number;
  status: string;
  modelName: string | null;
  costUsd: unknown;
  executionTimeMs: number | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export function trialExecutionTotals(executions: TrialExecutionMeasurement[]) {
  if (!executions.length) return null;
  let costUsd = 0;
  let durationMs = 0;
  const ids = new Set<number>();
  for (const execution of executions) {
    const cost = Number(execution.costUsd);
    const duration =
      execution.executionTimeMs ??
      (execution.startedAt && execution.completedAt
        ? execution.completedAt.getTime() - execution.startedAt.getTime()
        : NaN);
    if (
      !Number.isSafeInteger(execution.id) ||
      execution.id < 1 ||
      ids.has(execution.id) ||
      !['completed', 'failed', 'cancelled', 'interrupted'].includes(execution.status) ||
      !execution.modelName?.trim() ||
      execution.costUsd == null ||
      typeof execution.costUsd === 'boolean' ||
      (typeof execution.costUsd === 'string' && !execution.costUsd.trim()) ||
      !Number.isFinite(cost) ||
      cost < 0 ||
      !Number.isFinite(duration) ||
      duration < 0
    )
      return null;
    ids.add(execution.id);
    costUsd += cost;
    durationMs += duration;
  }
  if (!Number.isFinite(costUsd) || !Number.isFinite(durationMs)) return null;
  return {
    costUsd,
    durationMs,
    executionIds: executions.map((e) => e.id),
    executionModels: executions.map((e) => e.modelName!.trim()),
  };
}
