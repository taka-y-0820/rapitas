/**
 * PromptEvolutionAutoApproveEvaluate
 *
 * Step 2 of the unattended gate: judge every candidate under limited trial on
 * its MEASURED comparison record — adopt role-wide, withdraw, or keep
 * collecting. The judgement itself (minimum sample, significance floor,
 * baseline-relative cost/duration tolerance) belongs to
 * comparison/prompt-comparison-metrics; this module only applies its verdict
 * to the candidate row and records why.
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { readComparisonRecord } from './comparison/prompt-comparison-store';
import {
  CANDIDATE_SELECT,
  parseEvidence,
  stampEvidence,
  type AutoApproveResult,
  type CandidateRow,
} from './prompt-evolution-auto-approve-shared';
import { autoPromoteEnabled, isPureAddendum } from './prompt-evolution-settle';
import { reviewProposal } from './prompt-evolution-worker';

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
          sampleSize: summary?.sampleSize,
          uncertainty: summary?.uncertainty,
        },
        '[prompt-evolution] Adopted role-wide on measured comparison evidence',
      );
    } else {
      result.withheld++;
    }
  }
}
