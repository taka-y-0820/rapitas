/** Retire unusable measurement cohorts, preserving their records and allocating a fresh trial identity. */
import { prisma } from '../../config/database';
import { parseEvidence } from './prompt-evolution-auto-approve-shared';
import { readTrialManifest } from './comparison/prompt-comparison-trial-manifest';
import type { TrialRecoveryResult } from './comparison/prompt-comparison-reconcile';

export const TRIAL_EVIDENCE_GRACE_MS = 60 * 60 * 1000;
export const MAX_PROSPECTIVE_RETRIES = 3;

/** Expiration invalidates measurement only; it never declares a CLI stopped or restarts a task. */
export function staleTrialIssue(
  candidate: { id: number; evidenceJson: string | null; createdAt: Date },
  recovery: TrialRecoveryResult,
  now: Date,
): string | null {
  const evidence = parseEvidence(candidate.evidenceJson);
  const stagedAt =
    typeof evidence.stagedAt === 'string'
      ? Date.parse(evidence.stagedAt)
      : candidate.createdAt.getTime();
  if (!Number.isFinite(stagedAt) || now.getTime() - stagedAt < TRIAL_EVIDENCE_GRACE_MS) return null;
  const manifest = readTrialManifest(candidate.id);
  // A failed read cannot distinguish absent history from a transient storage fault.
  if (!manifest) return null;
  const unusable = new Set([
    'session_not_bound',
    'session_missing',
    'session_identity_mismatch',
    'injection_proof_missing_or_mismatched',
    'execution_missing',
    'execution_metadata_incomplete',
  ]);
  for (const issue of recovery.issues) {
    const slot = manifest.slots.find((s) => s.id === issue.assignmentId);
    if (
      slot &&
      unusable.has(issue.reason) &&
      now.getTime() - Date.parse(slot.createdAt) >= TRIAL_EVIDENCE_GRACE_MS
    ) {
      return issue.reason;
    }
  }
  return null;
}

/**
 * One transaction claims the old row and creates at most one successor. The
 * successor has no inherited samples, random seed, or alpha budget. Rejected
 * history remains queryable through retryOfId/rootCandidateId and replacementId.
 */
export async function restartUnusableTrial(
  id: number,
  expectedEvidence: string | null,
  reason: string,
  now = new Date(),
): Promise<{ retired: boolean; replacementId: number | null }> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.promptEvolution.findUnique({ where: { id } });
    if (
      !row ||
      !['proposed', 'staged'].includes(row.status) ||
      row.evidenceJson !== expectedEvidence
    ) {
      return { retired: false, replacementId: null };
    }
    // Never erase malformed historical evidence during an automatic retry.
    if (row.evidenceJson !== null) {
      try {
        const parsed = JSON.parse(row.evidenceJson);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          return { retired: false, replacementId: null };
      } catch {
        return { retired: false, replacementId: null };
      }
    }
    const evidence = parseEvidence(row.evidenceJson);
    const storedRetries = evidence.prospectiveRetryCount;
    const retries =
      storedRetries === undefined
        ? 0
        : typeof storedRetries === 'number' &&
            Number.isSafeInteger(storedRetries) &&
            storedRetries >= 0
          ? storedRetries
          : MAX_PROSPECTIVE_RETRIES;
    const rootCandidateId =
      typeof evidence.rootCandidateId === 'number' &&
      Number.isSafeInteger(evidence.rootCandidateId) &&
      evidence.rootCandidateId > 0
        ? evidence.rootCandidateId
        : row.id;
    const retiredEvidence = {
      ...evidence,
      trialInvalidatedAt: now.toISOString(),
      trialInvalidationReason: reason,
      retryLimitReached: retries >= MAX_PROSPECTIVE_RETRIES,
    };
    const claim = await tx.promptEvolution.updateMany({
      where: { id, status: row.status, evidenceJson: expectedEvidence },
      data: { status: 'rejected', evidenceJson: JSON.stringify(retiredEvidence) },
    });
    if (claim.count !== 1) return { retired: false, replacementId: null };
    if (retries >= MAX_PROSPECTIVE_RETRIES) return { retired: true, replacementId: null };
    const replacement = await tx.promptEvolution.create({
      data: {
        category: row.category,
        beforePrompt: row.beforePrompt,
        afterPrompt: row.afterPrompt,
        basePromptKey: row.basePromptKey,
        experimentId: row.experimentId,
        reason: row.reason,
        improvement: row.improvement,
        status: 'proposed',
        evidenceJson: JSON.stringify({
          retryOfId: row.id,
          rootCandidateId,
          prospectiveRetryCount: retries + 1,
          retryReason: reason,
        }),
      },
    });
    await tx.promptEvolution.update({
      where: { id },
      data: {
        evidenceJson: JSON.stringify({ ...retiredEvidence, replacementId: replacement.id }),
      },
    });
    return { retired: true, replacementId: replacement.id };
  });
}
