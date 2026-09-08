/** Strict boundary for an independent judge; never treats malformed output as approval. */
import {
  replanSnapshotDigest,
  validateReplanEvidence,
  type ReplanEvidence,
  type ReplanSnapshot,
} from './requirement-replan-evidence';

export type ReplanVerdict =
  | { kind: 'mismatch'; evidence: ReplanEvidence; reason: string }
  | { kind: 'no_mismatch'; reason: string }
  | { kind: 'unknown'; reason: string };

/** Resolve a bounded inclusive zero-based line range without changing source text. */
function sourceLines(text: string, range: unknown): string | null {
  if (!Array.isArray(range) || range.length !== 2) return null;
  const [start, end] = range;
  const lines = text.split('\n');
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end >= lines.length ||
    end - start >= 20
  )
    return null;
  const quote = lines.slice(start, end + 1).join('\n');
  return quote.trim() ? quote : null;
}

/** Parse only a complete JSON response and ground any claimed mismatch locally. */
export function parseReplanVerdict(content: string, snapshot: ReplanSnapshot): ReplanVerdict {
  let value: unknown;
  try {
    // Accept one whole JSON code fence, never extract a convenient object from prose.
    const trimmed = content.trim();
    const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
    value = JSON.parse(fence ? fence[1] : trimmed);
  } catch {
    return { kind: 'unknown', reason: 'invalid_json' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'unknown', reason: 'invalid_verdict' };
  }
  const row = value as Record<string, unknown>;
  if (typeof row.reason !== 'string' || !row.reason.trim()) {
    return { kind: 'unknown', reason: 'missing_reason' };
  }
  if (row.kind === 'unknown' || row.kind === 'no_mismatch') {
    return { kind: row.kind, reason: row.reason };
  }
  if (
    row.kind !== 'mismatch' ||
    row.requirementUnmet !== true ||
    row.planPreventsRequirement !== true ||
    row.preservesRequirements !== true ||
    row.requiresOverridingUserConstraint !== false ||
    typeof row.criterionIndex !== 'number'
  ) {
    return { kind: 'unknown', reason: 'incomplete_mismatch_verdict' };
  }
  const usesLines = 'planLines' in row || 'failureLines' in row;
  const criterion = usesLines ? snapshot.acceptanceCriteria[row.criterionIndex] : row.criterion;
  const planQuote = usesLines ? sourceLines(snapshot.plan, row.planLines) : row.planQuote;
  const failureQuote = usesLines
    ? sourceLines(snapshot.verify, row.failureLines)
    : row.failureQuote;
  if (
    typeof criterion !== 'string' ||
    typeof planQuote !== 'string' ||
    typeof failureQuote !== 'string'
  ) {
    return { kind: 'unknown', reason: 'invalid_evidence_reference' };
  }
  const evidence: ReplanEvidence = {
    snapshotDigest: replanSnapshotDigest(snapshot),
    criterionIndex: row.criterionIndex,
    criterion,
    planQuote,
    failureQuote,
  };
  const invalid = validateReplanEvidence(snapshot, evidence);
  return invalid
    ? { kind: 'unknown', reason: invalid }
    : { kind: 'mismatch', evidence, reason: row.reason };
}
