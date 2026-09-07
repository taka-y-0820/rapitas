/**
 * prompt-evolution-addendum-quality テスト
 *
 * 実運用で観測された劣化パターン(コードフェンスのみ / 全行疑問形 /
 * 指示ファイル要求)を注入前に弾けること、および正常な命令形の追記を
 * 誤って弾かないことを検証する。純粋関数のためモック不要。
 */
import { describe, test, expect } from 'bun:test';
import { validateAddendumQuality } from './prompt-evolution-addendum-quality';

describe('validateAddendumQuality — 劣化パターンの検出', () => {
  test('コードフェンスだけの応答は code_fence_only で不合格', () => {
    expect(validateAddendumQuality('```\n\n```')).toEqual({
      valid: false,
      reason: 'code_fence_only',
    });
  });

  test('フェンス内に本文があっても、フェンス外に指示が無ければ不合格', () => {
    const addendum = '```markdown\n- lintを実行する\n- 型チェックを通す\n```';
    expect(validateAddendumQuality(addendum).reason).toBe('code_fence_only');
  });

  test('閉じられていないフェンスも本文なしとして扱う', () => {
    expect(validateAddendumQuality('```text\n- 何かする').reason).toBe('code_fence_only');
  });

  test('空文字・空白のみも本文なしとして不合格', () => {
    expect(validateAddendumQuality('   \n\n ').reason).toBe('code_fence_only');
  });

  test('全行が疑問形なら question_only で不合格', () => {
    const addendum = '- どのファイルを変更すればよいですか？\n- 受入基準はどれですか?';
    expect(validateAddendumQuality(addendum)).toEqual({
      valid: false,
      reason: 'question_only',
    });
  });

  test('指示ファイルを要求する候補は instruction_file_request で不合格', () => {
    const addendum = '- 対象範囲について明記した指示ファイルを提供してください。';
    expect(validateAddendumQuality(addendum)).toEqual({
      valid: false,
      reason: 'instruction_file_request',
    });
  });

  test('英語表記の instruction file 要求も検出する', () => {
    const addendum = '- Provide an instruction file describing the acceptance criteria.';
    expect(validateAddendumQuality(addendum).reason).toBe('instruction_file_request');
  });
});

describe('validateAddendumQuality — 正常系', () => {
  test('命令形の箇条書きは合格する', () => {
    const addendum = '- 提出前に lint を実行する\n- 型チェックを通してから完了を宣言する';
    expect(validateAddendumQuality(addendum)).toEqual({ valid: true });
  });

  test('疑問形が混ざっていても命令行が1行でもあれば合格する', () => {
    const addendum = '- 変更前に既存テストを確認したか？\n- 失敗したテストは全文をログに出力する';
    expect(validateAddendumQuality(addendum).valid).toBe(true);
  });

  test('本文と補助的なコード例が併存する場合は合格する', () => {
    const addendum = '- 次のコマンドで検証する\n```bash\nbun test\n```';
    expect(validateAddendumQuality(addendum).valid).toBe(true);
  });
});
