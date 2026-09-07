import { expect, test } from 'bun:test';
import {
  trialExecutionTotals,
  type TrialExecutionMeasurement,
} from './prompt-comparison-execution-totals';

const execution: TrialExecutionMeasurement = {
  id: 1,
  status: 'completed',
  modelName: 'actual-model',
  costUsd: 1,
  executionTimeMs: 100,
  startedAt: new Date(0),
  completedAt: new Date(100),
};

test('sums all terminal execution costs and reports contributing IDs and models', () => {
  expect(
    trialExecutionTotals([
      execution,
      { ...execution, id: 2, status: 'failed', costUsd: '2', executionTimeMs: 200 },
    ]),
  ).toEqual({
    costUsd: 3,
    durationMs: 300,
    executionIds: [1, 2],
    executionModels: ['actual-model', 'actual-model'],
  });
});
test.each([null, undefined, NaN, Infinity, -1, '', true])(
  'unknown/invalid costs do not become zero (%s)',
  (costUsd) => {
    expect(trialExecutionTotals([{ ...execution, costUsd }])).toBeNull();
  },
);
test('running children and duplicate execution IDs cannot settle a trial', () => {
  expect(trialExecutionTotals([execution, { ...execution, id: 2, status: 'running' }])).toBeNull();
  expect(trialExecutionTotals([execution, execution])).toBeNull();
});
test('timestamp fallback is fixed and missing timing is withheld', () => {
  expect(trialExecutionTotals([{ ...execution, executionTimeMs: null }])?.durationMs).toBe(100);
  expect(
    trialExecutionTotals([{ ...execution, executionTimeMs: null, completedAt: null }]),
  ).toBeNull();
});
