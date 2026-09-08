import { expect, test } from 'bun:test';
import { validateVerify } from './phase-output-validator';

const report = (verdict: string) => `# 検証レポート
## 検証結果サマリ
${verdict}
## テスト結果
148/148 passed. All tests pass, but a high priority operational defect remains.
## チェックリスト
9/10 implemented.`;

test.each([
  '| 全体判定 | ⚠️ 一部失敗 |',
  '冒頭結論: **⚠️ 一部失敗**。保留処理が動作しない。',
  '| Overall verdict | ⚠️ Partial |',
  '⚠️ Partial — one acceptance criterion remains unmet.',
  '| Overall result | ❌ Fail |',
])('rejects the explicit nonpassing overall verdict: %s', (verdict) => {
  const result = validateVerify(report(verdict));
  expect(result.ok).toBe(false);
  expect(result.severity).toBeGreaterThanOrEqual(80);
});

test.each([
  '> | 全体判定 | ⚠️ 一部失敗 |',
  '```text\n| 全体判定 | ⚠️ 一部失敗 |\n```',
  '| 全体判定 | ✅ 検証成功 / ⚠️ 一部失敗 |',
  '⚠️ 一部失敗の場合は再検証すること。',
  '<!-- repair-feedback:start -->\n| 全体判定 | ⚠️ 一部失敗 |\n<!-- repair-feedback:end -->',
])('does not treat an example or prior verdict as the current failure: %s', (example) => {
  expect(validateVerify(report(`| 全体判定 | ✅ 検証成功 |\n${example}`)).ok).toBe(true);
});
