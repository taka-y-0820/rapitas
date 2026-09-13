/**
 * queue-skip-policy テスト
 *
 * 「今は実行できない」＝再試行しても変わらない結果を、失敗と区別できることを検証する。
 */
import { describe, test, expect } from 'bun:test';
import { isNonRunnableTaskSkip } from './queue-skip-policy';

describe('isNonRunnableTaskSkip', () => {
  test('実行不能を示すガードのメッセージを検出する', () => {
    const skips = [
      'タスクはブロック中のため自動実行をスキップしました',
      'Max retries (3) exceeded — last error: タスクはブロック中のため自動実行をスキップしました',
      'ステータス "awaiting_question" では次のフェーズを実行できません',
      'このタスクはワークフロー無効モードのため自動実行(フェーズ進行)の対象外です。手動実行してください。',
      'Requirement replan review held: requires_human:invalid_json',
      'Requirement replan review held: review_in_progress',
    ];
    for (const s of skips) expect(isNonRunnableTaskSkip(s)).toBe(true);
  });

  test('回帰: blocked のトートロジーで再試行を溶かさない', () => {
    // 実測 2026-08-23: task 602/647 がこのメッセージで retryCount を3消費し、
    // 本当の停止理由(verify_validation_failed)が上書きされて診断不能になった。
    expect(isNonRunnableTaskSkip('タスクはブロック中のため自動実行をスキップしました')).toBe(true);
  });

  test('本物の失敗は従来どおり再試行対象のまま', () => {
    const failures = [
      'research.md was not saved. The workflow phase cannot be completed until the required file is written',
      'Agent output a plan but no actual code changes were made.',
      'verify.md was saved, but the task did not pass the completion gate.',
      "You've hit your monthly spend limit. claude.ai/settings/usage",
      'Phase execution timeout for task 600 (30 minutes)',
    ];
    for (const f of failures) expect(isNonRunnableTaskSkip(f)).toBe(false);
  });

  test('未記録の理由は失敗扱い（従来の挙動を保つ）', () => {
    expect(isNonRunnableTaskSkip(null)).toBe(false);
    expect(isNonRunnableTaskSkip(undefined)).toBe(false);
    expect(isNonRunnableTaskSkip('')).toBe(false);
    expect(isNonRunnableTaskSkip('   ')).toBe(false);
  });
});
