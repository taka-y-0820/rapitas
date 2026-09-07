/**
 * PromptEvolutionAutoApproveEvaluate
 *
 * Step 2 of the unattended gate: judge every candidate under limited trial on
 * its MEASURED comparison record — adopt role-wide, withdraw, or keep
 * collecting.
 *
 * Adoption requires BOTH gates to agree:
 *
 * 1. prompt-comparison-metrics' descriptive verdict is `improved` (minimum
 *    sample, cost and duration within their baseline-relative tolerances), and
 * 2. prompt-comparison-adoption-gate's Fisher exact test clears the budget
 *    prompt-comparison-alpha-ledger allocated to THIS look.
 *
 * Gate 1 alone is not evidence: it is re-evaluated every day against a growing
 * sample, and a fixed threshold applied repeatedly drifts the family-wise
 * false-adoption rate well past its nominal level. Gate 2 is what bounds it.
 *
 * Withdrawal deliberately requires only the regression side of gate 1 —
 * removing a candidate that looks harmful is the safe direction, and demanding
 * statistical proof first would keep it injected longer.
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { passesSequentialSignificance } from './comparison/prompt-comparison-adoption-gate';
import {
  buildCheckpointSummary,
  comparisonCohortIssue,
} from './comparison/prompt-comparison-checkpoint';
import { resolveEvaluationBudget } from './comparison/prompt-comparison-alpha-ledger';
import {
  readComparisonRecordStatus,
  addendumVersionHash,
} from './comparison/prompt-comparison-store';
import {
  CANDIDATE_SELECT,
  parseEvidence,
  stampEvidence,
  type AutoApproveResult,
  type CandidateRow,
} from './prompt-evolution-auto-approve-shared';
import { autoPromoteEnabled, isPureAddendum } from './prompt-evolution-settle';
import { reviewProposal, MAX_ADDENDUM_CHARS } from './prompt-evolution-worker';

const log = createLogger('self-learning:prompt-evolution-auto-approve');

/**
 * Judge every candidate currently under trial on its measured comparison
 * record.
 *
 * @param result - Counters mutated in place. / 更新するカウンタ
 */
