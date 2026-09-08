import { describe, expect, test } from 'bun:test';
import {
  replanSnapshotDigest,
  validateReplanEvidence,
  type ReplanEvidence,
  type ReplanSnapshot,
} from './requirement-replan-evidence';

const snapshot: ReplanSnapshot = {
  title: '質問待ちの状態保護',
  description: '停止・完了タスクを質問待ちに戻さない。',
  goals: ['正しい状態遷移'],
  constraints: ['バックエンドプロセスを停止しない'],
  acceptanceCriteria: ['停止・完了を質問待ちと混同しない', '通常の質問保存を維持する'],
  plan: 'status-transition.ts の内部変更は非対象。',
  verify: '再現テスト: completed が awaiting_question に上書きされた。',
};
const evidence: ReplanEvidence = {
  snapshotDigest: replanSnapshotDigest(snapshot),
  criterionIndex: 0,
  criterion: snapshot.acceptanceCriteria[0],
  planQuote: snapshot.plan,
  failureQuote: snapshot.verify,
};

describe('requirement replan evidence grounding', () => {
  test('grounds task901-style evidence without a special path', () => {
    expect(validateReplanEvidence(snapshot, evidence)).toBeNull();
  });
  test('rejects changes to any criterion or the tail of either artifact', () => {
    for (const changed of [
      { ...snapshot, title: '別のタスク' },
      { ...snapshot, description: snapshot.description + '追加の訂正' },
      { ...snapshot, goals: ['変更した目標'] },
      { ...snapshot, constraints: [] },
      { ...snapshot, acceptanceCriteria: [...snapshot.acceptanceCriteria, '追加条件'] },
      { ...snapshot, acceptanceCriteria: [...snapshot.acceptanceCriteria].reverse() },
      { ...snapshot, plan: snapshot.plan + '非対象を撤回する。' },
      { ...snapshot, verify: snapshot.verify + '再実行では成功。' },
    ]) {
      expect(validateReplanEvidence(changed, evidence)).toBe('stale_snapshot');
    }
  });
  test('does not accept a rewritten criterion or an invalid index', () => {
    expect(validateReplanEvidence(snapshot, { ...evidence, criterion: '懸念起票で完了' })).toBe(
      'criterion_mismatch',
    );
    for (const criterionIndex of [-1, 0.5, 2, NaN]) {
      expect(validateReplanEvidence(snapshot, { ...evidence, criterionIndex })).toBe(
        'criterion_mismatch',
      );
    }
  });
  test('requires nonempty exact quotations from both current artifacts', () => {
    for (const planQuote of ['', '  ', '存在しない非対象記述']) {
      expect(validateReplanEvidence(snapshot, { ...evidence, planQuote })).toBe(
        'plan_quote_missing',
      );
    }
    for (const failureQuote of ['', '  ', '存在しない失敗']) {
      expect(validateReplanEvidence(snapshot, { ...evidence, failureQuote })).toBe(
        'failure_quote_missing',
      );
    }
  });
});
