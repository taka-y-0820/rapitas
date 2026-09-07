import { expect, it } from 'bun:test';
import { buildCheckpointSummary, comparisonCohortIssue } from './prompt-comparison-checkpoint';
import type { ComparisonCell, ComparisonRun } from './prompt-comparison-types';

function run(id: number, success: boolean): ComparisonRun {
  return {
    taskId: id,
    executionId: id,
    success,
    costUsd: 1,
    durationMs: 100,
    failureCause: success ? null : 'implementation_error',
  };
}

it('unknown execution model and invalid outcomes are not treated as comparable evidence', () => {
  const cells: ComparisonCell[] = [
    {
      arm: 'current',
      knowledge: 'with',
      runs: [{ ...run(1, true), role: 'implementer', modelName: null }],
    },
  ];
  expect(comparisonCohortIssue(cells, 'implementer', 'v1')).toBe('actual_model_unknown');
  cells[0].runs[0].modelName = 'reported-model';
  expect(comparisonCohortIssue(cells, 'implementer', 'v1')).toBeNull();
  cells[0].runs[0].costUsd = NaN;
  expect(comparisonCohortIssue(cells, 'implementer', 'v1')).toBe('invalid_run');
});

it('a favorable tail and unequal arm sizes do not enter the 5-run checkpoint', () => {
  const cells: ComparisonCell[] = [
    {
      arm: 'current',
      knowledge: 'with',
      runs: Array.from({ length: 7 }, (_, i) => run(i + 1, i < 2)),
    },
    {
      arm: 'candidate',
      knowledge: 'with',
      runs: Array.from({ length: 9 }, (_, i) => run(i + 20, i < 2 || i >= 5)).reverse(),
    },
  ];
  expect(buildCheckpointSummary(cells)).toMatchObject({
    sampleSize: 5,
    currentSuccessCount: 2,
    candidateSuccessCount: 2,
    verdict: 'inconclusive',
  });
  expect(cells[1].runs[0].executionId).toBe(28);
});

it('crossing 10 observations includes the next complete checkpoint', () => {
  const cells: ComparisonCell[] = [
    {
      arm: 'current',
      knowledge: 'with',
      runs: Array.from({ length: 10 }, (_, i) => run(i + 1, false)),
    },
    {
      arm: 'candidate',
      knowledge: 'with',
      runs: Array.from({ length: 11 }, (_, i) => run(i + 20, true)),
    },
  ];
  expect(buildCheckpointSummary(cells)).toMatchObject({
    sampleSize: 10,
    currentSampleSize: 10,
    candidateSampleSize: 10,
    candidateSuccessCount: 10,
  });
});
