/**
 * phase-output-validator
 *
 * Validates that workflow phase artifacts (research.md, plan.md, verify.md)
 * contain the required sections so downstream phases have what they need.
 *
 * If validation fails, the orchestrator can:
 *   - mark the phase as `needs_retry` (force the same role to re-run with
 *     a stricter "you missed sections X / Y / Z" prompt), OR
 *   - escalate to a different agent (e.g. swap codex → claude-code for
 *     planning if codex produced a thin plan).
 *
 * Section requirements are intentionally moderate — we want to catch obvious
 * misses (no "設計判断の根拠" in plan.md) without rejecting cosmetic variation.
 */
import { PLAN_FILES_SECTION_HEADINGS } from './plan-declared-files';
import { hasNonpassingVerifyVerdict } from './nonpassing-verify-verdict';

export interface ValidationResult {
  ok: boolean;
  /** Section names that were expected but not found. / 不足セクション一覧 */
  missingSections: string[];
  /** Severity score: 0=fine, 100=unusable. / 重大度 */
  severity: number;
  /** Short message for logs / UI. / ログ用要約 */
  summary: string;
}

// NOTE: '類似機能' is the current template heading; '類似実装' is accepted for backward compatibility.
// NOTE: OR-groups absorb the heading vocabulary planners/researchers actually
// produce. Task 551: an approved 9.5KB plan that answered every critic demand
// was archived by this validator solely because it titled its sections
// 「確定仕様」/「完了の定義」 instead of the exact template words. Synonym
// tolerance here must err toward acceptance — substance is judged by the
// phase critic, not by heading spelling.
const RESEARCH_REQUIRED_SECTIONS: (string | string[])[] = [
  ['影響範囲', '影響分析', '統合点'],
  '依存',
  ['類似機能', '類似実装', '重複チェック', '既存実装'],
  'リスク',
  'テスト戦略',
];

const PLAN_REQUIRED_SECTIONS: (string | string[])[] = [
  ['設計判断の根拠', '設計判断', '設計方針', '確定仕様', '技術選定'],
  ['実装チェックリスト', 'チェックリスト'],
  // NOTE: shared with the risk router's declared-files extractor so the two
  // can never drift — a plan this validator accepts always yields a section there.
  [...PLAN_FILES_SECTION_HEADINGS],
  'リスク',
  ['完了条件', '完了の定義', '完了基準', 'definition of done'],
];

// OR-group: any of the listed headings satisfies the 検証結果サマリ requirement
const VERIFY_REQUIRED_SECTIONS: (string | string[])[] = [
  'テスト結果',
  'チェックリスト',
  ['検証結果サマリ', '検証結果', '検証サマリ', '総合評価', '実装結果検証', '検証レポート'],
];

/**
 * Patterns that NEVER appear in a legitimate workflow artifact — their presence
 * means the agent's streamed execution log / stream-json leaked into the md
 * (a "broken" file). Any single match flags pollution.
 */
