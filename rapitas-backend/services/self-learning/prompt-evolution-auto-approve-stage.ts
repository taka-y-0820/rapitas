/**
 * PromptEvolutionAutoApproveStage
 *
 * Step 1 of the unattended gate: move `proposed` candidates whose TEXT is a
 * usable, purely additive instruction into a limited trial (`staged`), and
 * bound how long an unusable one may sit at the head of the queue.
 *
 * Passing this step is never a claim that the candidate is an improvement —
 * that judgement belongs to prompt-evolution-auto-approve-evaluate, on the
 * comparison record this step prepares.
 *
 * Staging also reserves the candidate's pre-registered share of the global
 * false-adoption budget (prompt-comparison-alpha-ledger) and its randomisation
 * seed, so both are fixed before a single sample exists.
 */
import { randomBytes } from 'crypto';
import { claimStagedRole } from './prompt-evolution-stage-claim';
import { prisma } from '../../config/database';
import { createLogger } from '../../config/logger';
import { assignCandidateBudget } from './comparison/prompt-comparison-alpha-ledger';
import { initComparisonRecordForStaging } from './comparison/prompt-comparison-store';
import { validateAddendumQuality } from './prompt-evolution-addendum-quality';
import {
  CANDIDATE_SELECT,
  parseEvidence,
  stampEvidence,
  type AutoApproveResult,
  type CandidateRow,
} from './prompt-evolution-auto-approve-shared';
import { isPureAddendum } from './prompt-evolution-settle';
import { reviewProposal } from './prompt-evolution-worker';

const log = createLogger('self-learning:prompt-evolution-auto-approve');

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
 * Record a text-gate failure: retry on the next run, or reject once the budget
 * is spent so the queue head is released.
 *
 * @param proposal - Candidate that failed the text gate. / 不合格の候補
 * @param blocked - Reason the text was rejected. / 却下理由
 * @param result - Counters mutated in place. / 更新するカウンタ
 */
async function recordTextGateFailure(
  proposal: CandidateRow,
  blocked: string,
  result: AutoApproveResult,
): Promise<void> {
  const evidence = parseEvidence(proposal.evidenceJson);
  const previous =
    typeof evidence.autoApproveQualityRetries === 'number' ? evidence.autoApproveQualityRetries : 0;
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
    return;
  }
  await stampEvidence(proposal.id, evidence);
  result.withheld++;
}

/**
 * Move text-usable candidates into a limited trial.
 *
 * A candidate is staged only once its comparison record is genuinely ready.
 * When the record exists but cannot be used — corrupt JSON, an unreadable
 * path, or an `in_progress` leftover — the candidate stays `proposed` and the
 * reason is stamped for diagnosis. Staging anyway would either overwrite
 * measured runs or make the candidate indistinguishable, in the evaluate step,
 * from one whose record is merely still empty.
 *
 * @param result - Counters mutated in place. / 更新するカウンタ
 * @param limit - Max candidates examined this run. / 1回の処理上限
 */
export async function stageProposedCandidates(
  result: AutoApproveResult,
  limit: number,
): Promise<void> {
  const active = await prisma.promptEvolution.findMany({
    where: { status: 'staged' },
    select: { basePromptKey: true },
  });
  const occupied = new Set(active.map((row) => row.basePromptKey));
  // Exclude occupied roles before applying the batch limit, so their waiting
  // proposals do not hide an available trial for another role. Preserve null
  // semantics explicitly rather than depending on SQL NOT IN with NULL.
  const availableRoles = [...occupied].map((key) =>
    key === null
      ? { basePromptKey: { not: null } }
      : { OR: [{ basePromptKey: null }, { basePromptKey: { not: key } }] },
  );
  const proposals = (await prisma.promptEvolution.findMany({
    where: { status: 'proposed', AND: availableRoles },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: CANDIDATE_SELECT,
  })) as CandidateRow[];

  for (const proposal of proposals) {
    if (occupied.has(proposal.basePromptKey)) {
      result.withheld++;
      continue;
    }
    const addendum = proposal.afterPrompt?.trim() ?? '';
    const blocked = textGateFailure(addendum);
    if (blocked) {
      await recordTextGateFailure(proposal, blocked, result);
      continue;
    }

    try {
      const evidence = parseEvidence(proposal.evidenceJson);
      const init = initComparisonRecordForStaging({
        promptEvolutionId: proposal.id,
        role: proposal.basePromptKey?.replace(/^workflow_role_/, '') ?? '',
        createdAt: new Date().toISOString(),
      });
      if (init.issue) {
        // Hold the candidate at `proposed`. The next run re-reads the record,
        // so a transient I/O problem clears itself; a permanently broken file
        // keeps accruing the counter for an operator to find, and is NOT
        // rejected — the fault is in the record, not in the addendum text.
        const retries =
          typeof evidence.comparisonInitRetries === 'number' ? evidence.comparisonInitRetries : 0;
        evidence.comparisonRecordIssue = init.issue;
        evidence.comparisonInitRetries = retries + 1;
        await stampEvidence(proposal.id, evidence);
        result.withheld++;
        log.warn(
          { id: proposal.id, issue: init.issue, retries: retries + 1 },
          '[prompt-evolution] Comparison record unusable — staging held, existing record preserved',
        );
        continue;
      }

      // Reserve this candidate's permanent share of the global false-adoption
      // budget BEFORE it can accrue any samples. Doing it at staging (rather
      // than at the first evaluation) is what makes the allocation
      // pre-registered: k depends only on arrival order, never on how the
      // candidate's results turn out.
      const budget = assignCandidateBudget(proposal.id);
      if (budget.issue) {
        const retries =
          typeof evidence.alphaLedgerRetries === 'number' ? evidence.alphaLedgerRetries : 0;
        evidence.alphaLedgerIssue = budget.issue;
        evidence.alphaLedgerRetries = retries + 1;
        await stampEvidence(proposal.id, evidence);
        result.withheld++;
        log.warn(
          { id: proposal.id, issue: budget.issue, retries: retries + 1 },
          '[prompt-evolution] Alpha ledger unusable — staging held, no budget issued',
        );
        continue;
      }

      evidence.stagedAt = new Date().toISOString();
      evidence.stagedSampleCount = 0;
      evidence.alphaBudgetK = budget.k;
      evidence.alphaK = budget.alphaK;
      // Per-candidate seed for the block randomisation of arm assignment.
      // Issued once so the sequence is reproducible across restarts, and drawn
      // from a CSPRNG so it is not predictable from the task id.
      if (typeof evidence.trialRandomSeed !== 'string') {
        evidence.trialRandomSeed = randomBytes(16).toString('hex');
      }
      delete evidence.autoApproveQualityRetries;
      delete evidence.comparisonRecordIssue;
      delete evidence.comparisonInitRetries;
      delete evidence.alphaLedgerIssue;
      delete evidence.alphaLedgerRetries;
      if (!(await claimStagedRole(proposal, JSON.stringify(evidence)))) {
        result.withheld++;
        continue;
      }
      occupied.add(proposal.basePromptKey);
      result.staged++;
      log.info(
        { id: proposal.id, role: proposal.basePromptKey, k: budget.k, alphaK: budget.alphaK },
        '[prompt-evolution] Staged for a limited trial — adoption now needs measured evidence',
      );
    } catch (err) {
      result.withheld++;
      log.warn({ err, id: proposal.id }, '[prompt-evolution] Staging failed');
    }
  }
}
