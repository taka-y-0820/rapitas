/** Merge retry accounting without replacing the final attempt's task outcome. */
import type { AgentExecutionResult } from '../base-agent';

const measured = (value: number | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function attempts(
  result: AgentExecutionResult,
): NonNullable<AgentExecutionResult['attemptMetrics']> {
  return (
    result.attemptMetrics ?? [
      {
        success: result.success,
        costUsd: measured(result.costUsd),
        executionTimeMs: measured(result.executionTimeMs),
        modelName: result.modelName?.trim() || null,
      },
    ]
  );
}

/** Historical export name retained for callers; cost and provenance now also accumulate. */
export function mergeFallbackSegmentTime(
  primary: AgentExecutionResult,
  fallback: AgentExecutionResult,
): AgentExecutionResult {
  const attemptMetrics = [...attempts(primary), ...attempts(fallback)];
  const total = attemptMetrics.every((a) => a.costUsd !== null)
    ? attemptMetrics.reduce((sum, a) => sum + a.costUsd!, 0)
    : undefined;
  return {
    ...fallback,
    attemptMetrics,
    costUsd: total !== undefined && Number.isFinite(total) ? total : undefined,
    executionTimeMs: (primary.executionTimeMs ?? 0) + (fallback.executionTimeMs ?? 0),
  };
}
