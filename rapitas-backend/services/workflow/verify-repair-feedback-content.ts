/** Pure repair feedback formatting; no database or workflow side effects. */
/** Markers delimiting the appended feedback so the validator can skip it. */
export const REPAIR_FEEDBACK_START = '<!-- repair-feedback:start -->';
export const REPAIR_FEEDBACK_END = '<!-- repair-feedback:end -->';

/** Matches a whole marker-delimited repair-feedback block (for replace/strip). */
const REPAIR_FEEDBACK_BLOCK_RE =
  /<!--\s*repair-feedback:start\s*-->[\s\S]*?<!--\s*repair-feedback:end\s*-->/gi;

/**
 * Sanitize numeric failure tallies (e.g. "1 failed | Tests 3 failed") out of a
 * validator reason before it is appended to verify.md — the next validateVerify
 * pass would otherwise re-detect those counts and make the self-contradiction
 * PERMANENT (task 494's loop).
 *
 * @param reason - Raw validator summary. / バリデータの生の要約
 * @returns Reason with count phrases replaced by a neutral marker. / 数値集計を除去した要約
 */
export function sanitizeRepairReason(reason: string): string {
  return (
    reason
      // ja count phrases first (they may embed digits the en pattern misses)
      .replace(/失敗\s*(?:した)?テスト\s*(?:数|件数)?\s*[:：]?\s*\d+/g, 'テスト失敗あり')
      .replace(/テスト[^。\n]{0,20}?\d+\s*(?:件|個)\s*(?:が)?\s*失敗/g, 'テスト失敗あり')
      .replace(
        /(?:❌|失敗|不合格|不適合|fail(?:ed|ure)?)\s*[:：]?\s*[×x]\s*\d+/gi,
        'テスト失敗あり',
      )
      .replace(/(?:tests?\s+)?\d+\s+failed/gi, 'テスト失敗あり')
  );
}

/** File:line token for a test file, e.g. "services/foo.test.ts:42". */
const FAILURE_LOCATION_RE = /([\w./\\-]+\.(?:test|spec)\.tsx?):(\d+)/;

/**
 * Up to 3 distinct failing-test file:line pointers extracted from verify.md,
 * paired with detail text pulled from trailing/FOLLOWING lines (task 727) —
 * runners typically emit "FAIL foo.test.ts:42\n  should X\n  Error: Y", so
 * re-quoting only the match line would drop the test name / error message.
 */
function extractFailureDetails(text: string): { shown: string[]; more: number } {
  const seen = new Set<string>();
  const shown: string[] = [];
  let more = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = FAILURE_LOCATION_RE.exec(lines[i]);
    if (!m || seen.has(`${m[1]}:${m[2]}`)) continue;
    seen.add(`${m[1]}:${m[2]}`);
    const trailing = lines[i].slice((m.index ?? 0) + m[0].length).trim();
    const following = lines
      .slice(i + 1, i + 3)
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
    const ctx = sanitizeRepairReason([trailing, following].filter(Boolean).join(' ')).slice(0, 100);
    if (shown.length < 3) shown.push(`Failed test: ${m[1]}:${m[2]} — ${ctx}`);
    else more += 1;
  }
  return { shown, more };
}

/**
 * Build the marker-wrapped feedback block appended to verify.md. One short
 * paragraph — never the full rejected file nor a long quote, both of which
 * re-fed the failure counts into the next validation cycle. With verifyContent,
 * also lists up to 3 concrete failing-test pointers (task 727).
 *
 * @param reason - Validator summary (will be sanitized). / バリデータ要約（内部で無害化）
 * @param attempt - 1-based repair attempt. / 試行回数
 * @param verifyContent - Rejected verify.md body, for failure-location extraction. / 却下されたverify.md本文（抽出用）
 * @returns The block including start/end markers. / マーカー付きブロック
 */
export function buildRepairFeedbackBlock(
  reason: string,
  attempt: number,
  verifyContent?: string,
): string {
  const { shown, more } = verifyContent
    ? extractFailureDetails(verifyContent)
    : { shown: [], more: 0 };
  return [
    REPAIR_FEEDBACK_START,
    `# 検証フェーズからの差し戻し（自己修復 ${attempt} 回目）`,
    '',
    `直前の検証 (verify.md) が不合格でした。判定要約: ${sanitizeRepairReason(reason)}`,
    ...(shown.length ? ['', ...shown, ...(more > 0 ? [`...他 ${more} 件`] : [])] : []),
    '',
    '上の verify.md 本文に記載された失敗（失敗テスト・型/lint エラー・未達の受け入れ基準）を確認し、以下を厳守して **実装を修正** してください:',
    '- 失敗を実際に解消する。「成功した」と書くだけ・テスト結果を偽るのは禁止。テストを実際に通すこと。',
    '- スコープ厳守（plan.md 記載外のファイルは変更しない）。',
    '- plan.md 記載外のファイルに原因があっても、元の要件・受け入れ基準・停止/完了の不変条件・必須完了ゲートに関わる失敗は未達のまま扱う。懸念起票だけで免除したり、判定を成功へ書き換えたりしてはならない。計画の修正が必要なら理由と再現証拠を報告し、正規の再計画または保留へ進める。',
    '- 元の要件と無関係な既存失敗は POST /concerns に起票し、無関係と判断した根拠を verify.md に残す。ただし、必須チェックや完了ゲートの成功を代替するものではない。',
    REPAIR_FEEDBACK_END,
  ].join('\n');
}

/**
 * Merge a feedback block into the current verify.md: any PREVIOUS feedback
 * block is replaced (not stacked), keeping the file bounded across attempts.
 *
 * @param prior - Current verify.md content. / 現在のverify.md
 * @param block - New marker-wrapped block. / 新しいブロック
 * @returns Merged content. / マージ後の内容
 */
export function mergeRepairFeedback(prior: string, block: string): string {
  const base = prior.replace(REPAIR_FEEDBACK_BLOCK_RE, '').trim();
  return base ? `${base}\n\n---\n\n${block}` : block;
}