const HARD_NOISE_PATTERNS: RegExp[] = [
  /\[System:\s*(?:init|thinking_tokens)\]/i,
  /\[Claude Code\]\s*(?:Starting execution|Working directory|Process PID|Timeout|Prompt:)/i,
  /^\s*\[Result:\s*\w+/im,
  /^\s*\{"type":\s*"/m, // stream-json event
  /^\s*data:\s*\{/m, // SSE frame
  /\[[0-9;]*m/, // ANSI color escape
];

/**
 * Agent-log line shapes that occasionally appear legitimately (e.g. quoted in a
 * report), so they only flag pollution in QUANTITY.
 */
const SOFT_NOISE_LINE =
  /^\s*\[(?:Tool|Tool Done|Tool Error|Command|エージェント|実行開始|継続実行|System Error|調査完了|計画作成完了|実装完了|検証完了|フェーズ完了)\b/i;

/**
 * Whether an md is "broken" by agent log / stream output leaking into it. Used
 * to stop a corrupted research/plan/verify from being accepted, auto-approved,
 * reused, or implemented against. Any HARD pattern, or enough SOFT log lines.
 *
 * @param content - md body to inspect / 検査するmd本文
 * @returns true when the file looks log-polluted / ログ混入で壊れていれば true
 */
export function looksLogPolluted(content: string | null | undefined): boolean {
  if (!content) return false;
  if (HARD_NOISE_PATTERNS.some((re) => re.test(content))) return true;
  const lines = content.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return false;
  const noisy = nonEmpty.filter((l) => SOFT_NOISE_LINE.test(l)).length;
  // Many agent-log lines (absolute) or a large fraction → polluted.
  return noisy >= 6 || noisy / nonEmpty.length >= 0.2;
}

/** A polluted-file validation result (unusable; forces re-generation). */
function pollutedResult(label: string): ValidationResult {
  return {
    ok: false,
    missingSections: [],
    severity: 100,
    summary: `${label} is corrupted: agent execution log / stream output leaked into the file`,
  };
}

/**
 * Validate research.md content.
 */
export function validateResearch(content: string): ValidationResult {
  if (looksLogPolluted(content)) return pollutedResult('research.md');
  return validateSections(content, RESEARCH_REQUIRED_SECTIONS, 'research.md');
}

/**
 * Validate plan.md content. The "設計判断の根拠" section is the most
 * critical — without it, implementers will ask questions or guess.
 */
export function validatePlan(content: string): ValidationResult {
  if (looksLogPolluted(content)) return pollutedResult('plan.md');
  const result = validateSections(content, PLAN_REQUIRED_SECTIONS, 'plan.md');
  // Up-weight the criticality of "設計判断の根拠"
  if (result.missingSections.includes('設計判断の根拠')) {
    result.severity = Math.max(result.severity, 80);
    result.summary = `${result.summary} | rationale section missing — implementer will likely ask questions`;
    result.ok = false;
  }
  return result;
}

/**
 * Remove regions that must NOT feed the self-contradiction scan:
 * (a) marker-delimited repair-feedback blocks appended by verify-self-repair —
 *     they quote the PREVIOUS rejection (with failure wording), and re-scanning
 *     them made a past contradiction permanent (task 494's repair loop);
 * (b) ```text fenced blocks — the verifier is instructed to put deliberate-RED
 *     (false-positive verification) log excerpts there, which legitimately
 *     contain failure lines for a CORRECT implementation;
 * (c) the "残課題 / フォローアップ" (unresolved concerns) section — by design
 *     (see workflow-context-builder.ts's prompt) this section documents ALREADY
 *     -explained caveats and pre-existing/false-positive findings from OTHER
 *     tools (e.g. an automated scope-checker's own ❌ markers), not the
 *     verifier's own pass/fail verdict on THIS task. Task 504: an honest,
 *     fully-passing verify.md was blocked because this section discussed a
 *     scope-check's ❌ result across two lines, one of which forward-referenced
 *     the other ("scope ❌ 4件は §残課題 で扱う") without itself containing a
 *     dismissal word on the same line.
 * Other fence types are intentionally kept scannable: genuine test output
 * evidence is usually pasted in bare ``` fences and must stay detectable.
 * Section requirements and verdict-phrase checks still see the full
 * (un-stripped) `content` — only the contradiction scan uses this output.
 *
 * @param content - verify.md body / verify.md 本文
 * @returns Content with non-evidence regions removed / 走査対象本文
 */
function stripNonEvidenceRegions(content: string): string {
  return content
    .replace(/<!--\s*repair-feedback:start\s*-->[\s\S]*?<!--\s*repair-feedback:end\s*-->/gi, '')
    .replace(/```text[^\S\n]*\n[\s\S]*?\n[ \t]*```/gi, '')
    .replace(/(^|\n)#{1,4}\s*残課題[^\n]*\n[\s\S]*?(?=\n#{1,4}\s|$)/i, '$1');
}

/**
 * Validate verify.md content.
 *
 * In addition to the structural section check, look for the contradiction
 * pattern where the report says "全テスト通過 / all tests pass" but the
 * embedded test summary indicates `failed` / `exit 1` / `× N tests`. The
 * agent has been observed hallucinating a "全12テスト通過" claim while
 * the implementer's changes actually broke 10 tests (gemini-2.5-flash
 * verifier, observed in production). When that contradiction is
 * detected, return `ok=false` with severity=80 so the orchestrator's
 * existing "treat as failed when validation fails" branch fires.
 *
 * @param content - verify.md body / verify.md 本文
 * @returns Validation result with contradiction details when applicable
 */
export function validateVerify(content: string): ValidationResult {
  if (looksLogPolluted(content)) return pollutedResult('verify.md');
  if (hasNonpassingVerifyVerdict(content)) {
    return {
      ok: false,
      missingSections: [],
      severity: 90,
      summary:
        'verify.md explicitly reports a failed or partial overall verdict; repair is required.',
    };
  }
  const sectionResult = validateSections(content, VERIFY_REQUIRED_SECTIONS, 'verify.md');
  if (!sectionResult.ok) return sectionResult;

  const lower = content.toLowerCase();
  // Contradiction scanning runs on the stripped text so repair-feedback quotes
  // and ```text (deliberate-RED evidence) fences cannot fake a failure signal.
  const scanText = stripNonEvidenceRegions(content);
  const claimsAllPass =
    /全[テt]?\d*\s*テスト[^❌]{0,30}通過|all\s+tests?\s+pass|all\s+\d+\s+tests?\s+passed|✅\s*検証成功|✅\s*pass/i.test(
      scanText,
    ) || /すべて(?:の)?テスト[^❌]{0,40}(成功|通過|パス)/.test(scanText);
  // Failure signals must indicate an ACTUAL non-zero failure. Earlier patterns
  // matched bare prose ("失敗テスト", "failing test") and the instructed
  // "失敗テスト数: 0" field, so any task that FIXES a failure (e.g. ENOENT/error
  // handling) — whose verify.md legitimately discusses failure scenarios and
  // reports "0 failed" — was wrongly flagged as a hallucinated pass and blocked.
  // Require a non-zero count (or an explicit fail mark) instead.
  const failureSignals = [
    // "10 failed" — not "0 failed", and not an IDENTIFIER followed by a status
    // word: task 718's verify.md cited "session #3156 failed 時刻 …" as the
    // evidence it was told to record, and the gate read 3156 failing tests
    // (the UI then showed ~3000 failures for a report whose every suite was
    // green). A number written with a # sigil is an id, never a count.
    /(?<!#)\b([1-9]\d*)\s+failed/i,
    /tests?\s+([1-9]\d*)\s+failed/i,
    /test\s+files?[\s\S]{0,80}?([1-9]\d*)\s+failed/i,
    /失敗\s*(?:した)?テスト\s*(?:数|件数)?\s*[:：]?\s*([1-9]\d*)/, // "失敗テスト数: 3", not ": 0"
    /テスト[^。\n]{0,20}?([1-9]\d*)\s*(?:件|個)\s*(?:が)?\s*失敗/, // "テストが3件失敗"
    // NOTE: the "exit 1" runner signal is handled separately below (exitFailure)
    // with line-level context so PROSE documenting expected exit codes is excluded.
    // A ×N count ONLY when ATTACHED to a failure verdict — "❌ ×3", "失敗 ×2",
    // "failed ×5". A bare "×2" in passing prose ("ケース×2", "✅×2", "リトライ×2",
    // "前後比較×2") is multiplication/repetition, NOT a test failure, and was
    // wrongly read as "2 failures" → false self-contradiction → blocked (task #304).
    /(?:❌|失敗|不合格|不適合|fail(?:ed|ure)?)\s*[:：]?\s*[×x]\s*[1-9]\d*/i,
  ];
  const failureHits = failureSignals
    .map((re) => scanText.match(re))
    .filter((m): m is RegExpMatchArray => !!m);
  // A bare ❌ is too noisy to treat as a failure signal directly: a PASSING
  // verify.md routinely contains the PR-gate legend "全体判定が ❌ の場合のみ PR
  // を作成しないこと。本タスクは ✅ 合格。" (a CONDITIONAL), and the appended
  // self-repair feedback quotes the validator's own "(❌)" summary. Both made
  // every such passing report self-contradict and block. Only count a ❌ that
  // is an actual verdict — skip conditional/legend lines, parenthetical
  // references, any line that simultaneously asserts a pass, any line that
  // explicitly dismisses the ❌ as a known false positive, and any line that
  // merely forward-references the 残課題 section for detail (task 504: an
  // honest, fully-passing verify.md discussed a sub-check's ❌ result twice —
  // once as "自動検証の scope ❌ 4件は §残課題 で扱う" [a pointer, no dismissal word
  // on that line] and once in the 残課題 table itself with "…偽陽性" — and was
  // blocked as a hallucinated pass after the repair budget ran out).
  // The workflow instruction handed to the verifier explicitly SANCTIONS one
  // shape of honest failure: when the cause sits in a file outside plan.md
  // (a pre-existing broken test, an unrelated lint error), the verifier is told
  // NOT to fix it, to file it via `POST /concerns`, to say so in verify.md, and
  // to complete on the in-scope changes alone. Written as instructed, that
  // report necessarily reads "❌ … 本タスクとは無関係な既存失敗" beside a summary
  // saying the in-scope tests pass — exactly the shape this gate reads as a
  // hallucinated pass. Task 666 wrote it as instructed and was blocked through
  // all ten repair rounds.
  //
  // Exempt such a line only when BOTH halves of the instruction are present:
  // the line attributes the failure outside this task's diff, AND the document
  // records the escalation the instruction requires. Attribution alone is one
  // word an agent could reach for to dodge the gate; the paired escalation is
  // not, and the adversarial diff review still scores the diff independently.
  const documentsOutOfScopeEscalation =
    /懸念(?:バックログ)?(?:に|へ)?\s*(?:起票|登録)|POST\s+\/concerns|concern[^\n]{0,20}\bfiled\b/i.test(
      scanText,
    );
  const attributesFailureOutOfScope = (line: string): boolean =>
    /(?:本タスク|当タスク|この(?:タスク|変更|差分))[^\n]{0,12}(?:とは)?\s*(?:無関係|関係(?:は)?な)|既存(?:の)?(?:失敗|不具合|バグ|エラー)|以前から(?:存在|あ)|スコープ外|範囲外|別タスク|pre[\s-]?existing|out[\s-]?of[\s-]?scope|unrelated/i.test(
      line,
    );

  const crossMarkFailure = scanText.split(/\r?\n/).some((line) => {
    if (!line.includes('❌')) return false;
    if (/❌\s*(?:の)?\s*(?:場合|とき|時|なら|ならば|であれば|if\b)/i.test(line)) return false;
    if (/[(（]\s*❌\s*[)）]/.test(line)) return false;
    if (/✅|合格|通過|成功|pass/i.test(line)) return false;
    if (/偽陽性|false[\s-]?positive|誤検知|誤検出|実装欠陥ではない/i.test(line)) return false;
    // A line that merely POINTS to the 残課題/フォローアップ section for detail
    // (e.g. "scope ❌ 4件は §残課題 で扱う") is a forward-reference, not itself a
    // failure verdict — the referenced section is scanned/exempted separately.
    if (/残課題|フォローアップ/.test(line)) return false;
    if (documentsOutOfScopeEscalation && attributesFailureOutOfScope(line)) return false;
    // A line that names one of the ADVISORY machine checks right before its ❌
    // is reporting that check's result, not casting the verifier's own verdict.
    // Task 718 opened a section "受入基準チェックへの対応（機械判定 acceptance:
    // ❌ 1件）" to explain why the advisory hit was wrong — the criterion said
    // "do NOT change X", and token matching finds no changed file for a
    // negative — and the honesty gate counted the heading as a failure.
    if (/(?:機械判定|自動検証|機械受入|advisory|acceptance|scope)[^\n❌]{0,24}❌/i.test(line)) {
      return false;
    }
    // A plan item the operator WITHDREW is not a failure to implement it. The
    // approved plan cannot be edited, so when a supervisor strikes an item the
    // verifier's checklist has to carry that row somehow — task 710 wrote
    // "❌ 実施せず（監督者訂正により撤回）" and was bounced three rounds running
    // for it. Only the explicit word for withdrawal is honoured; "実施せず" on
    // its own still counts, because that is also how a real omission reads.
    if (/撤回|withdrawn/i.test(line)) return false;
    // "❌ 適用不能" is a verdict that the item does not apply here, not a failing
    // check. Feasibility tasks answer "does this idea map onto this codebase?"
    // and a NO is the honest answer: task 602 reported four ❌ 適用不能 rows
    // ("IMEに『解像度』『変換プリセット』の概念は存在しない") beside a passing
    // summary, and was blocked as a hallucinated pass for four rounds.
    // "スコープ外" joins the same list (task 800): a scope table honestly
    // marking an out-of-scope item "❌ 未着手（スコープ外）" is not a failure to
    // implement it — "未着手" alone (no スコープ外 annotation) still falls
    // through to the default `return true` below, so a genuinely incomplete
    // in-scope item is still caught. The window is widened from 8 to 15
    // characters so "未着手" (2 chars) plus the full-width parenthesis can sit
    // between ❌ and スコープ外 without pushing it out of range.
    if (
      /❌[^\n]{0,15}(?:適用不能|該当なし|非該当|対象外|スコープ外|N\/A|not\s+applicable)/i.test(
        line,
      )
    ) {
      return false;
    }
    return true;
  });
  if (crossMarkFailure) failureHits.push(['❌'] as unknown as RegExpMatchArray);

  // "exit 1" / "exit code 1" counts as a failure ONLY when it reads like a
  // RUNNER's exit report — not when it is PROSE documenting a command's expected
  // exit code. CI-gate / error-handling / guard tasks legitimately describe exit
  // codes as EVIDENCE the guard works ("空マニフェスト(exit 1)", "不正な入力で exit 1
  // を返す"); reading those as the task's own failure looped them in verify_repair
  // (task 272/304/373/376). Skip a match that is parenthesised, immediately
  // followed by a Japanese character, or on a line that also asserts pass.
  const exitFailure = scanText.split(/\r?\n/).some((line) => {
    const m = line.match(/\bexit(?:\s+code)?\s+1\b/i);
    if (!m) return false;
    if (/✅|合格|通過|成功|pass/i.test(line)) return false; // pass-asserting line
    // A line enumerating BOTH exit codes is a spec of expected outcomes, not one
    // run's result: task 647's DoD read "build 後 verify 一致→exit 0、改ざん→
    // exit 1＋資産名". The trailing-prose guard below missed it because the next
    // character is a fullwidth ＋ rather than a kana, so it blocked a passing
    // report on the very behaviour the task implemented.
    if (/\bexit(?:\s+code)?\s+0\b/i.test(line)) return false;
    const idx = m.index ?? 0;
    if (/[(（]$/.test(line.slice(Math.max(0, idx - 2), idx))) return false; // "(exit 1)"
    const after = line.slice(idx + m[0].length).replace(/^[)）\s]+/, '');
    if (/^[ぁ-んァ-ヶ一-龥々]/.test(after)) return false; // "exit 1 を返す" prose
    return true;
  });
  if (exitFailure) failureHits.push(['exit 1'] as unknown as RegExpMatchArray);

  if (claimsAllPass && failureHits.length > 0) {
    const evidence = failureHits
      .map((m) => m[0])
      .slice(0, 3)
      .join(' | ');
    return {
      ok: false,
      missingSections: [],
      severity: 80,
      summary:
        `verify.md self-contradicts: claims all tests pass while body contains failure signals (${evidence}). ` +
        `Verifier likely hallucinated success — re-run with stricter test-honesty prompt.`,
    };
  }

  // Detect the explicit "tests did not complete" or "❌" mark — surface
  // as a soft failure so the workflow does not silently auto-PR a
  // broken implementation.
  // Accept the common verdicts the verifier actually writes, JP + EN. The ❌
  // anchor on the Japanese verdicts avoids false positives like "不合格項目: なし".
  if (/❌\s*(検証失敗|不合格|不適合)|❌\s*verification\s*fail|verify[: ]\s*fail/i.test(lower)) {
    return {
      ok: false,
      missingSections: [],
      severity: 90,
      summary: 'verify.md explicitly marks the verification as failed.',
    };
  }

  return sectionResult;
}

/**
 * Whether an already-saved phase artifact is good enough to REUSE on a re-run
 * (so the phase skips regeneration). research/plan are reused unless their
 * validator flags a SERIOUS problem (severity ≥ 80 — e.g. an (almost) empty
 * file, or a plan missing its critical 設計判断の根拠 section). verify.md is
 * intentionally NOT handled here: a re-run must always re-verify the current
 * state and overwrite verify.md, so callers must never route 'verify' to this.
 *
 * @param outputFile - Phase output file type (research / plan / question). / フェーズ出力ファイル種別
 * @param content - Existing file content on disk. / ディスク上の既存内容
 * @returns true when the artifact may be reused as-is. / 再利用可能なら true
 */
export function isReusableArtifact(outputFile: string, content: string): boolean {
  if (!content.trim()) return false;
  if (outputFile === 'research') return validateResearch(content).severity < 80;
  if (outputFile === 'plan') return validatePlan(content).severity < 80;
  // question / other artifacts: reuse whenever present.
  return true;
}

/**
 * Detect which heading texts are present in a markdown document. Looks at
 * level-2 / level-3 headings (## / ###) and considers a section present if
 * any heading contains the keyword (substring match, case-insensitive).
 *
 * Each entry in `required` may be either a single keyword (string) or an
 * OR-group (string[]) where ANY alternative satisfies the requirement.
 * Missing section labels use the first element of an OR-group.
 *
 * @param content - markdown document / マークダウン本文
 * @param required - required section keywords, plain or OR-groups / 必須セクションのキーワード（単一またはOR候補配列）
 * @param label - label for the summary / サマリのラベル
 * @returns validation result / バリデーション結果
 */
function validateSections(
  content: string,
  required: (string | string[])[],
  label: string,
): ValidationResult {
  if (!content || !content.trim()) {
    return {
      ok: false,
      missingSections: required.map((s) => (Array.isArray(s) ? s[0] : s)),
      severity: 100,
      summary: `${label} is empty`,
    };
  }

  const headingLines = content
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.toLowerCase());
  const headingsBlob = headingLines.join('\n');

  const missingSections: string[] = [];
  for (const section of required) {
    if (Array.isArray(section)) {
      // OR match: any alternative satisfies the requirement
      const found = section.some((alt) => headingsBlob.includes(alt.toLowerCase()));
      if (!found) {
        // Use the first element as the canonical label for reporting
        missingSections.push(section[0]);
      }
    } else {
      if (!headingsBlob.includes(section.toLowerCase())) {
        missingSections.push(section);
      }
    }
  }

  const severity = Math.round((missingSections.length / required.length) * 100);
  return {
    ok: missingSections.length === 0,
    missingSections,
    severity,
    summary:
      missingSections.length === 0
        ? `${label} is well-formed`
        : `${label} missing sections: ${missingSections.join(', ')}`,
  };
}
