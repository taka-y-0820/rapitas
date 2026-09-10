import { expect, test } from 'bun:test';
import { reviewRequirementReplan } from './requirement-replan-review';
import { replanSnapshotDigest } from './requirement-replan-evidence';

const snapshot = {
  title: '停止保護',
  description: '停止を維持',
  goals: ['停止保持'],
  constraints: ['停止を解除しない'],
  acceptanceCriteria: ['完了を変更しない'],
  plan: '状態更新は非対象',
  verify: '完了を上書きした',
};

test('oversized input does not invoke the model', async () => {
  let calls = 0;
  const result = await reviewRequirementReplan(
    { ...snapshot, plan: 'x'.repeat(100001) },
    async () => {
      calls++;
      return { content: '{}', tokensUsed: 0 };
    },
  );
  expect(calls).toBe(0);
  expect(result.verdict).toEqual({ kind: 'unknown', reason: 'input_too_large' });
});

test('provider failure does not authorize state changes or leak error text', async () => {
  const result = await reviewRequirementReplan(snapshot, async () => {
    throw new Error('private error');
  });
  expect(result.verdict).toEqual({ kind: 'unknown', reason: 'review_unavailable' });
  expect(JSON.stringify(result)).not.toContain('private error');
});

test('reviews an immutable full snapshot and preserves measurement provenance', async () => {
  const source = structuredClone(snapshot);
  const result = await reviewRequirementReplan(source, async (options) => {
    const input = JSON.parse(options.messages[0].content);
    expect(input.acceptanceCriteria).toEqual(snapshot.acceptanceCriteria);
    expect(input.plan).toEqual([{ line: 0, text: snapshot.plan }]);
    expect(options.skipCache).toBe(true);
    expect(options.enableRAG).toBe(false);
    source.constraints.push('追加制約');
    return { content: JSON.stringify({ kind: 'no_mismatch', reason: '関連なし' }), tokensUsed: 17 };
  });
  expect(result.snapshotDigest).toBe(replanSnapshotDigest(snapshot));
  expect(result.snapshotDigest).not.toBe(replanSnapshotDigest(source));
  expect(result.tokensUsed).toBe(17);
  expect(result.modelName).toBeNull();
  expect(result.verdict.kind).toBe('no_mismatch');
});
