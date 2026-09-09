import { expect, test } from 'bun:test';
import { validateVerify } from './phase-output-validator';

const report = (row: string) => `# 検証レポート
## 検証結果サマリ
✅ 検証成功。タスクは公開ゲート完了まで未完了。
## テスト結果
15 pass / 0 fail
## チェックリスト
${row}`;

test('pending downstream publication is not a failed implementation test', () => {
  expect(
    validateVerify(
      report('| 完了条件: push・CI green・merge成立 | ❌ 未着手 | 最新コミットの公開待ち |'),
    ).ok,
  ).toBe(true);
});

test.each([
  '| 完了条件: push・CI green・merge成立 | ❌ 失敗 | CI failure |',
  '| API実装 | ❌ 未着手 | push後に対応予定 |',
  '| 完了条件: push・CI green・merge成立 | ❌ 未着手 | Tests 2 failed |',
])('does not excuse actual failures or unimplemented requirements: %s', (row) => {
  expect(validateVerify(report(row)).ok).toBe(false);
});
