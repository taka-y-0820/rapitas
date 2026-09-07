/**
 * prompt-comparison-metrics.test
 *
 * Verifies classifyFailureCause's 3-way split + success, aggregateArm's
 * infra_failure exclusion, decideComparisonVerdict's boundary values, the
 * baseline-relative cost tolerance (concern #9231), and the standard-error
 * significance floor that keeps small-sample flukes out of 'improved'.
 */
import { describe, it, expect } from 'bun:test';
import {
  classifyFailureCause,
  aggregateArm,
  decideComparisonVerdict,
  standardErrorOfDelta,
  buildComparisonSummary,
  COMPARISON_MIN_SAMPLE,
} from './prompt-comparison-metrics';
import type { ComparisonCell, ComparisonRun } from './prompt-comparison-types';

function run(overrides: Partial<ComparisonRun> = {}): ComparisonRun {
  return {
    taskId: 1,
    executionId: 1,
    success: true,
    costUsd: 1,
    durationMs: 1000,
    failureCause: null,
    ...overrides,
  };
}

describe('classifyFailureCause', () => {
  it('returns null for a completed execution', () => {
    expect(classifyFailureCause({ status: 'completed', errorMessage: null })).toBeNull();
  });

  it('classifies cancelled as user_cancelled', () => {
    expect(classifyFailureCause({ status: 'cancelled', errorMessage: null })).toBe(
      'user_cancelled',
    );
  });

  it('classifies rate-limit/overload error messages as infra_failure', () => {
    expect(
      classifyFailureCause({ status: 'failed', errorMessage: 'Error: Overloaded (529)' }),
    ).toBe('infra_failure');
    expect(classifyFailureCause({ status: 'failed', errorMessage: 'connect ECONNRESET' })).toBe(
      'infra_failure',
    );
  });

  it('falls back to implementation_error for other failures', () => {
    expect(
      classifyFailureCause({ status: 'failed', errorMessage: 'TypeError: x is not a function' }),
    ).toBe('implementation_error');
  });
});

describe('aggregateArm', () => {
  it('excludes infra_failure runs from successRate/avgCostUsd/avgDurationMs', () => {
    const runs = [
      run({ success: true, costUsd: 1, durationMs: 1000 }),
      run({ success: false, costUsd: 0.5, durationMs: 500, failureCause: 'infra_failure' }),
    ];
    const agg = aggregateArm(runs);
    expect(agg.sampleSize).toBe(1);
    expect(agg.excludedForInfraFailure).toBe(1);
    expect(agg.successRate).toBe(1);
    expect(agg.avgCostUsd).toBe(1);
  });

  it('returns zeros when every run is excluded', () => {
    const agg = aggregateArm([run({ failureCause: 'infra_failure', success: false })]);
    expect(agg.sampleSize).toBe(0);
    expect(agg.successRate).toBe(0);
    expect(agg.excludedForInfraFailure).toBe(1);
  });
});

