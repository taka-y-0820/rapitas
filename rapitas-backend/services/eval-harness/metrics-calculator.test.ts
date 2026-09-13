/**
 * metrics-calculator.test
 *
 * Pins the two properties the reported numbers depend on: an empty denominator
 * is null rather than 0 (0% and "never measured" must not look identical), and
 * accuracy metrics ignore fault-injection runs, whose stub never writes real
 * code and would otherwise drag every rate toward zero.
 *
 * Pure computation — the persistence path is exercised in the integration test.
 */
import { describe, it, expect } from 'bun:test';
import {
  computeMetrics,
  finalAttempts,
  formatMetrics,
  percentile95,
  safeRatio,
} from './metrics-calculator';
import type { EvalRunRow } from './eval-prisma-client';

let nextId = 1;

/** Builds an EvalRun row with sensible defaults. */
function run(overrides: Partial<EvalRunRow> = {}): EvalRunRow {
  return {
    id: nextId++,
    runBatchId: 'batch-test',
    corpusTaskId: 1,
    scenario: 'baseline',
    attemptNumber: 1,
    outcome: 'pass',
    outcomeReason: null,
    failToPass: true,
    passToPass: true,
    humanInterventionCount: 0,
    repairAttempts: 0,
    faultInjectedAt: null,
    stopToCompletionMs: null,
    costUsd: 1,
    durationMs: 1000,
    ciResult: 'success',
    mergeAttempted: false,
    mergedRegressionDetected: false,
    metadata: '{}',
    startedAt: new Date(),
    completedAt: new Date(),
    ...overrides,
  };
}

describe('computeMetrics — empty sample', () => {
  it('reports null (not 0) for every rate', () => {
    const metrics = computeMetrics([]);
    expect(metrics.sampleSize).toBe(0);
    expect(metrics.firstAttemptAcceptRate).toBeNull();
    expect(metrics.finalAcceptRate).toBeNull();
    expect(metrics.falseCompletionRate).toBeNull();
    expect(metrics.humanInterventionRate).toBeNull();
    expect(metrics.avgRepairAttempts).toBeNull();
    expect(metrics.stopToCompletionP95Ms).toBeNull();
    expect(metrics.costUsdPerSuccess).toBeNull();
    expect(metrics.durationMsPerSuccess).toBeNull();
    expect(metrics.postMergeRegressionRate).toBeNull();
  });
});

describe('computeMetrics — all passing', () => {
  it('reports a perfect accept rate and per-success cost', () => {
    const metrics = computeMetrics([run(), run({ corpusTaskId: 2 })]);
    expect(metrics.firstAttemptAcceptRate).toBe(1);
    expect(metrics.finalAcceptRate).toBe(1);
    expect(metrics.falseCompletionRate).toBe(0);
    expect(metrics.costUsdPerSuccess).toBe(1);
    expect(metrics.durationMsPerSuccess).toBe(1000);
  });
});

describe('computeMetrics — all failing', () => {
  it('reports a zero accept rate and null per-success cost', () => {
    const runs = [
      run({ outcome: 'fail', failToPass: false }),
      run({ corpusTaskId: 2, outcome: 'fail', failToPass: false }),
    ];
    const metrics = computeMetrics(runs);
    expect(metrics.firstAttemptAcceptRate).toBe(0);
    // No passing run means there is no per-success figure to report.
    expect(metrics.costUsdPerSuccess).toBeNull();
    expect(metrics.durationMsPerSuccess).toBeNull();
  });
});

describe('computeMetrics — retries', () => {
  it('separates first-attempt from final accept rate', () => {
    const runs = [
      run({ corpusTaskId: 1, attemptNumber: 1, failToPass: false, outcome: 'fail' }),
      run({ corpusTaskId: 1, attemptNumber: 2, failToPass: true }),
      run({ corpusTaskId: 2, attemptNumber: 1, failToPass: true }),
    ];
    const metrics = computeMetrics(runs);
    expect(metrics.firstAttemptAcceptRate).toBeCloseTo(0.5, 5);
    expect(metrics.finalAcceptRate).toBe(1);
  });
});

