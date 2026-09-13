/**
 * question-options-parser.test
 *
 * Unit tests for parseQuestionOptionsBlock / isQuestionBlockEligibleForAutoAnswer
 * / composeAutoAnswerText.
 */
import { describe, it, expect } from 'bun:test';
import {
  parseQuestionOptionsBlock,
  isQuestionBlockEligibleForAutoAnswer,
  composeAutoAnswerText,
} from './question-options-parser';

function block(json: unknown): string {
  return '```json:options\n' + JSON.stringify(json) + '\n```';
}

const ELIGIBLE_QUESTIONS = {
  questions: [
    {
      id: 'Q1',
      summary: '達成すべきゴール',
      options: [
        { key: 'A', label: '速度を優先する', consequence: '実装は最小限にする' },
        { key: 'B', label: '品質を優先する', consequence: 'テストを手厚くする' },
      ],
      freeTextRequired: false,
      freeTextReason: null,
      recommended: 'B',
      recommendedReason: 'plan.md §テスト戦略の実測値に基づき品質優先が妥当',
    },
  ],
};

describe('parseQuestionOptionsBlock', () => {
  it('parses a valid block with recommended/recommendedReason', () => {
    const parsed = parseQuestionOptionsBlock(block(ELIGIBLE_QUESTIONS));
    expect(parsed).not.toBeNull();
    expect(parsed?.questions[0]).toEqual({
      id: 'Q1',
      summary: '達成すべきゴール',
      options: [
        {
          key: 'A',
          label: '速度を優先する',
          consequence: '実装は最小限にする',
          mutatesGate: false,
        },
        {
          key: 'B',
          label: '品質を優先する',
          consequence: 'テストを手厚くする',
          mutatesGate: false,
        },
      ],
      freeTextRequired: false,
      freeTextReason: null,
      recommended: 'B',
      recommendedReason: 'plan.md §テスト戦略の実測値に基づき品質優先が妥当',
    });
  });

  it('parses mutatesGate on an option when present', () => {
    const parsed = parseQuestionOptionsBlock(
      block({
        questions: [
          {
            id: 'Q1',
            summary: 'しきい値変更',
            options: [{ key: 'A', label: '検出しきい値を緩める', mutatesGate: true }],
            freeTextRequired: false,
            recommended: 'A',
            recommendedReason: '検出漏れを減らすため',
          },
        ],
      }),
    );
    expect(parsed?.questions[0].options[0].mutatesGate).toBe(true);
  });

  it('returns null when freeTextRequired with no options', () => {
    const parsed = parseQuestionOptionsBlock(
      block({
        questions: [
          {
            id: 'Q1',
            summary: 'APIキー',
            options: [],
            freeTextRequired: true,
            freeTextReason: '秘匿情報のため',
          },
        ],
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.questions[0].freeTextRequired).toBe(true);
  });

  it('returns null for malformed JSON instead of throwing', () => {
    const md = '```json:options\n{"questions":[{"id":"Q1","summary":"x",}]}\n```';
    expect(() => parseQuestionOptionsBlock(md)).not.toThrow();
    expect(parseQuestionOptionsBlock(md)).toBeNull();
  });

  it('returns null when the block is absent', () => {
    expect(parseQuestionOptionsBlock('# 質問\n選択肢なしの旧形式質問です。')).toBeNull();
  });

  it('degrades recommended/recommendedReason to empty strings when absent (backward compat)', () => {
    const parsed = parseQuestionOptionsBlock(
      block({
        questions: [
          {
            id: 'Q1',
            summary: 'x',
            options: [{ key: 'A', label: 'a' }],
            freeTextRequired: false,
          },
        ],
      }),
    );
    expect(parsed?.questions[0].recommended).toBe('');
    expect(parsed?.questions[0].recommendedReason).toBe('');
  });

  it('parses a top-level explicit kind field when present', () => {
    const parsed = parseQuestionOptionsBlock(
      block({ kind: 'execution_continuation', ...ELIGIBLE_QUESTIONS }),
    );
    expect(parsed?.kind).toBe('execution_continuation');
  });

  it('leaves kind undefined when absent', () => {
    const parsed = parseQuestionOptionsBlock(block(ELIGIBLE_QUESTIONS));
    expect(parsed?.kind).toBeUndefined();
  });

  it('leaves kind undefined when the top-level kind is not a string', () => {
    const parsed = parseQuestionOptionsBlock(block({ kind: 123, ...ELIGIBLE_QUESTIONS }));
    expect(parsed?.kind).toBeUndefined();
  });
});

describe('isQuestionBlockEligibleForAutoAnswer', () => {
  it('is eligible when recommended points to a valid, non-gate-mutating option with a non-empty reason', () => {
    const parsed = parseQuestionOptionsBlock(block(ELIGIBLE_QUESTIONS));
    expect(parsed).not.toBeNull();
    expect(isQuestionBlockEligibleForAutoAnswer(parsed!)).toEqual({ eligible: true });
  });

  it('is ineligible when any question requires free text', () => {
    const parsed = parseQuestionOptionsBlock(
      block({
        questions: [
          {
            id: 'Q1',
            summary: 'APIキー',
            options: [],
            freeTextRequired: true,
            freeTextReason: '秘匿情報のため',
          },
        ],
      }),
    );
    const result = isQuestionBlockEligibleForAutoAnswer(parsed!);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('free text');
  });

  it('is ineligible when the recommended option mutatesGate', () => {
    const parsed = parseQuestionOptionsBlock(
      block({
        questions: [
          {
            id: 'Q1',
            summary: 'しきい値変更',
            options: [{ key: 'A', label: '検出しきい値を緩める', mutatesGate: true }],
            freeTextRequired: false,
            recommended: 'A',
            recommendedReason: '検出漏れを減らすため',
          },
        ],
      }),
    );
    const result = isQuestionBlockEligibleForAutoAnswer(parsed!);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('mutates a gate');
  });

  it('is ineligible when recommendedReason is empty/whitespace only', () => {
    const parsed = parseQuestionOptionsBlock(
      block({
        questions: [
          {
            id: 'Q1',
            summary: 'x',
            options: [{ key: 'A', label: 'a' }],
            freeTextRequired: false,
            recommended: 'A',
            recommendedReason: '   ',
          },
        ],
      }),
    );
    const result = isQuestionBlockEligibleForAutoAnswer(parsed!);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('recommendedReason');
  });

  it('is ineligible when recommended names no existing option', () => {
    const parsed = parseQuestionOptionsBlock(
      block({
        questions: [
          {
            id: 'Q1',
            summary: 'x',
            options: [{ key: 'A', label: 'a' }],
            freeTextRequired: false,
            recommended: 'Z',
            recommendedReason: 'x',
          },
        ],
      }),
    );
    const result = isQuestionBlockEligibleForAutoAnswer(parsed!);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('not a valid option');
  });

  it('is ineligible when one question of several is unfit (no partial auto-answer)', () => {
    const parsed = parseQuestionOptionsBlock(
      block({
        questions: [
          ELIGIBLE_QUESTIONS.questions[0],
          {
            id: 'Q2',
            summary: 'APIキー',
            options: [],
            freeTextRequired: true,
            freeTextReason: '秘匿情報のため',
          },
        ],
      }),
    );
    expect(isQuestionBlockEligibleForAutoAnswer(parsed!).eligible).toBe(false);
  });
});

describe('composeAutoAnswerText', () => {
  it('composes the recommended option per question with the selections audit list', () => {
    const parsed = parseQuestionOptionsBlock(block(ELIGIBLE_QUESTIONS));
    const { answerText, selections } = composeAutoAnswerText(parsed!);
    expect(answerText).toContain('## Q1: 達成すべきゴール');
    expect(answerText).toContain('選択: 品質を優先する（影響: テストを手厚くする）');
    expect(selections).toEqual([{ questionId: 'Q1', selectedKey: 'B' }]);
  });
});
