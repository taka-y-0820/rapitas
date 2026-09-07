/**
 * PromptEvolutionAutoApprove
 *
 * The unattended gate between a generated candidate and a role-wide prompt
 * change. It is a TWO-step gate, not one:
 *
 *   proposed --(text guards)--> staged --(measured comparison)--> approved
 *                     |                            |
 *                     +--> rejected                +--> rejected (regression)
 *
 * The first step only decides that a candidate is a usable, purely additive
 * instruction — that is a claim about the TEXT, never about the candidate
 * being an improvement, so it buys a limited trial rather than a rollout. The
 * trial injects the addendum into alternating phases of the target role
 * (prompt-evolution-staged-trial) and records both arms' real executions; only
 * that measured evidence can adopt or withdraw the candidate.
 *
 * Task 893 shipped the first step alone and let it write `approved` directly:
 * a candidate reached every task's prompt on nothing but text heuristics.
 * Task 894 restores the measurement between the two.
 *
 * This module is the orchestrator only — the two steps live in
 * prompt-evolution-auto-approve-stage and -evaluate. Not responsible for
 * generating candidates (prompt-evolution-worker) nor for measuring an
 * already-approved rollout (prompt-evolution-settle).
 */
import { createLogger } from '../../config/logger';
import { evaluateStagedCandidates } from './prompt-evolution-auto-approve-evaluate';
import type { AutoApproveResult } from './prompt-evolution-auto-approve-shared';
import { stageProposedCandidates } from './prompt-evolution-auto-approve-stage';

const log = createLogger('self-learning:prompt-evolution-auto-approve');

/** Candidates moved into a trial per run — matches the proposal generator's batch bound. */
const AUTO_APPROVE_BATCH = 3;

export type { AutoApproveResult } from './prompt-evolution-auto-approve-shared';

/**
 * Whether unattended progress is enabled. Default ON: the text guards, the
 * measured limited trial, and the post-approval revert in
 * prompt-evolution-settle together form the safety net the human click used
 * to provide. Set RAPITAS_PROMPT_AUTO_APPROVE=false to return to
 * approve-by-hand.
 * / 無人処理の有効判定（既定オン。false 明示でオプトアウト）
 *
 * @returns True when the unattended gate may act. / 無人ゲートが動作してよいなら true
 */
export function autoApproveEnabled(): boolean {
  return process.env.RAPITAS_PROMPT_AUTO_APPROVE !== 'false';
}

/**
 * Advance every unattended candidate one step: start a limited trial for the
 * text-usable proposals, and adopt / withdraw / continue the candidates
 * already under trial according to their measured comparison record.
 *
 * Origin is deliberately not considered: experiment-lifecycle writes its
 * `improved` verdict to the same table and status as the weekly runner, so
 * one gate here covers both paths without either of them changing.
 *
 * @param limit - Max `proposed` candidates started this run. / 1回に試行開始する上限
 * @returns Per-outcome counts. / 結果別の件数
 */
export async function autoApproveEligibleProposals(
  limit = AUTO_APPROVE_BATCH,
): Promise<AutoApproveResult> {
  const result: AutoApproveResult = { staged: 0, approved: 0, rejected: 0, withheld: 0 };
  if (!autoApproveEnabled()) {
    log.info('[prompt-evolution] Auto-approval disabled (RAPITAS_PROMPT_AUTO_APPROVE=false)');
    return result;
  }

  await stageProposedCandidates(result, limit);
  await evaluateStagedCandidates(result);
  return result;
}