export async function evaluateStagedCandidates(result: AutoApproveResult): Promise<void> {
  // No `take` bound: candidates only enter this pool AUTO_APPROVE_BATCH at a
  // time and leave it on a verdict, so it cannot grow without limit.
  const staged = (await prisma.promptEvolution.findMany({
    where: { status: 'staged' },
    orderBy: { createdAt: 'asc' },
    select: CANDIDATE_SELECT,
  })) as CandidateRow[];

  for (const candidate of staged) {
    const evidence = parseEvidence(candidate.evidenceJson);
    const status = readComparisonRecordStatus(candidate.id);
    if (status.kind !== 'ok') {
      // Evidence we cannot READ is not evidence of anything. The candidate
      // keeps its trial: neither adopted nor withdrawn on a record we could
      // not use. `comparisonStatus` stays the coarse 'unknown' flag; the
      // specific kind is stamped alongside it because "the file is gone",
      // "the JSON is corrupt" and "the disk refused the read" need different
      // operator responses, and collapsing them leaves nothing to act on.
      evidence.comparisonStatus = 'unknown';
      evidence.comparisonStatusKind = status.kind;
      await stampEvidence(candidate.id, evidence);
      result.withheld++;
      log.warn(
        { id: candidate.id, kind: status.kind },
        '[prompt-evolution] Comparison record unusable — candidate held under trial (unknown)',
      );
      continue;
    }
    const comparison = status.record;

    const cohortIssue = comparisonCohortIssue(
      comparison.arms,
      candidate.basePromptKey?.replace(/^workflow_role_/, '') ?? '',
      addendumVersionHash(candidate.afterPrompt?.trim().slice(0, MAX_ADDENDUM_CHARS) ?? ''),
    );
    if (cohortIssue) {
      evidence.comparisonCohortIssue = cohortIssue;
      await stampEvidence(candidate.id, evidence);
      result.withheld++;
      continue;
    }
    delete evidence.comparisonCohortIssue;

    const summary = buildCheckpointSummary(comparison.arms);
    const verdict = summary?.verdict ?? 'insufficient_data';
    // Kept so a look that turns out to spend no budget can put it back.
    const previousEvaluatedAt =
      typeof evidence.comparisonEvaluatedAt === 'string'
        ? evidence.comparisonEvaluatedAt
        : undefined;
    delete evidence.comparisonStatus;
    delete evidence.comparisonStatusKind;
    evidence.comparisonVerdict = verdict;
    evidence.comparisonSampleSize = summary?.sampleSize ?? 0;
    evidence.comparisonSuccessRateDelta = summary?.successRateDelta ?? 0;
    evidence.comparisonCostDelta = summary?.costDelta ?? 0;
    evidence.comparisonBaselineCostUsd = summary?.baselineCostUsd ?? 0;
    evidence.comparisonUncertainty = summary?.uncertainty ?? 'high';
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

    // A trial with historical outcomes cannot obtain a fresh budget after
    // observing them. Legacy trials require prospective registration instead.
    const budget = resolveEvaluationBudget(candidate.id, summary?.sampleSize ?? 0);
    if (budget.issue) {
      // A budget we cannot read is not a budget. Neither adopt nor withdraw.
      evidence.alphaLedgerStatus = 'unknown';
      evidence.alphaLedgerIssueKind = budget.issue;
      await stampEvidence(candidate.id, evidence);
      result.withheld++;
      log.warn(
        { id: candidate.id, kind: budget.issue },
        '[prompt-evolution] Alpha ledger unusable — candidate held under trial (unknown)',
      );
      continue;
    }
    delete evidence.alphaLedgerStatus;
    delete evidence.alphaLedgerIssueKind;

    if (!budget.isNewLook) {
      // Same samples as the previous evaluation. Re-judging them would be a
      // free extra chance to clear the threshold, which is exactly the
      // repeated-testing inflation the ledger exists to prevent.
      //
      // The previous look's evaluation stamp is restored before writing, so a
      // poll that spent no budget does not masquerade as a fresh evaluation in
      // the audit trail. Recovered ledger status still persists.
      evidence.comparisonEvaluatedAt =
        previousEvaluatedAt ?? (evidence.comparisonEvaluatedAt as string);
      await stampEvidence(candidate.id, evidence);
      result.withheld++;
      continue;
    }

    evidence.alphaLookJ = budget.j;
    evidence.alphaKj = budget.alphaKj;

    // insufficient_data / inconclusive: keep measuring rather than guess. A
    // deletion signal that appeared after staging likewise holds the trial.
    // (`summary` is non-null whenever the verdict is 'improved' — an absent
    // summary degrades to 'insufficient_data' above — but the null check keeps
    // that invariant enforced by the compiler rather than by reading.)
    if (
      verdict !== 'improved' ||
      !summary ||
      !isPureAddendum(candidate.afterPrompt?.trim() ?? '')
    ) {
      await stampEvidence(candidate.id, evidence);
      result.withheld++;
      continue;
    }

    const significant = passesSequentialSignificance(summary, budget.alphaKj);
    evidence.adoptionTestPassed = significant;
    if (!significant) {
      // The gap is real enough to look promising but not to rule out chance at
      // this look's budget. Keep collecting; a later look with more samples can
      // still adopt it.
      await stampEvidence(candidate.id, evidence);
      result.withheld++;
      log.info(
        { id: candidate.id, j: budget.j, alphaKj: budget.alphaKj, sampleSize: summary.sampleSize },
        '[prompt-evolution] Trial promising but not significant at this look — collecting',
      );
      continue;
    }

    evidence.readyForPromotion = true;
    await stampEvidence(candidate.id, evidence);

    if (!autoPromoteEnabled()) {
      // The measurement passed; the operator has explicitly opted out. The
      // readyForPromotion stamp above is the record of exactly which
      // candidates that switch is holding back.
      result.withheld++;
      log.info(
        { id: candidate.id },
        '[prompt-evolution] Trial passed but RAPITAS_PROMPT_AUTO_PROMOTE=false — held',
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
        {
          id: candidate.id,
          role: candidate.basePromptKey,
          sampleSize: summary.sampleSize,
          uncertainty: summary.uncertainty,
          k: evidence.alphaBudgetK,
          j: budget.j,
          alphaKj: budget.alphaKj,
        },
        '[prompt-evolution] Adopted role-wide on measured comparison evidence',
      );
    } else {
      result.withheld++;
    }
  }
}
