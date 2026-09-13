/**
 * MetricsCalculator
 *
 * Aggregates `EvalRun` rows into the nine reported figures and persists them
 * as an `EvalMetricSnapshot`.
 *
 * A metric whose denominator is zero is reported as `null`, never `0`: a
 * post-merge regression rate of 0 ("we merged and nothing broke") and one of
 * null ("nothing was ever merged") lead to opposite decisions, and collapsing
 * them into the same number is how a harness starts lying.
 *
 * Pure computation plus one write; it never executes a run.
 */
import type { EvalMetricSnapshotRow, EvalPrismaClient, EvalRunRow } from './eval-prisma-client';

/** The nine reported figures for one slice of runs. */
export interface EvalMetrics {
  sampleSize: number;
  /** Share of first attempts whose acceptance tests went green. */
  firstAttemptAcceptRate: number | null;
  /** Share of corpus tasks green on their final attempt. */
  finalAcceptRate: number | null;
  /** Share of runs declared complete that were not. */
  falseCompletionRate: number | null;
  /** Share of runs that needed a human. */
  humanInterventionRate: number | null;
  /** Mean repair iterations per run. */
  avgRepairAttempts: number | null;
  /** 95th percentile of fault-injection to completion, in ms. */
  stopToCompletionP95Ms: number | null;
  /** Cost in USD divided by passing runs. */
  costUsdPerSuccess: number | null;
  /** Wall-clock ms divided by passing runs. */
  durationMsPerSuccess: number | null;
  /** Share of merged runs whose regression suite then failed. */
  postMergeRegressionRate: number | null;
}

/** Scenario name that measures accuracy rather than fault tolerance. */
export const BASELINE_SCENARIO = 'baseline';

/**
 * Divides, returning null instead of NaN/Infinity for an empty denominator.
 *
 * @param numerator - Dividend / 分子
 * @param denominator - Divisor / 分母
 * @returns The ratio, or null when the denominator is zero / 比率（分母0ならnull）
 */
export function safeRatio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Nearest-rank 95th percentile.
 *
 * @param values - Sample values / 標本値
 * @returns The p95 value, or null for an empty sample / p95値（標本が空ならnull）
 */
export function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

/**
 * Picks the highest-numbered attempt per corpus task.
 *
 * @param runs - Runs to reduce / 集約対象の実行
 * @returns One run per corpus task / コーパスタスクごとに1件
 */
export function finalAttempts(runs: EvalRunRow[]): EvalRunRow[] {
  const byTask = new Map<number, EvalRunRow>();
  for (const run of runs) {
    const current = byTask.get(run.corpusTaskId);
    if (!current || run.attemptNumber > current.attemptNumber) byTask.set(run.corpusTaskId, run);
  }
  return [...byTask.values()];
}

/**
 * Computes every metric for a set of runs.
 *
 * @param runs - Runs in the slice / スライス内の実行
 * @returns The computed metrics / 算出された指標
 */
export function computeMetrics(runs: EvalRunRow[]): EvalMetrics {
  // Accuracy metrics are restricted to baseline: the stub never writes real
  // code, so its failToPass is null and would otherwise drag every rate down.
  const baseline = runs.filter((run) => run.scenario === BASELINE_SCENARIO);
  const faultRuns = runs.filter((run) => run.scenario !== BASELINE_SCENARIO);

  const firstAttempts = baseline.filter((run) => run.attemptNumber === 1);
  const finals = finalAttempts(baseline);
  const passes = baseline.filter((run) => run.outcome === 'pass');

  const stopLatencies = faultRuns
    .map((run) => run.stopToCompletionMs)
    .filter((ms): ms is number => typeof ms === 'number');

  const merged = baseline.filter((run) => run.mergeAttempted);

  return {
    sampleSize: runs.length,
    firstAttemptAcceptRate: safeRatio(
      firstAttempts.filter((run) => run.failToPass === true).length,
      firstAttempts.length,
    ),
    finalAcceptRate: safeRatio(
      finals.filter((run) => run.failToPass === true).length,
      finals.length,
    ),
    falseCompletionRate: safeRatio(
      runs.filter((run) => run.outcome === 'false_complete').length,
      runs.length,
    ),
    humanInterventionRate: safeRatio(
      runs.filter((run) => run.humanInterventionCount > 0).length,
      runs.length,
    ),
    avgRepairAttempts: safeRatio(
      baseline.reduce((sum, run) => sum + run.repairAttempts, 0),
      baseline.length,
    ),
    stopToCompletionP95Ms: percentile95(stopLatencies),
    costUsdPerSuccess: safeRatio(
      passes.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
      passes.length,
    ),
    durationMsPerSuccess: safeRatio(
      passes.reduce((sum, run) => sum + (run.durationMs ?? 0), 0),
      passes.length,
    ),
    postMergeRegressionRate: safeRatio(
      merged.filter((run) => run.mergedRegressionDetected).length,
      merged.length,
    ),
  };
}

/**
 * Computes and persists a metric snapshot for one batch slice.
 *
 * @param prisma - Eval database client / 評価用DBクライアント
 * @param runBatchId - Batch the runs belong to / 対象バッチ
 * @param runs - Runs in the slice / スライス内の実行
 * @param slice - Optional category/scenario labels for the slice / 任意のスライスラベル
 * @returns The persisted snapshot / 永続化されたスナップショット
 */
export async function saveMetricSnapshot(
  prisma: EvalPrismaClient,
  runBatchId: string,
  runs: EvalRunRow[],
  slice: { category?: string | null; scenario?: string | null } = {},
): Promise<EvalMetricSnapshotRow> {
  const metrics = computeMetrics(runs);
  return prisma.evalMetricSnapshot.create({
    data: {
      runBatchId,
      category: slice.category ?? null,
      scenario: slice.scenario ?? null,
      ...metrics,
      // p95 is stored as an integer column; rounding here keeps the write and
      // the reported figure identical.
      stopToCompletionP95Ms:
        metrics.stopToCompletionP95Ms === null ? null : Math.round(metrics.stopToCompletionP95Ms),
    },
  });
}

/**
 * Renders metrics as aligned console lines, matching `eval-gates.ts` output.
 *
 * @param label - Slice label / スライスのラベル
 * @param metrics - Metrics to render / 表示する指標
 * @returns Lines ready to print / 出力用の行
 */
export function formatMetrics(label: string, metrics: EvalMetrics): string[] {
  const pct = (value: number | null): string =>
    value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
  const num = (value: number | null, digits = 2): string =>
    value === null ? 'n/a' : value.toFixed(digits);

  return [
    `${label} (n=${metrics.sampleSize})`,
    `  first-attempt accept : ${pct(metrics.firstAttemptAcceptRate)}`,
    `  final accept         : ${pct(metrics.finalAcceptRate)}`,
    `  false completion     : ${pct(metrics.falseCompletionRate)}`,
    `  human intervention   : ${pct(metrics.humanInterventionRate)}`,
    `  repair attempts avg  : ${num(metrics.avgRepairAttempts)}`,
    `  stop->complete p95   : ${num(metrics.stopToCompletionP95Ms, 0)} ms`,
    `  cost / success       : $${num(metrics.costUsdPerSuccess, 4)}`,
    `  duration / success   : ${num(metrics.durationMsPerSuccess, 0)} ms`,
    `  post-merge regression: ${pct(metrics.postMergeRegressionRate)}`,
  ];
}