describe('decideComparisonVerdict', () => {
  // 有意性判定を通過できるだけの分散の小ささを持つ既定値。個々のテストは
  // 検証したい軸だけを上書きする。
  const baseline = {
    baselineDurationMs: 100_000,
    baselineCostUsd: 1,
    excludedForInfraFailure: 0,
    currentSuccessRate: 0,
    currentSampleSize: 20,
    candidateSuccessRate: 0,
    candidateSampleSize: 20,
  };

  it('returns insufficient_data below COMPARISON_MIN_SAMPLE', () => {
    expect(
      decideComparisonVerdict({
        successRateDelta: 0.5,
        costDelta: 0,
        durationDeltaMs: 0,
        sampleSize: COMPARISON_MIN_SAMPLE - 1,
        ...baseline,
      }),
    ).toBe('insufficient_data');
  });

  it('returns regressed at the -0.05 boundary (inclusive)', () => {
    expect(
      decideComparisonVerdict({
        successRateDelta: -0.05,
        costDelta: 0,
        durationDeltaMs: 0,
        sampleSize: COMPARISON_MIN_SAMPLE,
        ...baseline,
      }),
    ).toBe('regressed');
  });

  it('withdraws a regression without waiting for statistical significance', () => {
    // 撤回は安全側の判断なので有意性ゲートを課さない。n=5・両アームとも
    // 分散最大(SE≈0.316)でも regressed と判定されること。
    expect(
      decideComparisonVerdict({
        successRateDelta: -0.2,
        costDelta: 0,
        durationDeltaMs: 0,
        sampleSize: COMPARISON_MIN_SAMPLE,
        ...baseline,
        currentSuccessRate: 0.5,
        currentSampleSize: 5,
        candidateSuccessRate: 0.3,
        candidateSampleSize: 5,
      }),
    ).toBe('regressed');
  });

  it('does NOT call a +0.05 gain at n=5 improved — the gap is inside the noise', () => {
    // current 0.5(n=5) vs candidate 0.55(n=5) → SE≈0.317、1.28*SE≈0.406。
    // 生の閾値0.05だけを見ていた旧実装はこれを improved と判定していた。
    expect(
      decideComparisonVerdict({
        successRateDelta: 0.05,
        costDelta: 0,
        durationDeltaMs: 0,
        sampleSize: COMPARISON_MIN_SAMPLE,
        ...baseline,
        currentSuccessRate: 0.5,
        currentSampleSize: 5,
        candidateSuccessRate: 0.55,
        candidateSampleSize: 5,
      }),
    ).toBe('inconclusive');
  });

  it('does NOT adopt 4/5 vs 5/5 at equal cost and duration', () => {
    // 監督が明示した基準例。delta=0.2 に対し SE≈0.179 → 1.28*SE≈0.229。
    // 「両群5件以上かつ差>=0.05」だけを見る判定はこれを improved にしていた。
    expect(
      decideComparisonVerdict({
        successRateDelta: 0.2,
        costDelta: 0,
        durationDeltaMs: 0,
        sampleSize: 5,
        ...baseline,
        currentSuccessRate: 0.8,
        currentSampleSize: 5,
        candidateSuccessRate: 1,
        candidateSampleSize: 5,
      }),
    ).toBe('inconclusive');
  });

  it('returns improved when the gain clears both the 0.05 floor and the significance floor', () => {
    // current 0.5(n=10) vs candidate 0.8(n=10) → SE≈0.201、1.28*SE≈0.257 < 0.3。
    expect(
      decideComparisonVerdict({
        successRateDelta: 0.3,
        costDelta: 0,
        durationDeltaMs: 0,
        sampleSize: 10,
        ...baseline,
        currentSuccessRate: 0.5,
        currentSampleSize: 10,
        candidateSuccessRate: 0.8,
        candidateSampleSize: 10,
      }),
    ).toBe('improved');
  });

  it('returns inconclusive when success improves but cost regresses beyond the baseline fraction', () => {
    expect(
      decideComparisonVerdict({
        successRateDelta: 0.5,
        costDelta: 5, // baselineCostUsd=1 の 500% 増 → 20% 許容を大きく超過
        durationDeltaMs: 0,
        sampleSize: 20,
        ...baseline,
        currentSuccessRate: 0.2,
        candidateSuccessRate: 0.7,
      }),
    ).toBe('inconclusive');
  });

  it('judges the same absolute costDelta differently depending on the baseline cost', () => {
    // 懸念#9231: 旧実装は costDelta を比率閾値0.2とそのまま比較していたため、
    // 基準コストが $0.05 でも $5 でも同じ「$0.2」が閾値になっていた。
    const shared = {
      successRateDelta: 0.5,
      costDelta: 0.5,
      durationDeltaMs: 0,
      sampleSize: 20,
      ...baseline,
      currentSuccessRate: 0.2,
      candidateSuccessRate: 0.7,
    };
    // 基準 $0.05 → 許容 $0.01。+$0.5 は 10倍の悪化。
    expect(decideComparisonVerdict({ ...shared, baselineCostUsd: 0.05 })).toBe('inconclusive');
    // 基準 $5 → 許容 $1。+$0.5 は許容内。
    expect(decideComparisonVerdict({ ...shared, baselineCostUsd: 5 })).toBe('improved');
  });

  it('allows no cost increase at all when the baseline cost is zero', () => {
    const shared = {
      successRateDelta: 0.5,
      durationDeltaMs: 0,
      sampleSize: 20,
      ...baseline,
      baselineCostUsd: 0,
      currentSuccessRate: 0.2,
      candidateSuccessRate: 0.7,
    };
    // 比率が定義できないため、増加は僅かでも許容しない（保守側に倒す）。
    expect(decideComparisonVerdict({ ...shared, costDelta: 0.0001 })).toBe('inconclusive');
    expect(decideComparisonVerdict({ ...shared, costDelta: 0 })).toBe('improved');
  });

  it('returns inconclusive when the delta sits inside the noise band', () => {
    expect(
      decideComparisonVerdict({
        successRateDelta: 0.01,
        costDelta: 0,
        durationDeltaMs: 0,
        sampleSize: COMPARISON_MIN_SAMPLE,
        ...baseline,
      }),
    ).toBe('inconclusive');
  });
});

