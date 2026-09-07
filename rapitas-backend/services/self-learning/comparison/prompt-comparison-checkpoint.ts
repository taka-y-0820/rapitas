/** Deterministic, balanced prefixes for the predeclared 5-run checkpoints. */
import { FIRST_EVALUATION_SAMPLE } from './prompt-comparison-alpha-ledger';
import { buildComparisonSummary } from './prompt-comparison-metrics';
import type { ComparisonCell, ComparisonSummary } from './prompt-comparison-types';

/** Refuse mixed conditions as a whole; never select the favorable model subset. */
export function comparisonCohortIssue(
  cells: ComparisonCell[],
  role: string,
  candidateVersion: string,
): string | null {
  if (!Array.isArray(cells)) return 'invalid_record';
  const models = new Set<string>();
  const executions = new Set<number>();
  const arms = new Set<string>();
  for (const cell of cells) {
    if (!cell || typeof cell !== 'object') return 'invalid_record';
    if (cell.knowledge !== 'with') continue;
    if (!Array.isArray(cell.runs) || arms.has(cell.arm)) return 'invalid_record';
    arms.add(cell.arm);
    for (const run of cell.runs) {
      if (!run || typeof run !== 'object') return 'invalid_run';
      if (
        !Number.isSafeInteger(run.executionId) ||
        run.executionId <= 0 ||
        executions.has(run.executionId) ||
        typeof run.success !== 'boolean' ||
        !Number.isFinite(run.costUsd) ||
        run.costUsd < 0 ||
        !Number.isFinite(run.durationMs) ||
        run.durationMs < 0
      )
        return 'invalid_run';
      executions.add(run.executionId);
      if (run.role !== role) return 'role_mismatch';
      if (typeof run.modelName !== 'string' || !run.modelName.trim()) return 'actual_model_unknown';
      models.add(run.modelName.trim());
      if (cell.arm === 'candidate' && (!run.injected || run.injectedVersion !== candidateVersion)) {
        return 'candidate_version_mismatch';
      }
    }
  }
  return models.size > 1 ? 'mixed_actual_models' : null;
}

/**
 * Execution IDs establish creation order, not success order. Later observations
 * cannot be tested using an earlier checkpoint's budget. This does not establish
 * that all assigned executions have settled; the trial assignment manifest must
 * establish cohort completeness before an operational adoption is justified.
 */
export function buildCheckpointSummary(cells: ComparisonCell[]): ComparisonSummary | null {
  const arms = (['current', 'candidate'] as const).map((arm) => ({
    arm,
    knowledge: 'with' as const,
    runs: (cells.find((c) => c.arm === arm && c.knowledge === 'with')?.runs ?? [])
      .filter((r) => r.failureCause !== 'infra_failure')
      .sort((a, b) => a.executionId - b.executionId),
  }));
  const minimum = Math.min(...arms.map((cell) => cell.runs.length));
  if (minimum < FIRST_EVALUATION_SAMPLE) return buildComparisonSummary(cells);
  const checkpoint = Math.floor(minimum / FIRST_EVALUATION_SAMPLE) * FIRST_EVALUATION_SAMPLE;
  return buildComparisonSummary(
    arms.map((cell) => ({ ...cell, runs: cell.runs.slice(0, checkpoint) })),
  );
}
