/**
 * failure-reason-markers ユニットテスト
 *
 * classifySessionFailureReason の4パターン（各マーカー1つずつ + マーカーなし）
 * および null/undefined 入力を検証する。
 */
import { describe, expect, test } from 'bun:test';
import {
  API_OVERLOAD_MARKER,
  AUTH_FAILURE_MARKER,
  PROMPT_TOO_LONG_MARKER,
  classifySessionFailureReason,
} from './failure-reason-markers';

describe('classifySessionFailureReason', () => {
  test('PROMPT_TOO_LONG_MARKER を含む → prompt_too_long', () => {
    expect(
      classifySessionFailureReason(`Process exited with code 1\n\n${PROMPT_TOO_LONG_MARKER} ...`),
    ).toBe('prompt_too_long');
  });

  test('AUTH_FAILURE_MARKER を含む → auth', () => {
    expect(
      classifySessionFailureReason(
        `${AUTH_FAILURE_MARKER}（認証情報の期限切れ/無効）。統合ターミナルで claude login を実行してください。`,
      ),
    ).toBe('auth');
  });

  test('API_OVERLOAD_MARKER を含む → transient', () => {
    expect(
      classifySessionFailureReason(
        `Process exited with code 1\n\n${API_OVERLOAD_MARKER}Provider returned 529 Overloaded`,
      ),
    ).toBe('transient');
  });

  test('いずれのマーカーも含まない → other', () => {
    expect(classifySessionFailureReason('Process exited with code 1\n\nsome unrelated error')).toBe(
      'other',
    );
  });

  test('null → other', () => {
    expect(classifySessionFailureReason(null)).toBe('other');
  });

  test('undefined → other', () => {
    expect(classifySessionFailureReason(undefined)).toBe('other');
  });

  test('空文字 → other', () => {
    expect(classifySessionFailureReason('')).toBe('other');
  });

  test('両方のマーカーが含まれる場合は prompt_too_long を優先する', () => {
    expect(
      classifySessionFailureReason(`${PROMPT_TOO_LONG_MARKER} ...\n\n${AUTH_FAILURE_MARKER}...`),
    ).toBe('prompt_too_long');
  });
});
