/** Recognizes only an unattempted publication checklist row, not a passing gate. */
export function isPendingPublicationRow(line: string): boolean {
  const cells = line
    .trim()
    .split('|')
    .map((cell) => cell.trim());
  if (cells.length < 4 || cells[0] !== '') return false;
  // Keep this grammar narrow: an implementation requirement mentioning push
  // must not become exempt. Actual failures elsewhere remain validator inputs.
  return (
    /^(?:完了条件\s*[:：]\s*)?push\s*・\s*CI green\s*・\s*merge成立$/i.test(cells[1]) &&
    /^❌\s*(?:未着手|未実施)$/.test(cells[2]) &&
    !/(?:失敗|不合格|エラー|\bfail(?:ed|ure)?\b|\berror\b|exit\s*(?:code\s*)?[1-9])/i.test(
      cells.slice(3).join(' '),
    )
  );
}
