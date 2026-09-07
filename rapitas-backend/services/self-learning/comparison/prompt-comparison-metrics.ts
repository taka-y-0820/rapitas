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

/**
 * Standard errors the success-rate gain must clear before it counts as an
 * improvement. 1.28 is the one-sided 90% normal quantile — deliberately looser
 * than the conventional 1.645 (95%).
 *
 * A candidate only exists because prompt-evolution-runner already measured the
 * role below SUCCESS_RATE_THRESHOLD, so a genuinely useful addendum should move
 * the rate by tens of points, not by 5. At 1.645 the limited trial's realistic
 * sample rate (a handful of phases per day) would rarely reach "improved" at
 * all, which reproduces the "never promotes" failure this gate exists to avoid.
 * Adjust here, not at the call sites.
 */
export const COMPARISON_SIGNIFICANCE_Z = 1.28;

/** Standard error at or below which the verdict is reported as low uncertainty. */
export const COMPARISON_SE_LOW_MAX = 0.08;

/** Standard error at or below which the verdict is reported as medium uncertainty. */
export const COMPARISON_SE_MEDIUM_MAX = 0.15;

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
 * Standard error of the difference between the two arms' success rates,
 * treating each arm as a binomial proportion:
 * `SE = sqrt(p1(1-p1)/n1 + p2(1-p2)/n2)`.
 *
 * This is what makes "improved" mean something. A raw count threshold
 * (n >= 5) says nothing about whether the observed gap could be noise:
 * 4/5 vs 5/5 clears every count-based rule while its SE is large enough that
 * the same two arms could easily swap places on the next five runs.
 *
 * @param s - Per-arm rates and sizes from the summary. / 各アームの成功率と件数
 * @returns Standard error of successRateDelta (0 when either arm is empty). / 差分の標準誤差
 */
export function standardErrorOfDelta(
  s: Pick<
    ComparisonSummary,
    'currentSuccessRate' | 'currentSampleSize' | 'candidateSuccessRate' | 'candidateSampleSize'
  >,
): number {
  if (s.currentSampleSize <= 0 || s.candidateSampleSize <= 0) return 0;
  const varCurrent = (s.currentSuccessRate * (1 - s.currentSuccessRate)) / s.currentSampleSize;
  const varCandidate =
    (s.candidateSuccessRate * (1 - s.candidateSuccessRate)) / s.candidateSampleSize;
  return Math.sqrt(varCurrent + varCandidate);
}

/**
 * Decide the comparison verdict from a current-vs-candidate summary
 * (regression checked before improvement, matching judgeExperiment's ordering
 * so a success-rate gain bought with a significant cost/duration regression
 * still does not count as "improved").
 *
 * Two guards beyond the raw thresholds:
 *
 * 1. The improvement must clear `COMPARISON_SIGNIFICANCE_Z` standard errors,
 *    not just the fixed 0.05 — so a small-sample fluke is `inconclusive` and
 *    keeps collecting rather than being adopted.
 * 2. The cost tolerance is applied as a FRACTION of the baseline arm's cost,
 *    mirroring the duration check. Comparing an absolute USD delta against a
 *    fractional constant was concern #9231.
 *
 * Regression is deliberately NOT significance-gated: withdrawing a candidate
 * that looks worse is the safe direction, and requiring statistical proof
 * before withdrawing would keep a harmful addendum injected for longer.
 *
 * @param s - Aggregated summary (verdict/uncertainty fields are not read). / 集計済みサマリ
 * @returns The comparison verdict. / 比較判定
 */
export function decideComparisonVerdict(
  s: Omit<ComparisonSummary, 'verdict' | 'uncertainty'>,
): ComparisonVerdict {
  if (s.sampleSize < COMPARISON_MIN_SAMPLE) return 'insufficient_data';
  if (s.successRateDelta <= -COMPARISON_IMPROVE_THRESHOLD) return 'regressed';
  // A zero baseline cost cannot express a fraction, so only a non-increase is
  // acceptable there — never widen the gate by treating 0 as "anything goes".
  const costOk =
    s.baselineCostUsd > 0
      ? s.costDelta <= s.baselineCostUsd * COMPARISON_COST_TOLERANCE
      : s.costDelta <= 0;
  const durationOk = s.durationDeltaMs <= s.baselineDurationMs * COMPARISON_DURATION_TOLERANCE;
  const significanceFloor = COMPARISON_SIGNIFICANCE_Z * standardErrorOfDelta(s);
  const improvedEnough =
    s.successRateDelta >= Math.max(COMPARISON_IMPROVE_THRESHOLD, significanceFloor);
  if (improvedEnough && costOk && durationOk) return 'improved';
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
    baselineCostUsd: current.avgCostUsd,
    currentSuccessRate: current.successRate,
    currentSampleSize: current.sampleSize,
    candidateSuccessRate: candidate.successRate,
    candidateSampleSize: candidate.sampleSize,
    sampleSize: Math.min(current.sampleSize, candidate.sampleSize),
    excludedForInfraFailure: current.excludedForInfraFailure + candidate.excludedForInfraFailure,
  };
  const verdict = decideComparisonVerdict(base);
  // Uncertainty reports the measured spread, not the row count: two arms of
  // 8 runs each split 50/50 are far less certain than two arms of 6 split
  // 0/100, and a count-based label called the first one "low".
  const se = standardErrorOfDelta(base);
  const uncertainty: ComparisonSummary['uncertainty'] =
    verdict === 'insufficient_data'
      ? 'high'
      : se <= COMPARISON_SE_LOW_MAX
        ? 'low'
        : se <= COMPARISON_SE_MEDIUM_MAX
          ? 'medium'
          : 'high';

  return { ...base, verdict, uncertainty };
}

function findCell(
  cells: ComparisonCell[],
  arm: ComparisonArm,
  knowledge: ComparisonCell['knowledge'],
): ComparisonCell | undefined {
  return cells.find((c) => c.arm === arm && c.knowledge === knowledge);
}
