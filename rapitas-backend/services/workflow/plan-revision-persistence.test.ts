import { afterEach, beforeEach, expect, test, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PrismaClient } from '../../generated/prisma-sqlite';
import type { PrismaClient as PostgresClient } from '../../generated/prisma-postgres';

mock.module('./workflow-plan-revision-context', () => ({
  PLAN_REVISION_CAUSE: 'plan_revision_requested',
}));
const { persistPlanRevision } = await import('./plan-revision-persistence');
let directory: string;
let db: PrismaClient;
const updatedAt = new Date('2026-09-09T00:00:00Z');
const task = { id: 1, updatedAt, workflowStatus: 'plan_created' };
const persist = () =>
  persistPlanRevision(db as unknown as PostgresClient, task, '判定を修正', 'ui');

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'rapitas-plan-revision-'));
  db = new PrismaClient({
    datasources: { db: { url: `file:${join(directory, 'test.db').replaceAll('\\', '/')}` } },
  });
  await db.$executeRawUnsafe(
    'CREATE TABLE Task (id INTEGER PRIMARY KEY, status TEXT, workflowStatus TEXT, updatedAt DATETIME)',
  );
  await db.$executeRawUnsafe(
    'CREATE TABLE WorkflowTransition (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId INTEGER, fromStatus TEXT, toStatus TEXT, actor TEXT, cause TEXT, phase TEXT, executionId INTEGER, sessionId INTEGER, metadata TEXT, invariantViolation BOOLEAN DEFAULT 0, invariantMessage TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)',
  );
  await db.$executeRawUnsafe(
    'INSERT INTO Task VALUES (1, ?, ?, ?)',
    'todo',
    task.workflowStatus,
    updatedAt,
  );
});

afterEach(async () => {
  await db?.$disconnect();
  const target = resolve(directory);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !basename(target).startsWith('rapitas-plan-revision-')
  )
    throw new Error('Unsafe cleanup');
  await rm(target, { recursive: true, force: true });
});

test('state and instruction commit together', async () => {
  await persist();
  expect(await db.task.findUnique({ where: { id: 1 }, select: { workflowStatus: true } })).toEqual({
    workflowStatus: 'research_done',
  });
  const row = await db.workflowTransition.findFirst({ select: { metadata: true } });
  expect(JSON.parse(row!.metadata)).toEqual({ instruction: '判定を修正', source: 'ui' });
});

test('actual audit write failure rolls back task state and timestamp', async () => {
  await db.$executeRawUnsafe(
    "CREATE TRIGGER reject_revision BEFORE INSERT ON WorkflowTransition BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
  );
  await expect(persist()).rejects.toThrow();
  expect(
    await db.task.findUnique({
      where: { id: 1 },
      select: { status: true, workflowStatus: true, updatedAt: true },
    }),
  ).toEqual({ status: 'todo', workflowStatus: 'plan_created', updatedAt });
  expect(await db.workflowTransition.count()).toBe(0);
});

test('stale revision cannot overwrite a concurrent stop', async () => {
  await db.$executeRawUnsafe(
    'UPDATE Task SET status=?, workflowStatus=?, updatedAt=? WHERE id=1',
    'todo',
    'draft',
    new Date(updatedAt.getTime() + 1),
  );
  await expect(persist()).rejects.toThrow();
  expect(await db.task.findUnique({ where: { id: 1 }, select: { workflowStatus: true } })).toEqual({
    workflowStatus: 'draft',
  });
  expect(await db.workflowTransition.count()).toBe(0);
});
