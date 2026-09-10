/**
 * pr-duplicate-guard テスト
 *
 * findOpenPrForTask のstate絞り込み、claimPrCreationLock のCAS取得/競合/失効判定、
 * releasePrCreationLock の解放を検証する。
 */
import { describe, test, expect, mock } from 'bun:test';
import {
  findOpenPrForTask,
  claimPrCreationLock,
  releasePrCreationLock,
} from './pr-duplicate-guard';

mock.module('../../config/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

describe('findOpenPrForTask', () => {
  test('returns the open PR when one is linked to the task', async () => {
    const findFirst = mock(() =>
      Promise.resolve({ prNumber: 42, url: 'https://github.com/o/r/pull/42' }),
    );
    const prisma = { gitHubPullRequest: { findFirst } } as unknown as Parameters<
      typeof findOpenPrForTask
    >[0];

    const result = await findOpenPrForTask(prisma, 1);

    expect(result).toEqual({ prNumber: 42, url: 'https://github.com/o/r/pull/42' });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { linkedTaskId: 1, state: 'open' } }),
    );
  });

  test('returns null when no open PR is linked', async () => {
    const findFirst = mock(() => Promise.resolve(null));
    const prisma = { gitHubPullRequest: { findFirst } } as unknown as Parameters<
      typeof findOpenPrForTask
    >[0];

    expect(await findOpenPrForTask(prisma, 1)).toBeNull();
  });

  test('returns null (fail-open) when the lookup throws', async () => {
    const findFirst = mock(() => Promise.reject(new Error('db down')));
    const prisma = { gitHubPullRequest: { findFirst } } as unknown as Parameters<
      typeof findOpenPrForTask
    >[0];

    expect(await findOpenPrForTask(prisma, 1)).toBeNull();
  });
});

const revision = new Date('2026-09-01T00:00:00Z');
const findUnique = () => Promise.resolve({ updatedAt: revision });

describe('claimPrCreationLock / releasePrCreationLock', () => {
  test('claims the lock when unheld (count:1)', async () => {
    const updateMany = mock(() => Promise.resolve({ count: 1 }));
    const prisma = { task: { updateMany, findUnique } } as unknown as Parameters<
      typeof claimPrCreationLock
    >[0];

    expect(await claimPrCreationLock(prisma, 1)).toBe(true);
    const args = updateMany.mock.calls[0][0] as { where: { id: number; OR: unknown[] } };
    expect(args.where.id).toBe(1);
    // Both branches of the OR must be present: unheld (null) or stale.
    expect(args.where.OR).toHaveLength(2);
  });

  test('fails to claim when already held by a concurrent caller (count:0)', async () => {
    const updateMany = mock(() => Promise.resolve({ count: 0 }));
    const prisma = { task: { updateMany, findUnique } } as unknown as Parameters<
      typeof claimPrCreationLock
    >[0];

    expect(await claimPrCreationLock(prisma, 1)).toBe(false);
  });

  test('fails open (treated as not claimed) when the CAS update throws', async () => {
    const updateMany = mock(() => Promise.reject(new Error('db down')));
    const prisma = { task: { updateMany, findUnique } } as unknown as Parameters<
      typeof claimPrCreationLock
    >[0];

    expect(await claimPrCreationLock(prisma, 1)).toBe(false);
  });

  test('releasePrCreationLock clears the lock field', async () => {
    const update = mock(() => Promise.resolve({ count: 1 }));
    const prisma = { task: { updateMany: update, findUnique } } as unknown as Parameters<
      typeof releasePrCreationLock
    >[0];

    await releasePrCreationLock(prisma, 1);

    expect(update).toHaveBeenCalledWith({
      where: { id: 1, updatedAt: revision },
      data: { prCreationLockedAt: null, updatedAt: revision },
    });
  });

  test('releasePrCreationLock swallows errors instead of throwing', async () => {
    const update = mock(() => Promise.reject(new Error('db down')));
    const prisma = { task: { updateMany: update, findUnique } } as unknown as Parameters<
      typeof releasePrCreationLock
    >[0];

    await expect(releasePrCreationLock(prisma, 1)).resolves.toBeUndefined();
  });
});
