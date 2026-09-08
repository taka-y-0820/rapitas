import { expect, test } from 'bun:test';
import { buildReplanReviewInput } from './requirement-replan-prompt';

test('preserves requirements and artifact tails without truncation', () => {
  const snapshot = {
    title: 'test',
    description: 'x'.repeat(3100) + '末尾訂正',
    goals: ['goal'],
    constraints: ['禁止事項'],
    acceptanceCriteria: ['条件'],
    plan: 'p'.repeat(17000) + '末尾の非対象',
    verify: '失敗証拠',
  };
  const input = JSON.parse(buildReplanReviewInput(snapshot)!);
  const { requirementSources, ...original } = input;
  expect(requirementSources.description.join('\n')).toBe(snapshot.description);
  expect(requirementSources.acceptanceCriteria).toEqual(snapshot.acceptanceCriteria);
  expect({
    ...original,
    plan: input.plan.map((r: { text: string }) => r.text).join('\n'),
    verify: input.verify.map((r: { text: string }) => r.text).join('\n'),
  }).toEqual(snapshot);
  expect(buildReplanReviewInput({ ...snapshot, plan: 'p'.repeat(100001) })).toBeNull();
});
