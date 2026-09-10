import { expect, test } from 'bun:test';
import { findTestCountContradiction } from './verify-test-counts';
const table =
  '| ファイル | 通過/全件 |\n| --- | --- |\n| a.ts | 69/69 |\n| 合計（各ファイル単体実行の合算） | 69/69 |';
test('rejects task 911 inconsistent summary without adding reruns', () => {
  expect(
    findTestCountContradiction(
      `| テスト通過率 | **137/137 (100%)** |\n\n${table}\n| 再実行 | 64/64 |`,
    ),
  ).toContain('137/137, file total 69/69');
});
test('accepts consistent totals and distinct repeated-run counts', () => {
  expect(
    findTestCountContradiction(`| テスト通過率 | **69/69** |\n\n${table}\n| 再実行 | 64/64 |`),
  ).toBeNull();
});
test('does not interpret quoted evidence or multiple scoped totals as overall', () => {
  expect(
    findTestCountContradiction(`| テスト通過率 | 137/137 |\n\n\`\`\`text\n${table}\n\`\`\``),
  ).toBeNull();
  expect(
    findTestCountContradiction(`| テスト通過率 | 137/137 |\n\n${table}\n\n${table}`),
  ).toBeNull();
});
