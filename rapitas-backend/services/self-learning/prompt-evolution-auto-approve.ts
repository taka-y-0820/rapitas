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
 * instruction (validateAddendumQuality + isPureAddendum) — that is a claim
 * about the TEXT, never about the candidate being an improvement, so it buys
 * a limited trial rather than a rollout. The trial injects the addendum into
 * alternating phases of the target role (prompt-evolution-staged-trial) and
 * records both arms' real executions; only that measured evidence
 * (prompt-comparison-metrics) can adopt or withdraw the candidate.
 *
 * Task 893 shipped the first step alone and let it write `approved` directly:
 * a candidate reached every task's prompt on nothing but text heuristics.
 * Task 894 restores the measurement between the two.
 *
 * Not responsible for generating candidates (prompt-evolution-worker) nor for
 * measuring an already-approved rollout (prompt-evolution-settle).
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import {
  initComparisonRecordForStaging,
  readComparisonRecord,
} from './comparison/prompt-comparison-store';
import { validateAddendumQuality } from './prompt-evolution-addendum-quality';
import { autoPromoteEnabled, isPureAddendum } from './prompt-evolution-settle';
import { reviewProposal } from './prompt-evolution-worker';

const log = createLogger('self-learning:prompt-evolution-auto-approve');

/** Candidates moved into a trial per run — matches the proposal generator's batch bound. */
const AUTO_APPROVE_BATCH = 3;

/**
 * Text-gate failures tolerated before a `proposed` candidate is rejected.
 *
 * Without a bound the same head-of-queue candidates are re-read by every run
 * (orderBy createdAt asc, take: batch) and, being permanently unusable, block
 * every younger candidate from ever being examined — the head-of-line stall
 * this module used to have. Rejecting after a bounded number of attempts
 * guarantees the queue drains.
 */
const AUTO_APPROVE_QUALITY_RETRY_LIMIT = 3;

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

export interface AutoApproveResult {
  /** Rows moved `proposed` → `staged` (limited trial started). / 限定試行を開始した件数 */
  staged: number;
  /** Rows moved `staged` → `approved` on measured evidence. / 実測に基づき全体採用した件数 */
  approved: number;
  /** Rows rejected: unusable text, or a measured regression. / 却下・撤回した件数 */
  rejected: number;
  /** Rows deliberately left where they are this run. / 今回は現状維持とした件数 */
  withheld: number;
}

type Evidence = Record<string, unknown>;

function parseEvidence(raw: string | null): Evidence {
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (parsed && typeof parsed === 'object') return parsed as Evidence;
  } catch {
    /* unreadable evidence — start fresh rather than dropping the stamp */
  }
  return {};
}

async function stampEvidence(id: number, evidence: Evidence): Promise<void> {
  await prisma.promptEvolution.update({
    where: { id },
    data: { evidenceJson: JSON.stringify(evidence) },
  });
}

interface CandidateRow {
  id: number;
  basePromptKey: string | null;
  afterPrompt: string | null;
  evidenceJson: string | null;
}

const CANDIDATE_SELECT = {
  id: true,
  basePromptKey: true,
  afterPrompt: true,
  evidenceJson: true,
} as const;

/**
 * Why a candidate's text disqualifies it from a trial, or null when it passes.
 *
 * @param addendum - Generated addendum text. / 生成された追記文
 * @returns Rejection reason, or null when the text is usable. / 却下理由 or null
 */
function textGateFailure(addendum: string): string | null {
  const quality = validateAddendumQuality(addendum);
  if (!quality.valid) return quality.reason ?? 'unusable_addendum';
  // An addendum only ever APPENDS to the engineered role prompt, so one that
  // tells the agent to remove existing behavior cannot be judged from the
  // text alone — such a candidate never earns a trial.
  return isPureAddendum(addendum) ? null : 'deletion_signal';
}

/**
 * Step 1 — move text-usable candidates into a limited trial.
 *
 * @param result - Counters mutated in place. / 更新するカウンタ
 * @param limit - Max candidates examined this run. / 1回の処理上限
 */
