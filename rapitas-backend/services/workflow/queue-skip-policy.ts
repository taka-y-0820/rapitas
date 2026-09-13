/**
 * queue-skip-policy
 *
 * Classifies a phase failure as "this task cannot run right now, and retrying
 * cannot change that". Such a result is a SKIP, not a failure: the queue item
 * should be cancelled rather than retried, so the task keeps the real reason it
 * stopped instead of having it overwritten by a tautology.
 *
 * Pure predicate — no I/O.
 */

/**
 * Orchestrator guards that refuse to dispatch a task. Each returns
 * `success: false` with one of these messages, and each describes a state the
 * queue itself cannot resolve by trying again:
 *  - the task is already blocked and awaiting a human
 *  - the task is parked on a question and needs an answer
 *  - the task opted out of phase-by-phase execution entirely
 *
 * Measured 2026-08-23: retrying these burned every task's three retries within
 * seconds and, worse, replaced the recorded failure reason with
 * 「タスクはブロック中のため自動実行をスキップしました」 — so tasks 602 and 647
 * showed a tautology ("blocked because blocked") instead of the
 * verify_validation_failed that actually stopped them. 105 of the window's
 * retries came from the awaiting_question variant alone.
 */
const NON_RUNNABLE_SKIP_RE =
  /(ブロック中のため自動実行をスキップ|では次のフェーズを実行できません|ワークフロー無効モードのため自動実行|Requirement replan review held: requires_human:)/;

/**
 * Whether a phase result means "not runnable now", as opposed to "failed".
 *
 * @param reason - The phase result's error message, if any. / フェーズの失敗理由
 * @returns true when the queue should cancel instead of retry. / 再試行せず取消すべきなら true
 */
export function isNonRunnableTaskSkip(reason?: string | null): boolean {
  const text = (reason ?? '').trim();
  if (!text) return false;
  if (text.startsWith('Requirement replan review held: review_in_progress')) return true;
  return NON_RUNNABLE_SKIP_RE.test(text);
}
