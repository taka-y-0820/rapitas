/** Compare an explicit overall test rate with a single file-table total.
 * Repeated runs and individual suites are not added together.
 */
export function findTestCountContradiction(content: string): string | null {
  const text = content.replace(/```[^\n]*\n[\s\S]*?\n[ \t]*```/g, '');
  const summary = text.match(/^\|\s*テスト通過率\s*\|\s*\*{0,2}(\d+)\s*\/\s*(\d+)/m);
  if (!summary) return null;
  const totals: RegExpMatchArray[] = [];
  for (const table of text.split(/\n\s*\n/)) {
    if (!/^\|\s*ファイル\s*\|\s*通過\s*\/\s*全件\s*\|/m.test(table)) continue;
    const total = table.match(
      /^\|\s*合計(?:（各ファイル単体実行の合算）)?\s*\|\s*\*{0,2}(\d+)\s*\/\s*(\d+)/m,
    );
    if (total) totals.push(total);
  }
  // Multiple scoped tables cannot safely be interpreted as one overall suite.
  if (totals.length !== 1) return null;
  const total = totals[0];
  if (+summary[1] === +total[1] && +summary[2] === +total[2]) return null;
  return `Test count mismatch: summary ${summary[1]}/${summary[2]}, file total ${total[1]}/${total[2]}. Report one consistent count for the same test scope; do not add repeated runs.`;
}
