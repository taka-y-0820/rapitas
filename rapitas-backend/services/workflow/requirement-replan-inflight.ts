/** Coalesce only concurrent reviews of identical evidence, never lifecycle decisions. */
import { replanSnapshotDigest, type ReplanSnapshot } from './requirement-replan-evidence';
import { reviewRequirementReplan, type ReplanReviewResult } from './requirement-replan-review';

const reviews = new WeakMap<
  typeof reviewRequirementReplan,
  Map<string, Promise<ReplanReviewResult>>
>();

export function shareInflightReplanReview(
  source: ReplanSnapshot,
  reviewer: typeof reviewRequirementReplan,
): Promise<ReplanReviewResult> {
  let pending = reviews.get(reviewer);
  if (!pending) {
    pending = new Map();
    reviews.set(reviewer, pending);
  }
  const snapshot = structuredClone(source);
  const key = replanSnapshotDigest(snapshot);
  let result = pending.get(key);
  if (!result) {
    const entries = pending;
    result = Promise.resolve()
      .then(() => reviewer(snapshot))
      .finally(() => entries.delete(key));
    entries.set(key, result);
  }
  // Each consumer owns its result; mutation by one caller must not affect the others.
  return result.then((value) => structuredClone(value));
}
