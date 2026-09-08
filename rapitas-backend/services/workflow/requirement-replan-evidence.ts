/**
 * Grounds a proposed requirement/plan contradiction in current persisted text.
 * This is not a semantic judge or an authorization to replan. A grounded claim
 * still needs independent evaluation and a transactional lifecycle guard.
 */
import type { ReviewedPlanPolicy } from './reviewed-plan-policy';
import { createHash } from 'node:crypto';

export interface ReplanSnapshot {
  planPolicy?: ReviewedPlanPolicy;
  title: string;
  description: string;
  goals: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  plan: string;
  verify: string;
}

export type ReplanRequirementSource =
  | 'acceptanceCriteria'
  | 'description'
  | 'goals'
  | 'constraints'
  | 'title';

/** Original text only; never synthesizes or persists replacement requirements. */
export function replanRequirementSources(
  snapshot: ReplanSnapshot,
): Record<ReplanRequirementSource, string[]> {
  return {
    acceptanceCriteria: snapshot.acceptanceCriteria,
    description: snapshot.description.split('\n'),
    goals: snapshot.goals,
    constraints: snapshot.constraints,
    title: [snapshot.title],
  };
}

export interface ReplanEvidence {
  criterionSource?: ReplanRequirementSource;
  snapshotDigest: string;
  /** Zero-based index into the original selected requirement source. */
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
        snapshot.planPolicy ?? { mode: 'comprehensive', includePlan: true },
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
  const criteria =
    replanRequirementSources(snapshot)[evidence.criterionSource ?? 'acceptanceCriteria'];
  if (
    !criteria ||
    !Number.isInteger(evidence.criterionIndex) ||
    evidence.criterionIndex < 0 ||
    evidence.criterionIndex >= criteria.length ||
    !evidence.criterion.trim() ||
    criteria[evidence.criterionIndex] !== evidence.criterion
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
