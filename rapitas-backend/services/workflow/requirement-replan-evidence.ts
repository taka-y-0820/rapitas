/**
 * Grounds a proposed requirement/plan contradiction in current persisted text.
 * This is not a semantic judge or an authorization to replan. A grounded claim
 * still needs independent evaluation and a transactional lifecycle guard.
 */
import { createHash } from 'node:crypto';

export interface ReplanSnapshot {
  title: string;
  description: string;
  goals: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  plan: string;
  verify: string;
}

export interface ReplanEvidence {
  snapshotDigest: string;
  /** Zero-based index into the unchanged explicit acceptance criteria. */
  criterionIndex: number;
  criterion: string;
  planQuote: string;
  failureQuote: string;
}

/** Bind the entire ordered criteria and both artifacts, including unseen tails. */
export function replanSnapshotDigest(snapshot: ReplanSnapshot): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        snapshot.title,
        snapshot.description,
        snapshot.goals,
        snapshot.constraints,
        snapshot.acceptanceCriteria,
        snapshot.plan,
        snapshot.verify,
      ]),
    )
    .digest('hex');
}

/** Return a diagnostic rejection; null means textual grounding only. */
export function validateReplanEvidence(
  snapshot: ReplanSnapshot,
  evidence: ReplanEvidence,
): string | null {
  if (evidence.snapshotDigest !== replanSnapshotDigest(snapshot)) return 'stale_snapshot';
  if (
    !Number.isInteger(evidence.criterionIndex) ||
    evidence.criterionIndex < 0 ||
    evidence.criterionIndex >= snapshot.acceptanceCriteria.length ||
    !evidence.criterion.trim() ||
    snapshot.acceptanceCriteria[evidence.criterionIndex] !== evidence.criterion
  ) {
    return 'criterion_mismatch';
  }
  if (!evidence.planQuote.trim() || !snapshot.plan.includes(evidence.planQuote)) {
    return 'plan_quote_missing';
  }
  if (!evidence.failureQuote.trim() || !snapshot.verify.includes(evidence.failureQuote)) {
    return 'failure_quote_missing';
  }
  return null;
}
