/**
 * completion-gate
 *
 * Guards workflow completion against the "silent skip" pattern: an agent writes
 * a passing verify.md (sometimes fabricating an implementation report) but never
 * actually edits any code, so the task is marked done with no diff and no commit.
 * A passing verify may complete ONLY when it is backed by real code changes, OR
 * the verify explicitly justifies that no change was needed.
 * Not responsible for running verification (lint/type) — see verification-gate.
 */
import { getDiff } from '../agents/orchestrator/git-operations/core/diff-structured';
import { createLogger } from '../../config/logger';

const log = createLogger('workflow:completion-gate');

/**
 * Phrases that count as an EXPLICIT "no code change was needed" justification in
 * a verify.md. Kept broad (JP + EN) so a legitimate no-op is accepted; a verify
 * that instead CLAIMS an implementation (the bad pattern) won't match and is
 * therefore blocked.
 */
const NO_CHANGE_JUSTIFICATIONS: RegExp[] = [
  /変更(は)?不要/,
  /修正(は)?不要/,
  /対応(は)?不要/,
  /コード(の)?変更(は)?(なし|ありません|不要)/,
  /変更点(は)?(なし|ありません)/,
  /(実装|対応|修正|解決|完了|反映|適用|取り込み)済(み)?/,
  /既存(の)?(実装|コード)で(対応|充足|満た)/,
  /別(の)?(コミット|PR|ブランチ|タスク)で(対応|実装|完了|解決)/,
  /(検証|テスト|確認|調査|ドキュメント)のみ/,
  /no\s+(code\s+)?changes?\s+(are\s+)?(needed|required|necessary)/i,
  /no\s+changes?\s+(were\s+)?(made|necessary)/i,
  /already\s+(implemented|fixed|handled|resolved|correct|done|present)/i,
  /(verification|docs?|documentation|test)[-\s]?only/i,
];

/** True when verify.md explicitly states no code change was required. */
export function verifyJustifiesNoChange(verifyContent: string | null | undefined): boolean {
  if (!verifyContent) return false;
  return NO_CHANGE_JUSTIFICATIONS.some((re) => re.test(verifyContent));
}

/**
 * Explicit "no change needed" VERDICT markers a researcher writes in research.md
 * when the task's requirement is ALREADY satisfied by existing code. Deliberately
 * STRICT (anchored verdict line / heading, not prose) so a research note that
 * merely mentions "既存実装" while still proposing changes does NOT false-trigger
 * a premature completion. The research prompt mandates the exact `## 結論: 修正不要`
 * form when no change is needed (see the researcher `output` instruction in
 * workflow-context-builder.ts).
 */
const RESEARCH_NO_CHANGE_VERDICTS: RegExp[] = [
  // Heading or line: 結論/判定/総括 ... (修正|対応|実装|変更|追加実装) (は) 不要
  /^#{0,4}\s*(?:結論|判定|総括)\s*[:：][^\n]{0,60}(?:修正|対応|実装|変更|追加実装)(?:は)?不要/m,
  // Machine token line: 修正不要: true / 対応不要: はい
  /^\s*(?:修正|対応|実装|変更)不要\s*[:：]\s*(?:true|yes|はい|○)\s*$/im,
  // English: conclusion: no change needed
  /^#{0,4}\s*conclusion\s*[:：][^\n]{0,60}no[ -]?change[s]?\s*(?:needed|required|necessary)?/im,
];

/**
 * Whether research.md explicitly concludes the task needs NO change (the
 * requirement is already satisfied by existing implementation). When true, the
 * finding only describes implementation scope. It does not authorize completion
 * or bypass verification, acceptance criteria, or configured completion gates.
 *
 * @param researchContent - research.md body / research.md 本文
 * @returns true when an explicit no-change verdict is present / 明示的な修正不要判定があれば true
 */
export function researchConcludesNoChange(researchContent: string | null | undefined): boolean {
  if (!researchContent) return false;
  return RESEARCH_NO_CHANGE_VERDICTS.some((re) => re.test(researchContent));
}

export interface CompletionGateResult {
  /** Whether the task may be marked completed. */
  allow: boolean;
  /** Short machine reason (also used as the transition cause). */
  reason: string;
}

/**
 * Decide whether a PASSING verify may complete the task.
 *
 * - Real code changes in the worktree → always allowed.
 * - Empty diff → allowed only if verify.md explicitly justifies a no-op.
 * - Diff cannot be computed (no worktree / git error) → fail OPEN, so a broken
 *   gate never wrongly blocks legitimate completions.
 *
 * @param worktreePath - The task's git worktree, or null when none exists. / タスクのworktree（無ければnull）
 * @param verifyContent - The saved verify.md content. / 保存済みverify.mdの内容
 * @param preferredBaseBranch - The branch this task's worktree was cut from, when known (e.g. `task.theme.defaultBranch` via task-resolver.ts's `resolvePreferredBaseBranch`) — see automated-verifier.ts's diffBaseRef doc comment. / このタスクの分岐元ブランチ（既知の場合）
 * @returns Whether completion is allowed, with a reason. / 完了可否と理由
 */
export async function evaluateCompletionGate(
  worktreePath: string | null | undefined,
  verifyContent: string | null | undefined,
  preferredBaseBranch?: string | null,
): Promise<CompletionGateResult> {
  if (!worktreePath) {
    return { allow: true, reason: 'no_worktree_failopen' };
  }

  let diffCount: number;
  try {
    const diff = await getDiff(worktreePath, undefined, preferredBaseBranch);
    diffCount = diff.length;
  } catch (err) {
    log.warn({ err, worktreePath }, '[CompletionGate] diff check failed — failing open');
    return { allow: true, reason: 'diff_unavailable_failopen' };
  }

  if (diffCount > 0) {
    return { allow: true, reason: 'has_code_changes' };
  }

  if (verifyJustifiesNoChange(verifyContent)) {
    return { allow: true, reason: 'no_changes_but_justified' };
  }

  return { allow: false, reason: 'no_changes_unjustified' };
}
