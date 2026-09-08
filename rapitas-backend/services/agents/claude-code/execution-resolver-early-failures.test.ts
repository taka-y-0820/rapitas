/**
 * execution-resolver-early-failures ユニットテスト
 *
 * 抽出後の4述語が単体で期待どおりtrue/falseを返すことを検証する。
 */
import { describe, expect, test } from 'bun:test';
import {
  detectApiOverload,
  detectAuthFailure,
  detectModelMismatch,
  detectPromptTooLong,
} from './execution-resolver-early-failures';

describe('detectModelMismatch', () => {
  test('モデル不一致メッセージがあれば true', () => {
    expect(
      detectModelMismatch(
        "There's an issue with the selected model (gpt-5). Run --model to pick a different model.",
      ),
    ).toBe(true);
  });

  test('無関係な出力では false', () => {
    expect(detectModelMismatch('all tests passed')).toBe(false);
  });
});

describe('detectAuthFailure', () => {
  test('401 認証失敗メッセージがあれば true', () => {
    expect(
      detectAuthFailure(
        'Failed to authenticate. API Error: 401 Invalid authentication credentials',
      ),
    ).toBe(true);
  });

  test('無関係な出力では false', () => {
    expect(detectAuthFailure('build failed for unrelated reasons')).toBe(false);
  });
});

describe('detectApiOverload', () => {
  test('idleTimeoutForceKilled=true かつ 529 出力 → true', () => {
    expect(detectApiOverload('API Error: 529 Overloaded', true)).toBe(true);
  });

  test('idleTimeoutForceKilled=false なら 529 出力があっても false', () => {
    expect(detectApiOverload('API Error: 529 Overloaded', false)).toBe(false);
  });

  test('idleTimeoutForceKilled=true でも 529 出力が無ければ false', () => {
    expect(detectApiOverload('some other error', true)).toBe(false);
  });
});

describe('detectPromptTooLong', () => {
  test('主パターン "Prompt is too long"（task894実文言）→ true', () => {
    expect(detectPromptTooLong('API Error: Prompt is too long')).toBe(true);
  });

  test('補助パターン "input is too long" → true', () => {
    expect(detectPromptTooLong('Error: input is too long for this model')).toBe(true);
  });

  test('補助パターン "context length exceeded" → true', () => {
    expect(detectPromptTooLong('context length exceeded')).toBe(true);
  });

  test('補助パターン "maximum context length" → true', () => {
    expect(detectPromptTooLong("This model's maximum context length is 200000 tokens")).toBe(true);
  });

  test('大文字小文字を区別しない', () => {
    expect(detectPromptTooLong('PROMPT IS TOO LONG')).toBe(true);
  });

  test('無関係な出力では false', () => {
    expect(detectPromptTooLong('all tests passed')).toBe(false);
  });
});
