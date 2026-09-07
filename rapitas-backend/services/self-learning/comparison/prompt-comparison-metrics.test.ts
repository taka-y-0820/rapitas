/**
 * prompt-comparison-metrics.test
 *
 * Verifies classifyFailureCause's 3-way split + success, aggregateArm's
 * infra_failure exclusion, and decideComparisonVerdict's boundary values.
 */
import { describe, it, expect } from 'bun:test';
import {
  classifyFailureCause,
  aggregateArm,
  decideComparisonVerdict,
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
  const baseline = { baselineDurationMs: 100_000, excludedForInfraFailure: 0 };

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

  it('returns improved at the +0.05 boundary when cost/duration are within tolerance', () => {
    expect(
      decideComparisonVerdict({
        successRateDelta: 0.05,
        costDelta: 0,
        durationDeltaMs: 0,
        sampleSize: COMPARISON_MIN_SAMPLE,
        ...baseline,
      }),
    ).toBe('improved');
  });

  it('returns inconclusive when success improves but cost regresses beyond tolerance', () => {
    expect(
      decideComparisonVerdict({
        successRateDelta: 0.2,
        costDelta: 5, // far beyond COMPARISON_COST_TOLERANCE
        durationDeltaMs: 0,
        sampleSize: COMPARISON_MIN_SAMPLE,
        ...baseline,
      }),
    ).toBe('inconclusive');
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
  });
});
