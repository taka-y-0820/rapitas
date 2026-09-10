import { expect, test } from 'bun:test';
import { shareInflightReplanReview } from './requirement-replan-inflight';
import type { ReplanReviewResult } from './requirement-replan-review';
const snapshot = {
  title: 't',
  description: '',
  goals: [],
  constraints: [],
  acceptanceCriteria: ['a'],
  plan: 'p',
  verify: 'v',
};
const result: ReplanReviewResult = {
  verdict: { kind: 'unknown', reason: 'fixture' },
  snapshotDigest: '',
  durationMs: 1,
  tokensUsed: 1,
  modelName: null,
};

test('concurrent identical reviews share one call but finished results are not cached', async () => {
  let calls = 0;
  const reviewer = async () => {
    calls++;
    return result;
  };
  const [a, b] = await Promise.all([
    shareInflightReplanReview(snapshot, reviewer),
    shareInflightReplanReview(snapshot, reviewer),
  ]);
  expect(calls).toBe(1);
  a.verdict.reason = 'mutated';
  expect(b.verdict.reason).toBe('fixture');
  await shareInflightReplanReview(snapshot, reviewer);
  expect(calls).toBe(2);
});

test('changed evidence uses a distinct review', async () => {
  let calls = 0;
  const reviewer = async () => {
    calls++;
    return result;
  };
  await Promise.all([
    shareInflightReplanReview(snapshot, reviewer),
    shareInflightReplanReview({ ...snapshot, verify: 'changed' }, reviewer),
  ]);
  expect(calls).toBe(2);
});

test('a rejected review is removed so a later request can retry', async () => {
  let calls = 0;
  const reviewer = async () => {
    if (++calls === 1) throw new Error('unavailable');
    return result;
  };
  await expect(shareInflightReplanReview(snapshot, reviewer)).rejects.toThrow('unavailable');
  await shareInflightReplanReview(snapshot, reviewer);
  expect(calls).toBe(2);
});
