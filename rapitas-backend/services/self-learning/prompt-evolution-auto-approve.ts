/**
 * PromptEvolutionAutoApprove
 *
 * The `proposed → approved` gate. Until now every candidate — whether raised
 * by the weekly runner or by a controlled experiment that already MEASURED an
 * improvement — waited for a human click on /system-prompts, so the loop never
 * closed unattended and confirmedPromptImprovements stayed 0 (task 893).
 *
 * This is a CONDITIONAL release of that gate, not a removal of it: a candidate
 * is approved automatically only when it is a usable instruction
 * (validateAddendumQuality) AND purely additive (isPureAddendum). Anything
 * else stays `proposed` for a human. Regressions are not this module's
 * problem — settleApprovedEvolutions measures every approved addendum after
 * the fact and reverts the ones that made the role worse.
 */
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { validateAddendumQuality } from './prompt-evolution-addendum-quality';
import { isPureAddendum } from './prompt-evolution-settle';
import { reviewProposal } from './prompt-evolution-worker';

const log = createLogger('self-learning:prompt-evolution-auto-approve');

/** Candidates auto-approved per run — matches the proposal generator's batch bound. */
const AUTO_APPROVE_BATCH = 3;

/**
 * Whether unattended approval is enabled. Default ON: the guards above plus
 * the post-approval revert in prompt-evolution-settle form the safety net the
 * human click used to provide. Set RAPITAS_PROMPT_AUTO_APPROVE=false to
 * return to approve-by-hand.
 * / 無人承認の有効判定（既定オン。false 明示でオプトアウト）
 */
export function autoApproveEnabled(): boolean {
  return process.env.RAPITAS_PROMPT_AUTO_APPROVE !== 'false';
}

export interface AutoApproveResult {
  /** Rows moved to `approved`. / 承認した件数 */
  approved: number;
  /** Rows left `proposed` for a human because a guard rejected them. / 人手判断に残した件数 */
  withheld: number;
}

/**
 * Approve the proposed candidates that clear both guards.
 *
 * Origin is deliberately not considered: experiment-lifecycle writes its
 * `improved` verdict to the same table and status as the weekly runner, so
 * one gate here covers both paths without either of them changing.
 *
 * @param limit - Max candidates examined this run. / 1回の処理上限
 * @returns Approved and withheld counts. / 承認・見送り件数
 */
export async function autoApproveEligibleProposals(
  limit = AUTO_APPROVE_BATCH,
): Promise<AutoApproveResult> {
  const result: AutoApproveResult = { approved: 0, withheld: 0 };
  if (!autoApproveEnabled()) {
    log.info('[prompt-evolution] Auto-approval disabled (RAPITAS_PROMPT_AUTO_APPROVE=false)');
    return result;
  }

  const proposals = await prisma.promptEvolution.findMany({
    where: { status: 'proposed' },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true, basePromptKey: true, afterPrompt: true },
  });

  for (const proposal of proposals) {
    const addendum = proposal.afterPrompt?.trim() ?? '';
    const quality = validateAddendumQuality(addendum);
    if (!quality.valid) {
      result.withheld++;
      log.info(
        { id: proposal.id, reason: quality.reason },
        '[prompt-evolution] Withheld from auto-approval — unusable addendum, left for human review',
      );
      continue;
    }
    // An addendum only ever APPENDS to the engineered role prompt, so one that
    // tells the agent to remove existing behavior cannot be judged from the
    // text alone — that stays a human decision.
    if (!isPureAddendum(addendum)) {
      result.withheld++;
      log.info(
        { id: proposal.id },
        '[prompt-evolution] Withheld from auto-approval — deletion signal, left for human review',
      );
      continue;
    }

    try {
      const ok = await reviewProposal(proposal.id, true);
      if (ok) {
        result.approved++;
        log.info(
          { id: proposal.id, role: proposal.basePromptKey },
          '[prompt-evolution] Auto-approved — settlement will revert it if the role regresses',
        );
      } else {
        result.withheld++;
      }
    } catch (err) {
      result.withheld++;
      log.warn({ err, id: proposal.id }, '[prompt-evolution] Auto-approval failed');
    }
  }
  return result;
}