describe('computeMetrics — scenario separation', () => {
  it('excludes fault runs from accuracy but includes them in false-completion', () => {
    const runs = [
      run({ scenario: 'baseline', failToPass: true }),
      run({ scenario: 'ci_failure', failToPass: null, outcome: 'false_complete' }),
    ];
    const metrics = computeMetrics(runs);
    expect(metrics.firstAttemptAcceptRate).toBe(1);
    expect(metrics.falseCompletionRate).toBeCloseTo(0.5, 5);
  });

  it('computes the stop-completion p95 only from fault runs', () => {
    const runs = [
      run({ scenario: 'baseline', stopToCompletionMs: 99999 }),
      run({ scenario: 'cli_exit_after_stop', stopToCompletionMs: 100 }),
      run({ scenario: 'process_restart', stopToCompletionMs: 300 }),
    ];
    expect(computeMetrics(runs).stopToCompletionP95Ms).toBe(300);
  });
});

describe('computeMetrics — post-merge regression', () => {
  it('is null when nothing was merged', () => {
    expect(computeMetrics([run({ mergeAttempted: false })]).postMergeRegressionRate).toBeNull();
  });

  it('is 0 when merges happened and nothing regressed', () => {
    expect(computeMetrics([run({ mergeAttempted: true })]).postMergeRegressionRate).toBe(0);
  });

  it('counts a regression detected only after merge', () => {
    const runs = [
      run({ mergeAttempted: true, mergedRegressionDetected: true }),
      run({ corpusTaskId: 2, mergeAttempted: true }),
    ];
    expect(computeMetrics(runs).postMergeRegressionRate).toBeCloseTo(0.5, 5);
  });
});

describe('computeMetrics — human intervention and repairs', () => {
  it('counts a run as intervened when the count is above zero', () => {
    const runs = [run({ humanInterventionCount: 2 }), run({ corpusTaskId: 2 })];
    const metrics = computeMetrics(runs);
    expect(metrics.humanInterventionRate).toBeCloseTo(0.5, 5);
  });

  it('averages repair attempts across baseline runs', () => {
    const runs = [run({ repairAttempts: 1 }), run({ corpusTaskId: 2, repairAttempts: 3 })];
    expect(computeMetrics(runs).avgRepairAttempts).toBe(2);
  });
});

describe('safeRatio', () => {
  it('returns null for a zero denominator', () => {
    expect(safeRatio(0, 0)).toBeNull();
  });

  it('divides normally otherwise', () => {
    expect(safeRatio(1, 4)).toBe(0.25);
  });
});

describe('percentile95', () => {
  it('returns null for an empty sample', () => {
    expect(percentile95([])).toBeNull();
  });

  it('returns the only value for a single sample', () => {
    expect(percentile95([42])).toBe(42);
  });

  it('uses nearest rank over 20 values', () => {
    expect(percentile95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
  });
});

describe('finalAttempts', () => {
  it('keeps the highest attempt per corpus task', () => {
    const runs = [
      run({ corpusTaskId: 1, attemptNumber: 1 }),
      run({ corpusTaskId: 1, attemptNumber: 3 }),
      run({ corpusTaskId: 2, attemptNumber: 1 }),
    ];
    const finals = finalAttempts(runs);
    expect(finals).toHaveLength(2);
    expect(finals.find((r) => r.corpusTaskId === 1)?.attemptNumber).toBe(3);
  });
});

describe('formatMetrics', () => {
  it('renders n/a for unmeasured metrics rather than 0', () => {
    const lines = formatMetrics('Overall', computeMetrics([])).join('\n');
    expect(lines).toContain('n=0');
    expect(lines).toContain('n/a');
    expect(lines).not.toContain('0.0%');
  });
});