describe('standardErrorOfDelta', () => {
  it('is zero when either arm has no counted runs', () => {
    expect(
      standardErrorOfDelta({
        currentSuccessRate: 0.5,
        currentSampleSize: 0,
        candidateSuccessRate: 1,
        candidateSampleSize: 5,
      }),
    ).toBe(0);
  });

  it('shrinks as the sample grows for the same rates', () => {
    const rates = { currentSuccessRate: 0.5, candidateSuccessRate: 0.5 };
    const small = standardErrorOfDelta({
      ...rates,
      currentSampleSize: 5,
      candidateSampleSize: 5,
    });
    const large = standardErrorOfDelta({
      ...rates,
      currentSampleSize: 50,
      candidateSampleSize: 50,
    });
    expect(large).toBeLessThan(small);
  });

  it('is zero for two deterministic arms (0% vs 100%)', () => {
    // 分散が0の極端ケースでは有意性フロアが働かず、生の0.05閾値だけが効く。
    expect(
      standardErrorOfDelta({
        currentSuccessRate: 0,
        currentSampleSize: 5,
        candidateSuccessRate: 1,
        candidateSampleSize: 5,
      }),
    ).toBe(0);
  });
});

describe('buildComparisonSummary', () => {
  function cell(
    arm: ComparisonCell['arm'],
    knowledge: ComparisonCell['knowledge'],
    runs: ComparisonRun[],
  ): ComparisonCell {
    return { arm, knowledge, runs };
  }

  it('returns null when a with-knowledge cell is missing', () => {
    const cells = [cell('current', 'with', [run()])];
    expect(buildComparisonSummary(cells)).toBeNull();
  });

  it('computes deltas from the with-knowledge cells only', () => {
    const currentRuns = Array.from({ length: 5 }, () =>
      run({ success: false, costUsd: 1, durationMs: 1000 }),
    );
    const candidateRuns = Array.from({ length: 5 }, () =>
      run({ success: true, costUsd: 1, durationMs: 1000 }),
    );
    const cells = [
      cell('current', 'with', currentRuns),
      cell('candidate', 'with', candidateRuns),
      cell('current', 'without', []),
      cell('candidate', 'without', []),
    ];
    const summary = buildComparisonSummary(cells);
    expect(summary).not.toBeNull();
    expect(summary?.successRateDelta).toBe(1);
    expect(summary?.verdict).toBe('improved');
    expect(summary?.sampleSize).toBe(5);
    // 判定に必要な生数値が summary に載っていること（有意性・コスト比率の根拠）。
    expect(summary?.baselineCostUsd).toBe(1);
    expect(summary?.currentSuccessRate).toBe(0);
    expect(summary?.currentSampleSize).toBe(5);
    expect(summary?.candidateSuccessRate).toBe(1);
    expect(summary?.candidateSampleSize).toBe(5);
    // 両アームとも決定的(分散0) → SE=0 → low。
    expect(summary?.uncertainty).toBe('low');
  });

  it('reports high uncertainty for a wide-variance split even at n=8 per arm', () => {
    // 件数だけを見る旧実装は n>=7 で low を付けていた。実際の分散は大きい。
    const half = (n: number, success: boolean) =>
      Array.from({ length: n }, () => run({ success, costUsd: 1, durationMs: 1000 }));
    const cells = [
      cell('current', 'with', [...half(4, true), ...half(4, false)]),
      cell('candidate', 'with', [...half(4, true), ...half(4, false)]),
    ];
    const summary = buildComparisonSummary(cells);
    expect(summary?.sampleSize).toBe(8);
    expect(summary?.uncertainty).toBe('high');
    // 差が無いので採用もしない。
    expect(summary?.verdict).toBe('inconclusive');
  });
});
