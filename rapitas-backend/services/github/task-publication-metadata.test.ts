/** Real generated SQLite client: no application DB or schema generation. */
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '../../generated/prisma-sqlite';
import type { PrismaClient as PostgresClient } from '../../generated/prisma-postgres';
import { updateTaskPublicationMetadata } from './task-publication-metadata';
import { claimPrCreationLock, releasePrCreationLock } from './pr-duplicate-guard';
mock.module('../workflow/auto-merge-notify', () => ({ notify: async () => {} }));
const { linkAutoCreatedPr } = await import('./pr-link');

let directory: string;
let client: PrismaClient;
let sql: Database;
const revision = new Date('2026-09-01T00:00:00Z');
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'rapitas-publication-metadata-'));
  const path = join(directory, 'test.db');
  sql = new Database(path);
  sql.exec(
    'CREATE TABLE Task (id INTEGER PRIMARY KEY, updatedAt DATETIME, prCreationLockedAt DATETIME, githubPrId INTEGER)',
  );
  sql.query('INSERT INTO Task VALUES (1, ?, NULL, NULL)').run(revision.getTime());
  client = new PrismaClient({ datasources: { db: { url: `file:${path.replaceAll('\\', '/')}` } } });
});
afterEach(async () => {
  await client.$disconnect();
  sql.close();
  rmSync(directory, { recursive: true, force: true });
});
const db = () => client as unknown as PostgresClient;
const row = () =>
  client.task.findUniqueOrThrow({
    where: { id: 1 },
    select: { updatedAt: true, prCreationLockedAt: true, githubPrId: true },
  });

test('ordinary Prisma bookkeeping invalidates a review, publication bookkeeping preserves it', async () => {
  await client.task.updateMany({ where: { id: 1 }, data: { prCreationLockedAt: new Date() } });
  expect((await row()).updatedAt.getTime()).not.toBe(revision.getTime());
  sql.query('UPDATE Task SET updatedAt=?, prCreationLockedAt=NULL').run(revision.getTime());
  expect(await claimPrCreationLock(db(), 1)).toBe(true);
  expect(await claimPrCreationLock(db(), 1)).toBe(false);
  expect(await updateTaskPublicationMetadata(db(), 1, { githubPrId: 42 })).toBe(true);
  await releasePrCreationLock(db(), 1);
  expect(await row()).toEqual({ updatedAt: revision, prCreationLockedAt: null, githubPrId: 42 });
});

test('two real concurrent lock claims cannot both win', async () => {
  const claims = await Promise.all([claimPrCreationLock(db(), 1), claimPrCreationLock(db(), 1)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect((await row()).updatedAt).toEqual(revision);
});

test('a concurrent content revision is never overwritten or accepted as the reviewed revision', async () => {
  const newer = new Date('2026-09-02T00:00:00Z');
  const raced = {
    task: {
      findUnique: async () => {
        const before = await row();
        sql.query('UPDATE Task SET updatedAt=? WHERE id=1').run(newer.getTime());
        return before;
      },
      updateMany: client.task.updateMany.bind(client.task),
    },
  } as unknown as PostgresClient;
  expect(await updateTaskPublicationMetadata(raced, 1, { githubPrId: 42 })).toBe(false);
  expect(await row()).toEqual({ updatedAt: newer, prCreationLockedAt: null, githubPrId: null });
});

test('missing task cannot acquire publication metadata', async () => {
  expect(await updateTaskPublicationMetadata(db(), 999, { githubPrId: 42 })).toBe(false);
});

test('the actual PR linking path preserves the reviewed revision', async () => {
  const publishingDb = {
    task: client.task,
    gitHubIntegration: {
      findMany: async () => [{ id: 1, ownerName: 'owner', repositoryName: 'repo' }],
      findUnique: async () => ({ ownerName: 'owner' }),
    },
    gitHubPullRequest: {
      findUnique: async () => null,
      upsert: async () => ({ id: 50 }),
    },
  } as unknown as PostgresClient;
  expect(
    await linkAutoCreatedPr(publishingDb, {
      taskId: 1,
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      title: 'Task 1',
      headBranch: 'feature/t1',
      baseBranch: 'develop',
      repositoryUrl: 'https://github.com/owner/repo',
    }),
  ).toBe(50);
  expect(await row()).toEqual({ updatedAt: revision, prCreationLockedAt: null, githubPrId: 42 });
});

test('an expired lock can be reclaimed without changing the content revision', async () => {
  sql.query('UPDATE Task SET prCreationLockedAt=?').run(Date.now() - 360000);
  expect(await claimPrCreationLock(db(), 1)).toBe(true);
  expect((await row()).updatedAt).toEqual(revision);
});
