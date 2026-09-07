import { expect, test } from 'bun:test';
import { mergeFallbackSegmentTime } from './execution-attempt-metrics';

const primary = {
  success: false,
  output: 'first',
  costUsd: 0.75,
  executionTimeMs: 7000,
  modelName: 'first-model',
};
const fallback = {
  success: true,
  output: 'final',
  costUsd: 1.25,
  executionTimeMs: 123000,
  modelName: 'last-model',
};
test('cost and measured attempt provenance survive a same-ID fallback', () => {
  const result = mergeFallbackSegmentTime(primary, fallback);
  expect(result).toMatchObject({
    success: true,
    output: 'final',
    costUsd: 2,
    executionTimeMs: 130000,
    modelName: 'last-model',
  });
  expect(result.attemptMetrics).toEqual([
    { success: false, costUsd: 0.75, executionTimeMs: 7000, modelName: 'first-model' },
    { success: true, costUsd: 1.25, executionTimeMs: 123000, modelName: 'last-model' },
  ]);
  expect(primary.costUsd).toBe(0.75);
});
test('cold restart followed by provider fallback retains three attempts without double counting', () => {
  const result = mergeFallbackSegmentTime(mergeFallbackSegmentTime(primary, primary), fallback);
  expect(result.costUsd).toBe(2.75);
  expect(result.executionTimeMs).toBe(137000);
  expect(result.attemptMetrics).toHaveLength(3);
});
test.each([undefined, NaN, Infinity, -1])(
  'unknown primary cost prevents a deceptively cheap total (%s)',
  (costUsd) => {
    const result = mergeFallbackSegmentTime({ ...primary, costUsd }, fallback);
    expect(result.costUsd).toBeUndefined();
    expect(result.attemptMetrics![0].costUsd).toBeNull();
  },
);
test('zero cost is known and a failed fallback stays failed', () => {
  expect(
    mergeFallbackSegmentTime({ ...primary, costUsd: 0 }, { ...fallback, success: false }),
  ).toMatchObject({ success: false, costUsd: 1.25 });
});
