import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma-postgres';
import type { ReplanReviewResult } from './requirement-replan-review';
import { PROCESS_INSTANCE_ID } from './verification-job-store';

const AUTOMATIC_REQUEST_KEY = 'automatic';
export const REVIEW_HEARTBEAT_INTERVAL_MS = 15_000;
export const REVIEW_LEASE_STALE_MS = 90_000;

type ClaimRow = {
  id: number;
  status: string;
  claimToken: string;
  ownerInstanceId: string;
  heartbeatAt: Date;
  resultJson: string | null;
  reason: string | null;
};

type ClaimDb = {
  task: {
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  requirementReviewClaim: {
    create(args: unknown): Promise<ClaimRow>;
    findUnique(args: unknown): Promise<ClaimRow | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  requirementReviewRetryRequest: {
    findFirst(args: unknown): Promise<{ id: number; requestId: string } | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
    create(args: unknown): Promise<unknown>;
  };
};

function models(db: PrismaClient): ClaimDb {
  return db as unknown as ClaimDb;
}

function isUniqueConflict(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002';
}

async function requestKeyForAttempt(db: PrismaClient, taskId: number): Promise<string> {
  const retry = await models(db).requirementReviewRetryRequest.findFirst({
    where: { taskId, consumedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, requestId: true },
  });
  if (!retry) return AUTOMATIC_REQUEST_KEY;
  const consumed = await models(db).requirementReviewRetryRequest.updateMany({
    where: { id: retry.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  return consumed.count === 1 ? `user:${retry.requestId}` : AUTOMATIC_REQUEST_KEY;
}

/** Persist an explicit user retry before changing task lifecycle state. */
export async function recordRequirementReviewRetryRequest(
  db: PrismaClient,
  taskId: number,
  requestId: string,
): Promise<'created' | 'duplicate'> {
  try {
    await models(db).requirementReviewRetryRequest.create({ data: { taskId, requestId } });
    return 'created';
  } catch (error) {
    if (isUniqueConflict(error)) return 'duplicate';
    throw error;
  }
}

/** Seed a known historical unknown verdict before enabling claims on an existing DB. */
export async function seedLegacyUnknownRequirementReview(
  db: PrismaClient,
  taskId: number,
  snapshotDigest: string,
  reason: string,
): Promise<'created' | 'exists'> {
  const result: ReplanReviewResult = {
    verdict: { kind: 'unknown', reason },
    snapshotDigest,
    durationMs: 0,
    tokensUsed: null,
    modelName: null,
  };
  try {
    await models(db).requirementReviewClaim.create({
      data: {
        taskId,
        snapshotDigest,
        requestKey: 'legacy-backfill',
        status: 'unknown',
        claimToken: `legacy:${randomUUID()}`,
        ownerInstanceId: 'legacy-backfill',
        heartbeatAt: new Date(),
        resultJson: JSON.stringify(result),
        reason,
      },
    });
    return 'created';
  } catch (error) {
    if (isUniqueConflict(error)) return 'exists';
    throw error;
  }
}

export type DurableReviewAdmission =
  | { kind: 'owner'; claimId: number; claimToken: string }
  | { kind: 'cached'; result: ReplanReviewResult }
  | { kind: 'in_progress'; reason: 'review_in_progress' }
  | { kind: 'held'; reason: string };

/** Claim one durable evaluation right. DB errors propagate before any AI call. */
export async function claimRequirementReview(
  db: PrismaClient,
  taskId: number,
  snapshotDigest: string,
  now = new Date(),
): Promise<DurableReviewAdmission> {
  const requestKey = await requestKeyForAttempt(db, taskId);
  const claimToken = randomUUID();
  try {
    const row = await models(db).requirementReviewClaim.create({
      data: {
        taskId,
        snapshotDigest,
        requestKey,
        status: 'evaluating',
        claimToken,
        ownerInstanceId: PROCESS_INSTANCE_ID,
        heartbeatAt: now,
      },
    });
    return { kind: 'owner', claimId: row.id, claimToken };
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
  }
  let row = await models(db).requirementReviewClaim.findUnique({
    where: { taskId_snapshotDigest: { taskId, snapshotDigest } },
  });
  if (!row) throw new Error('Requirement review claim conflict could not be read');
  if (requestKey !== AUTOMATIC_REQUEST_KEY && row.status !== 'evaluating') {
    const reset = await models(db).requirementReviewClaim.updateMany({
      where: { id: row.id, status: row.status, claimToken: row.claimToken },
      data: {
        requestKey,
        status: 'evaluating',
        claimToken,
        ownerInstanceId: PROCESS_INSTANCE_ID,
        heartbeatAt: now,
        resultJson: null,
        reason: null,
      },
    });
    if (reset.count === 1) return { kind: 'owner', claimId: row.id, claimToken };
    row = await models(db).requirementReviewClaim.findUnique({
      where: { taskId_snapshotDigest: { taskId, snapshotDigest } },
    });
    if (!row) throw new Error('Requirement review claim disappeared after contention');
  }
  if (row.status === 'unknown' && row.resultJson) {
    return { kind: 'cached', result: JSON.parse(row.resultJson) as ReplanReviewResult };
  }
  if (row.status === 'evaluating') {
    const staleBefore = new Date(now.getTime() - REVIEW_LEASE_STALE_MS);
    if (row.heartbeatAt >= staleBefore) {
      return { kind: 'in_progress', reason: 'review_in_progress' };
    }
    const markedUnknown = await models(db).requirementReviewClaim.updateMany({
      where: {
        id: row.id,
        status: 'evaluating',
        claimToken: row.claimToken,
        heartbeatAt: row.heartbeatAt,
      },
      data: { status: 'result_unknown', reason: 'review_result_unknown' },
    });
    if (markedUnknown.count === 0) return { kind: 'in_progress', reason: 'review_in_progress' };
    return { kind: 'held', reason: 'review_result_unknown' };
  }
  return {
    kind: 'held',
    reason: row.reason ?? row.status,
  };
}

/** Keep a live AI call distinguishable from a result-lost process. */
export function startRequirementReviewHeartbeat(
  db: PrismaClient,
  claimId: number,
  claimToken: string,
): () => void {
  const beat = async () => {
    await models(db).requirementReviewClaim.updateMany({
      where: { id: claimId, claimToken, status: 'evaluating' },
      data: { heartbeatAt: new Date(), ownerInstanceId: PROCESS_INSTANCE_ID },
    });
  };
  const timer = setInterval(() => void beat().catch(() => undefined), REVIEW_HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(timer);
}

/** Only the exact owner may publish the result. A lost claim fails closed. */
export async function saveRequirementReview(
  db: PrismaClient,
  claimId: number,
  claimToken: string,
  result: ReplanReviewResult,
): Promise<boolean> {
  const status = result.verdict.kind === 'unknown' ? 'unknown' : 'completed';
  const updated = await models(db).requirementReviewClaim.updateMany({
    where: { id: claimId, claimToken, status: 'evaluating' },
    data: { status, resultJson: JSON.stringify(result), reason: result.verdict.reason },
  });
  return updated.count === 1;
}

/** Park only the exact still-running lifecycle; a concurrent stop wins. */
export async function parkRequirementReviewForIntervention(
  db: PrismaClient,
  taskId: number,
  reviewedUpdatedAt: Date,
): Promise<boolean> {
  const updated = await models(db).task.updateMany({
    where: { id: taskId, status: 'in-progress', updatedAt: reviewedUpdatedAt },
    data: { status: 'blocked' },
  });
  return updated.count === 1;
}
