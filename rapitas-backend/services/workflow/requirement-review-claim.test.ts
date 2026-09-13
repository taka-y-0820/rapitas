import { expect, test } from 'bun:test';
import type { PrismaClient } from '../../generated/prisma-postgres';
import {
  claimRequirementReview,
  parkRequirementReviewForIntervention,
  recordRequirementReviewRetryRequest,
  REVIEW_LEASE_STALE_MS,
  saveRequirementReview,
  seedLegacyUnknownRequirementReview,
} from './requirement-review-claim';

function fakeDb() {
  const claims = new Map<string, any>();
  const retries: any[] = [];
  let id = 0;
  const db = {
    task: {
      async updateMany() {
        return { count: 1 };
      },
    },
    requirementReviewClaim: {
      async create({ data }: any) {
        const key = `${data.taskId}:${data.snapshotDigest}`;
        if (claims.has(key)) throw Object.assign(new Error('unique'), { code: 'P2002' });
        const row = { id: ++id, resultJson: null, reason: null, ...data };
        claims.set(key, row);
        return row;
      },
      async findUnique({ where }: any) {
        const v = where.taskId_snapshotDigest;
        return claims.get(`${v.taskId}:${v.snapshotDigest}`) ?? null;
      },
      async updateMany({ where, data }: any) {
        const row = [...claims.values()].find(
          (x) =>
            x.id === where.id && x.claimToken === where.claimToken && x.status === where.status,
        );
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    requirementReviewRetryRequest: {
      async create({ data }: any) {
        if (retries.some((x) => x.requestId === data.requestId))
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        retries.push({ id: retries.length + 1, consumedAt: null, createdAt: new Date(), ...data });
        return retries.at(-1);
      },
      async findFirst({ where }: any) {
        return retries.find((x) => x.taskId === where.taskId && x.consumedAt === null) ?? null;
      },
      async updateMany({ where, data }: any) {
        const row = retries.find((x) => x.id === where.id && x.consumedAt === null);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
  };
  return { db: db as unknown as PrismaClient, claims, retries };
}

test('concurrent workers grant one owner and treat the healthy evaluation as in progress', async () => {
  const { db } = fakeDb();
  const [a, b] = await Promise.all([
    claimRequirementReview(db, 1, 'same'),
    claimRequirementReview(db, 1, 'same'),
  ]);
  expect([a.kind, b.kind].sort()).toEqual(['in_progress', 'owner']);
});

test('a stale evaluation after process loss becomes result unknown without reevaluation', async () => {
  const { db, claims } = fakeDb();
  expect((await claimRequirementReview(db, 1, 'same')).kind).toBe('owner');
  const row = claims.get('1:same');
  row.heartbeatAt = new Date(0);
  expect(await claimRequirementReview(db, 1, 'same', new Date(REVIEW_LEASE_STALE_MS + 1))).toEqual({
    kind: 'held',
    reason: 'review_result_unknown',
  });
});

test('a changed snapshot is allowed a new automatic evaluation', async () => {
  const { db } = fakeDb();
  expect((await claimRequirementReview(db, 1, 'old')).kind).toBe('owner');
  expect((await claimRequirementReview(db, 1, 'new')).kind).toBe('owner');
});

test('an explicit retry id is idempotent and authorizes one distinct claim', async () => {
  const { db } = fakeDb();
  const automatic = await claimRequirementReview(db, 1, 'same');
  if (automatic.kind !== 'owner') throw new Error('expected owner');
  await saveRequirementReview(db, automatic.claimId, automatic.claimToken, {
    verdict: { kind: 'unknown', reason: 'invalid_json' },
    snapshotDigest: 'same',
    durationMs: 1,
    tokensUsed: null,
    modelName: null,
  });
  expect(await recordRequirementReviewRetryRequest(db, 1, 'retry-1')).toBe('created');
  expect(await recordRequirementReviewRetryRequest(db, 1, 'retry-1')).toBe('duplicate');
  expect((await claimRequirementReview(db, 1, 'same')).kind).toBe('owner');
  expect((await claimRequirementReview(db, 1, 'same')).kind).toBe('in_progress');
});

test('a DB failure is propagated before an evaluation owner is returned', async () => {
  const { db } = fakeDb();
  (db as any).requirementReviewRetryRequest.findFirst = async () => {
    throw new Error('db unavailable');
  };
  await expect(claimRequirementReview(db, 1, 'same')).rejects.toThrow('db unavailable');
});

test('unknown result is persisted and reused without another owner', async () => {
  const { db } = fakeDb();
  const owner = await claimRequirementReview(db, 1, 'same');
  if (owner.kind !== 'owner') throw new Error('expected owner');
  const result = {
    verdict: { kind: 'unknown' as const, reason: 'invalid_json' },
    snapshotDigest: 'same',
    durationMs: 1,
    tokensUsed: null,
    modelName: null,
  };
  expect(await saveRequirementReview(db, owner.claimId, owner.claimToken, result)).toBe(true);
  expect(await claimRequirementReview(db, 1, 'same')).toEqual({ kind: 'cached', result });
});

test('a legacy Task 901 snapshot is seeded idempotently and is never reevaluated automatically', async () => {
  const { db } = fakeDb();
  expect(await seedLegacyUnknownRequirementReview(db, 901, 'historic', 'legacy_unknown')).toBe(
    'created',
  );
  expect(await seedLegacyUnknownRequirementReview(db, 901, 'historic', 'legacy_unknown')).toBe(
    'exists',
  );
  const admission = await claimRequirementReview(db, 901, 'historic');
  expect(admission.kind).toBe('cached');
  if (admission.kind === 'cached') {
    expect(admission.result.verdict).toEqual({ kind: 'unknown', reason: 'legacy_unknown' });
  }
});

test('a new explicit retry request can replace a completed unknown claim once', async () => {
  const { db } = fakeDb();
  const owner = await claimRequirementReview(db, 1, 'same');
  if (owner.kind !== 'owner') throw new Error('expected owner');
  await saveRequirementReview(db, owner.claimId, owner.claimToken, {
    verdict: { kind: 'unknown', reason: 'review_unavailable' },
    snapshotDigest: 'same',
    durationMs: 1,
    tokensUsed: null,
    modelName: null,
  });
  await recordRequirementReviewRetryRequest(db, 1, 'retry-2');
  expect((await claimRequirementReview(db, 1, 'same')).kind).toBe('owner');
  expect((await claimRequirementReview(db, 1, 'same')).kind).toBe('in_progress');
});

test('a DB failure prevents claim acquisition', async () => {
  const { db } = fakeDb();
  (db as any).requirementReviewRetryRequest.findFirst = async () => {
    throw new Error('db unavailable');
  };
  await expect(claimRequirementReview(db, 1, 'same')).rejects.toThrow('db unavailable');
});

test('a changed snapshot receives a fresh automatic evaluation right', async () => {
  const { db } = fakeDb();
  expect((await claimRequirementReview(db, 1, 'old')).kind).toBe('owner');
  expect((await claimRequirementReview(db, 1, 'new')).kind).toBe('owner');
});

test('one explicit retry request authorizes one fresh claim and is idempotent', async () => {
  const { db } = fakeDb();
  expect(await recordRequirementReviewRetryRequest(db, 1, 'request-1')).toBe('created');
  expect(await recordRequirementReviewRetryRequest(db, 1, 'request-1')).toBe('duplicate');
  expect((await claimRequirementReview(db, 1, 'same')).kind).toBe('owner');
  expect((await claimRequirementReview(db, 1, 'same')).kind).toBe('in_progress');
});

test('DB lookup failure prevents evaluation ownership', async () => {
  const { db } = fakeDb();
  (db as any).requirementReviewRetryRequest.findFirst = () => Promise.reject(new Error('db down'));
  await expect(claimRequirementReview(db, 1, 'same')).rejects.toThrow('db down');
});

test('a non-owner cannot save a review result', async () => {
  const { db } = fakeDb();
  const owner = await claimRequirementReview(db, 1, 'same');
  if (owner.kind !== 'owner') throw new Error('expected owner');
  expect(
    await saveRequirementReview(db, owner.claimId, 'wrong-token', {
      verdict: { kind: 'unknown', reason: 'late' },
      snapshotDigest: 'same',
      durationMs: 1,
      tokensUsed: null,
      modelName: null,
    }),
  ).toBe(false);
});

test('intervention update is conditional so a concurrent stop is never overwritten', async () => {
  const { db } = fakeDb();
  let received: any;
  (db as any).task.updateMany = async (args: any) => {
    received = args;
    return { count: 0 }; // stop already changed status/revision
  };
  const revision = new Date('2026-09-11T00:00:00Z');
  expect(await parkRequirementReviewForIntervention(db, 1, revision)).toBe(false);
  expect(received).toEqual({
    where: { id: 1, status: 'in-progress', updatedAt: revision },
    data: { status: 'blocked' },
  });
});