async function stageProposedCandidates(result: AutoApproveResult, limit: number): Promise<void> {
  const proposals = (await prisma.promptEvolution.findMany({
    where: { status: 'proposed' },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: CANDIDATE_SELECT,
  })) as CandidateRow[];

  for (const proposal of proposals) {
    const addendum = proposal.afterPrompt?.trim() ?? '';
    const blocked = textGateFailure(addendum);
    if (blocked) {
      const evidence = parseEvidence(proposal.evidenceJson);
      const previous =
        typeof evidence.autoApproveQualityRetries === 'number'
          ? evidence.autoApproveQualityRetries
          : 0;
      const attempts = previous + 1;
      evidence.autoApproveQualityRetries = attempts;
      if (attempts >= AUTO_APPROVE_QUALITY_RETRY_LIMIT) {
        evidence.rejectionReason = blocked;
        await stampEvidence(proposal.id, evidence);
        await reviewProposal(proposal.id, false);
        result.rejected++;
        log.info(
          { id: proposal.id, reason: blocked, attempts },
          '[prompt-evolution] Rejected after the text gate kept failing — queue head released',
        );
      } else {
        await stampEvidence(proposal.id, evidence);
        result.withheld++;
      }
      continue;
    }

    try {
      const evidence = parseEvidence(proposal.evidenceJson);
      evidence.stagedAt = new Date().toISOString();
      evidence.stagedSampleCount = 0;
      delete evidence.autoApproveQualityRetries;
      await prisma.promptEvolution.update({
        where: { id: proposal.id },
        data: { status: 'staged', evidenceJson: JSON.stringify(evidence) },
      });
      initComparisonRecordForStaging({
        promptEvolutionId: proposal.id,
        role: proposal.basePromptKey?.replace(/^workflow_role_/, '') ?? '',
        createdAt: new Date().toISOString(),
      });
      result.staged++;
      log.info(
        { id: proposal.id, role: proposal.basePromptKey },
        '[prompt-evolution] Staged for a limited trial — adoption now needs measured evidence',
      );
    } catch (err) {
      result.withheld++;
      log.warn({ err, id: proposal.id }, '[prompt-evolution] Staging failed');
    }
  }
}

/**
 * Step 2 — judge every candidate currently under trial on its measured
 * comparison record.
 *
 * @param result - Counters mutated in place. / 更新するカウンタ
 */
async function evaluateStagedCandidates(result: AutoApproveResult): Promise<void> {
  // No `take` bound: candidates only enter this pool AUTO_APPROVE_BATCH at a
  // time and leave it on a verdict, so it cannot grow without limit.
  const staged = (await prisma.promptEvolution.findMany({
    where: { status: 'staged' },
    orderBy: { createdAt: 'asc' },
    select: CANDIDATE_SELECT,
  })) as CandidateRow[];

  for (const candidate of staged) {
    const evidence = parseEvidence(candidate.evidenceJson);
    const comparison = readComparisonRecord(candidate.id);
    if (!comparison) {
      // Evidence we cannot READ is not evidence of anything. The candidate
      // keeps its trial: neither adopted nor withdrawn on a missing record.
      evidence.comparisonStatus = 'unknown';
      await stampEvidence(candidate.id, evidence);
      result.withheld++;
      log.warn(
        { id: candidate.id },
        '[prompt-evolution] Comparison record unreadable — candidate held under trial (unknown)',
      );
      continue;
    }

    const summary = comparison.summary;
    const verdict = summary?.verdict ?? 'insufficient_data';
    delete evidence.comparisonStatus;
    evidence.comparisonVerdict = verdict;
    evidence.comparisonSampleSize = summary?.sampleSize ?? 0;
    evidence.comparisonSuccessRateDelta = summary?.successRateDelta ?? 0;
    evidence.comparisonCostDelta = summary?.costDelta ?? 0;
    evidence.comparisonEvaluatedAt = new Date().toISOString();

    if (verdict === 'regressed') {
      evidence.revertedReason = 'comparison_regression';
      await stampEvidence(candidate.id, evidence);
      await reviewProposal(candidate.id, false);
      result.rejected++;
      log.info(
        { id: candidate.id, sampleSize: summary?.sampleSize, delta: summary?.successRateDelta },
        '[prompt-evolution] Withdrawn — the limited trial measured a regression',
      );
      continue;
    }

    // insufficient_data / inconclusive: keep measuring rather than guess. A
    // deletion signal that appeared after staging likewise holds the trial.
    if (verdict !== 'improved' || !isPureAddendum(candidate.afterPrompt?.trim() ?? '')) {
      await stampEvidence(candidate.id, evidence);
      result.withheld++;
      continue;
    }

    evidence.readyForPromotion = true;
    await stampEvidence(candidate.id, evidence);

    if (!autoPromoteEnabled()) {
      // The measurement passed; only the operator switch is missing. The
      // readyForPromotion stamp above is the record of exactly which
      // candidates are waiting on that switch.
      result.withheld++;
      log.info(
        { id: candidate.id },
        '[prompt-evolution] Trial passed but RAPITAS_PROMPT_AUTO_PROMOTE is not true — held',
      );
      continue;
    }

    // reviewProposal clears the trial's stagedTaskIds as part of adopting a
    // `staged` row, so a full rollout is no longer filtered down to the tasks
    // the trial happened to touch.
    const ok = await reviewProposal(candidate.id, true);
    if (ok) {
      result.approved++;
      log.info(
        { id: candidate.id, role: candidate.basePromptKey, sampleSize: summary?.sampleSize },
        '[prompt-evolution] Adopted role-wide on measured comparison evidence',
      );
    } else {
      result.withheld++;
    }
  }
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
