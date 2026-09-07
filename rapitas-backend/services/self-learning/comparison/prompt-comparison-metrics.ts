/**
 * PromptComparisonMetrics
 *
 * Pure aggregation and judgement logic for the prompt comparison system:
 * failure-cause classification, per-arm aggregation and the improved /
 * regressed / inconclusive / insufficient_data verdict. No I/O, no clock —
 * fixture-testable, mirroring the experiment-metrics.ts separation.
 */
import type {
  ComparisonArm,
  ComparisonCell,
  ComparisonRun,
  ComparisonSummary,
  ComparisonVerdict,
  FailureCause,
} from './prompt-comparison-types';

/** Minimum successful+failed samples required to judge a candidate (distinct from prompt-evolution-runner's MIN_SAMPLE_SIZE trigger threshold). */
export const COMPARISON_MIN_SAMPLE = 5;

/** Success-rate delta magnitude that separates improved/regressed from noise. */
export const COMPARISON_IMPROVE_THRESHOLD = 0.05;

/** Cost worsening fraction beyond which a candidate is not called "improved". */
export const COMPARISON_COST_TOLERANCE = 0.2;

/** Duration worsening fraction beyond which a candidate is not called "improved". */
export const COMPARISON_DURATION_TOLERANCE = 0.2;

/** Infra-failure signatures that mark a run's failure as environment-caused, not prompt-caused. */
const INFRA_FAILURE_PATTERN =
  /ECONNRESET|529|ETIMEDOUT|rate.?limit|Overloaded|ECONNREFUSED|ENOTFOUND/i;

/**
 * Classify why a shadow-run execution did not succeed. Preliminary regex —
 * spot-check against real failed executions before trusting the split.
 *
 * @param execution - Execution status/errorMessage from AgentExecution. / 実行のstatus/errorMessage
 * @returns Failure cause, or null when the execution succeeded. / 失敗原因（成功時はnull）
 */
export function classifyFailureCause(execution: {
  status: string;
  errorMessage: string | null;
}): FailureCause | null {
  if (execution.status === 'completed') return null;
  if (execution.status === 'cancelled') return 'user_cancelled';
  if (INFRA_FAILURE_PATTERN.test(execution.errorMessage ?? '')) return 'infra_failure';
  return 'implementation_error';
}

/** Per-arm aggregate used before computing the current-vs-candidate summary. */
interface ArmAggregate {
  successRate: number;
  avgCostUsd: number;
  avgDurationMs: number;
  /** Runs counted toward successRate/avgCostUsd/avgDurationMs (infra_failure excluded). */
  sampleSize: number;
  excludedForInfraFailure: number;
}

/**
 * Aggregate one arm's runs, excluding infra_failure runs from the success-rate
 * and cost/duration means (they measure infrastructure, not the prompt).
 *
 * @param runs - Shadow runs for one (arm, knowledge) cell. / 1セル分の実行結果
 * @returns Aggregate with infra failures excluded from the denominator. / 基盤障害を除外した集計
 */
export function aggregateArm(runs: ComparisonRun[]): ArmAggregate {
  const counted = runs.filter((r) => r.failureCause !== 'infra_failure');
  const excludedForInfraFailure = runs.length - counted.length;
  if (counted.length === 0) {
    return {
      successRate: 0,
      avgCostUsd: 0,
      avgDurationMs: 0,
      sampleSize: 0,
      excludedForInfraFailure,
    };
  }
  const successCount = counted.filter((r) => r.success).length;
  const costTotal = counted.reduce((sum, r) => sum + r.costUsd, 0);
  const durationTotal = counted.reduce((sum, r) => sum + r.durationMs, 0);
  return {
    successRate: successCount / counted.length,
    avgCostUsd: costTotal / counted.length,
    avgDurationMs: durationTotal / counted.length,
    sampleSize: counted.length,
    excludedForInfraFailure,
  };
}

/**
 * Decide the comparison verdict from a current-vs-candidate summary
 * (regression checked before improvement, matching judgeExperiment's ordering
 * so a success-rate gain bought with a significant cost/duration regression
 * still does not count as "improved").
 *
 * @param s - Aggregated summary (verdict/uncertainty fields are not read). / 集計済みサマリ
 * @returns The comparison verdict. / 比較判定
 */
export function decideComparisonVerdict(
  s: Omit<ComparisonSummary, 'verdict' | 'uncertainty'>,
): ComparisonVerdict {
  if (s.sampleSize < COMPARISON_MIN_SAMPLE) return 'insufficient_data';
  if (s.successRateDelta <= -COMPARISON_IMPROVE_THRESHOLD) return 'regressed';
  const costOk = s.costDelta <= COMPARISON_COST_TOLERANCE;
  const durationOk = s.durationDeltaMs <= s.baselineDurationMs * COMPARISON_DURATION_TOLERANCE;
  if (s.successRateDelta >= COMPARISON_IMPROVE_THRESHOLD && costOk && durationOk) return 'improved';
  return 'inconclusive';
}

/**
 * Build the full comparison summary from the two `knowledge=with` cells
 * (current vs candidate) — the primary comparison axis per plan.md; the
 * `without` cells are recorded in the ComparisonRecord but do not feed the
 * adoption verdict.
 *
 * @param cells - All four (arm × knowledge) cells for one candidate. / 全4セル
 * @returns Summary with verdict, or null when the `with` cells are missing. / サマリ（with系セル欠如時はnull）
 */
export function buildComparisonSummary(cells: ComparisonCell[]): ComparisonSummary | null {
  const currentWith = findCell(cells, 'current', 'with');
  const candidateWith = findCell(cells, 'candidate', 'with');
  if (!currentWith || !candidateWith) return null;

  const current = aggregateArm(currentWith.runs);
  const candidate = aggregateArm(candidateWith.runs);

  const base: Omit<ComparisonSummary, 'verdict' | 'uncertainty'> = {
    successRateDelta: candidate.successRate - current.successRate,
    costDelta: candidate.avgCostUsd - current.avgCostUsd,
    durationDeltaMs: candidate.avgDurationMs - current.avgDurationMs,
    baselineDurationMs: current.avgDurationMs,
    sampleSize: Math.min(current.sampleSize, candidate.sampleSize),
    excludedForInfraFailure: current.excludedForInfraFailure + candidate.excludedForInfraFailure,
  };
  const verdict = decideComparisonVerdict(base);
  const uncertainty: ComparisonSummary['uncertainty'] =
    verdict === 'insufficient_data'
      ? 'high'
      : base.sampleSize < COMPARISON_MIN_SAMPLE + 2
        ? 'medium'
        : 'low';

  return { ...base, verdict, uncertainty };
}

function findCell(
  cells: ComparisonCell[],
  arm: ComparisonArm,
  knowledge: ComparisonCell['knowledge'],
): ComparisonCell | undefined {
  return cells.find((c) => c.arm === arm && c.knowledge === knowledge);
}
