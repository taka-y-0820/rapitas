import { expect, test } from 'bun:test';
import { parseReplanVerdict } from './requirement-replan-verdict';

const snapshot = {
  title: '停止保護',
  description: '停止後の自動再開を防ぐ',
  goals: ['停止状態の維持'],
  constraints: ['停止を解除しない'],
  acceptanceCriteria: ['停止状態を維持する'],
  plan: '状態更新処理は変更しない',
  verify: '停止後にin-progressへ復帰した',
};
const valid = {
  kind: 'mismatch',
  reason: '計画の非対象処理が停止状態を上書きする',
  requirementUnmet: true,
  planPreventsRequirement: true,
  preservesRequirements: true,
  requiresOverridingUserConstraint: false,
  criterionIndex: 0,
  criterion: snapshot.acceptanceCriteria[0],
  planQuote: snapshot.plan,
  failureQuote: snapshot.verify,
};

test('resolves source references exactly and rejects invalid ranges', () => {
  const claim = {
    ...valid,
    criterion: undefined,
    planQuote: undefined,
    failureQuote: undefined,
    planLines: [0, 0],
    failureLines: [0, 0],
  };
  const verdict = parseReplanVerdict(JSON.stringify(claim), snapshot);
  expect(verdict.kind).toBe('mismatch');
  if (verdict.kind === 'mismatch') {
    expect(verdict.evidence.criterion).toBe(snapshot.acceptanceCriteria[0]);
    expect(verdict.evidence.planQuote).toBe(snapshot.plan);
    expect(verdict.evidence.failureQuote).toBe(snapshot.verify);
  }
  for (const range of [[-1, 0], [0, 1], [1, 0], [0.5, 0.5], ['0', '0'], [], null]) {
    expect(parseReplanVerdict(JSON.stringify({ ...claim, planLines: range }), snapshot).kind).toBe(
      'unknown',
    );
  }
});

test('requires a grounded complete verdict', () => {
  expect(parseReplanVerdict(JSON.stringify(valid), snapshot).kind).toBe('mismatch');
  expect(
    parseReplanVerdict(JSON.stringify({ ...valid, failureQuote: '架空の失敗' }), snapshot),
  ).toEqual({ kind: 'unknown', reason: 'failure_quote_missing' });
});

test('accepts a single whole JSON fence, but not prose or multiple responses', () => {
  const json = JSON.stringify(valid);
  expect(parseReplanVerdict('```json\n' + json + '\n```', snapshot).kind).toBe('mismatch');
  for (const content of [
    '説明\n```json\n' + json + '\n```',
    '```json\n' + json + '\n```\n追記',
    '```json\n' + json + '\n```\n```json\n{}\n```',
  ]) {
    expect(parseReplanVerdict(content, snapshot).kind).toBe('unknown');
  }
});

test('malformed, partial, and prose-wrapped outputs remain unknown', () => {
  for (const content of [
    '',
    '{}',
    'null',
    '[]',
    '{"pass":true}',
    'text ' + JSON.stringify(valid),
  ]) {
    expect(parseReplanVerdict(content, snapshot).kind).toBe('unknown');
  }
});

test('missing or stringified boolean checks cannot authorize mismatch', () => {
  for (const key of [
    'requirementUnmet',
    'planPreventsRequirement',
    'preservesRequirements',
    'requiresOverridingUserConstraint',
  ]) {
    for (const value of [undefined, 'true', 'false', null]) {
      expect(parseReplanVerdict(JSON.stringify({ ...valid, [key]: value }), snapshot).kind).toBe(
        'unknown',
      );
    }
  }
  expect(
    parseReplanVerdict(
      JSON.stringify({ ...valid, requiresOverridingUserConstraint: true }),
      snapshot,
    ).kind,
  ).toBe('unknown');
});

test('unknown and no mismatch are distinct and need a reason', () => {
  for (const kind of ['unknown', 'no_mismatch'] as const) {
    expect(parseReplanVerdict(JSON.stringify({ kind, reason: '証拠不足' }), snapshot).kind).toBe(
      kind,
    );
    expect(parseReplanVerdict(JSON.stringify({ kind }), snapshot).kind).toBe('unknown');
  }
});
