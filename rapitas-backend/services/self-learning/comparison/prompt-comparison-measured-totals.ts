/** Operational collectors require recorded attempts, including single-attempt executions. */
import { readExecutionAttemptMetrics } from '../../agents/execution-file-logger/attempt-metrics-reader';
import {
  trialExecutionTotals,
  type TrialExecutionMeasurement,
} from './prompt-comparison-execution-totals';

export async function measuredTrialExecutionTotals(
  executions: TrialExecutionMeasurement[],
  sessionId: number,
  reader = readExecutionAttemptMetrics,
) {
  const measured: TrialExecutionMeasurement[] = [];
  const attemptModels: string[] = [];
  for (const execution of executions) {
    const attempts = await reader(execution.id, sessionId);
    if (!attempts?.length || attempts[attempts.length - 1]?.modelName !== execution.modelName) return null;
    let costUsd = 0;
    let executionTimeMs = 0;
    for (const attempt of attempts) {
      const duration =
        attempt.executionTimeMs ??
        (attempts.length === 1 && execution.startedAt && execution.completedAt
          ? execution.completedAt.getTime() - execution.startedAt.getTime()
          : NaN);
      if (
        attempt.costUsd === null ||
        !Number.isFinite(duration) ||
        duration < 0 ||
        !attempt.modelName?.trim()
      )
        return null;
      costUsd += attempt.costUsd;
      executionTimeMs += duration;
      attemptModels.push(attempt.modelName.trim());
    }
    measured.push({ ...execution, costUsd, executionTimeMs });
  }
  const totals = trialExecutionTotals(measured);
  return totals ? { ...totals, attemptModels } : null;
}
