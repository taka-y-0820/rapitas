/** Recognizes selected overall failure/partial verdicts, excluding quoted examples. */
export function hasNonpassingVerifyVerdict(content: string): boolean {
  const visible = content
    .replace(/<!--\s*repair-feedback:start\s*-->[\s\S]*?<!--\s*repair-feedback:end\s*-->/gi, '')
    .replace(/```[^\n]*\n[\s\S]*?\n[ \t]*```/g, '');
  return visible.split(/\r?\n/).some((raw) => {
    if (/^\s*>/.test(raw)) return false;
    const line = raw.replace(/\*\*|__/g, '').trim();
    const cell = line.match(
      /^\|\s*(?:全体判定|overall(?:\s+(?:verdict|result|status))?)\s*\|\s*([^|]*)\|/i,
    );
    const value = (
      cell?.[1] ??
      line.replace(
        /^(?:#{1,6}\s*)?(?:(?:冒頭結論|全体判定|overall(?:\s+(?:verdict|result|status))?)\s*[:：]\s*)?/i,
        '',
      )
    ).trim();
    // A vocabulary legend or conditional instruction is not a selected verdict.
    if (/✅|場合|とき|なら|選択|選ぶ|\b(?:if|when|choose)\b/i.test(value)) return false;
    return /^(?:⚠\uFE0F?\s*(?:一部失敗|Partial\b)|❌\s*(?:検証失敗|Fail(?:ed)?\b))/i.test(value);
  });
}
