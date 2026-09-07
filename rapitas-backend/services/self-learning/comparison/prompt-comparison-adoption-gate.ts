/**
 * PromptComparisonAdoptionGate
 *
 * The statistical test that decides whether a staged candidate's measured
 * advantage is large enough to adopt at a GIVEN significance level. Pure — no
 * I/O, no clock — so it can be checked against published reference values.
 *
 * Separate from prompt-comparison-metrics on purpose. That module produces
 * DESCRIPTIVE indicators (success-rate delta, cost/duration tolerance, a
 * verdict label); this one answers the different question "could this gap
 * plausibly be chance?". The significance level it is asked to clear is not
 * fixed: prompt-comparison-alpha-ledger allocates a pre-registered budget per
 * candidate and per look, and the caller passes that budget in.
 *
 * Uses the one-sided Fisher exact test rather than a normal approximation.
 * The samples here are small by construction (a limited trial accrues a
 * handful of phases per day), which is exactly where the normal approximation
 * misbehaves — most visibly when an arm is all-success or all-failure and its
 * estimated variance collapses to zero, making a fluke look certain.
 */

/**
 * Natural log of n! via a lgamma-free cumulative sum. The counts here are
 * bounded by a trial's sample size (tens, not millions), so an exact loop is
 * both fast enough and free of the approximation error a Stirling/Lanczos
 * lgamma would introduce.
 *
 * @param n - Non-negative integer. / 非負整数
 * @returns ln(n!). / n! の自然対数
 */
function logFactorial(n: number): number {
  let acc = 0;
  for (let i = 2; i <= n; i++) acc += Math.log(i);
  return acc;
}

/**
 * Natural log of the binomial coefficient C(n, k).
 *
 * Computed in log space so the intermediate factorials of a long-running trial
 * cannot overflow to Infinity and turn a valid p-value into NaN.
 *
 * @param n - Population size. / 全体数
 * @param k - Chosen count. / 選ぶ数
 * @returns ln(C(n, k)), or -Infinity when k is out of range. / 対数二項係数
 */
export function logChoose(n: number, k: number): number {
  if (k < 0 || k > n || n < 0) return -Infinity;
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/**
 * One-sided Fisher exact test: the probability of observing AT LEAST this many
 * candidate-arm successes when the two arms share one success rate.
 *
 * The 2x2 table is
 *
 *   |           | success            | failure            |
 *   | candidate | candidateSuccess   | candidateFailure   |
 *   | current   | currentSuccess     | currentFailure     |
 *
 * and the null distribution of the candidate arm's success count is
 * hypergeometric with population `n`, `totalSuccess` successes and
 * `candidateSuccess + candidateFailure` draws.
 *
 * Only the upper tail is summed: adoption is a one-directional decision, and
 * an unusually BAD candidate is handled by the regression path, not here.
 *
 * @param candidateSuccess - Successful runs on the candidate arm. / 介入アームの成功数
 * @param candidateFailure - Failed runs on the candidate arm. / 介入アームの失敗数
 * @param currentSuccess - Successful runs on the control arm. / 対照アームの成功数
 * @param currentFailure - Failed runs on the control arm. / 対照アームの失敗数
 * @returns Upper-tail p-value in [0, 1]; 1 when either arm is empty. / 片側p値
 */
export function fisherExactOneSidedGreater(
  candidateSuccess: number,
  candidateFailure: number,
  currentSuccess: number,
  currentFailure: number,
): number {
  const candidateTotal = candidateSuccess + candidateFailure;
  const currentTotal = currentSuccess + currentFailure;
  // An arm with no runs carries no evidence — never let it read as significant.
  if (candidateTotal <= 0 || currentTotal <= 0) return 1;

  const n = candidateTotal + currentTotal;
  const totalSuccess = candidateSuccess + currentSuccess;
  const totalFailure = candidateFailure + currentFailure;
  const logDenominator = logChoose(n, candidateTotal);

  let p = 0;
  const maxSuccessInCandidate = Math.min(totalSuccess, candidateTotal);
  for (let i = candidateSuccess; i <= maxSuccessInCandidate; i++) {
    const logTerm =
      logChoose(totalSuccess, i) + logChoose(totalFailure, candidateTotal - i) - logDenominator;
    if (Number.isFinite(logTerm)) p += Math.exp(logTerm);
  }
  // Rounding in log space can push the sum a hair past 1.
  return Math.min(1, p);
}

/** The raw per-arm counts the adoption gate needs (a subset of ComparisonSummary). */
export interface AdoptionGateCounts {
  currentSuccessCount: number;
  currentFailureCount: number;
  candidateSuccessCount: number;
  candidateFailureCount: number;
}

/**
 * Whether the candidate's advantage clears the significance budget allocated
 * to THIS look.
 *
 * The budget is passed in rather than read from a constant because the whole
 * point of the alpha ledger is that each candidate and each look gets a
 * different, pre-registered share of one global error budget. A fixed
 * threshold re-applied on every daily evaluation is what let the family-wise
 * false-adoption rate drift well past 5%.
 *
 * @param counts - Per-arm success/failure counts. / 各アームの成功・失敗数
 * @param alphaKj - Significance budget for this look. / この評価回の有意水準
 * @returns True when the one-sided p-value is below the budget. / 予算未満なら true
 */
export function passesSequentialSignificance(counts: AdoptionGateCounts, alphaKj: number): boolean {
  if (!(alphaKj > 0)) return false;
  const p = fisherExactOneSidedGreater(
    counts.candidateSuccessCount,
    counts.candidateFailureCount,
    counts.currentSuccessCount,
    counts.currentFailureCount,
  );
  return p < alphaKj;
}
