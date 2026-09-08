import { recoverCommittedRepair, recoverPendingRepairs } from './verify-repair-recovery';
import { canAcquireRepairQueue, clearAcquiredRepairReceipt } from './repair-queue-acquire';
import type { Prisma } from '../../generated/prisma-postgres';
import { enqueueCommittedRepair } from './verify-repair-queue';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PrismaClient } from '../../generated/prisma-sqlite';
import type { PrismaClient as PostgresClient } from '../../generated/prisma-postgres';
import { commitVerifyRepair, type RepairAdmission } from './verify-repair-commit';
let dir: string;
let db: PrismaClient;
const now = new Date('2026-09-08T00:00:00Z');
const input: RepairAdmission = {
  taskId: 1,
  updatedAt: now,
  workflowStatus: 'verify_done',
  executionId: 1,
  max: 2,
  reason: 'Required behavior failed',
  verifyContent: 'Original failure evidence',
  caller: 'test',
};
const commit = (overrides: Partial<RepairAdmission> = {}) =>
  commitVerifyRepair(db as unknown as PostgresClient, { ...input, ...overrides });
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rapitas-repair-atomic-'));
  db = new PrismaClient({
    datasources: { db: { url: `file:${join(dir, 'test.db').replaceAll('\\', '/')}` } },
  });
  for (const sql of [
    'CREATE TABLE Task (id INTEGER PRIMARY KEY, status TEXT, workflowStatus TEXT, updatedAt DATETIME, themeId INTEGER, parentId INTEGER)',
    'CREATE TABLE WorkflowFile (id INTEGER PRIMARY KEY, taskId INTEGER, fileType TEXT, content TEXT, sha256 TEXT, sizeBytes INTEGER, absolutePath TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME, UNIQUE(taskId,fileType))',
    'CREATE TABLE DeveloperModeConfig (id INTEGER PRIMARY KEY, taskId INTEGER)',
    'CREATE TABLE AgentSession (id INTEGER PRIMARY KEY, configId INTEGER)',
    'CREATE TABLE AgentExecution (id INTEGER PRIMARY KEY, sessionId INTEGER, status TEXT, startedAt DATETIME, createdAt DATETIME)',
    'CREATE TABLE ThemeAutoRun (id INTEGER PRIMARY KEY, themeId INTEGER UNIQUE, status TEXT)',
    'CREATE TABLE WorkflowQueueItem (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId INTEGER, orchestraSessionId INTEGER, themeId INTEGER, status TEXT, currentPhase TEXT, priority INTEGER, dependencies TEXT, retryCount INTEGER DEFAULT 0, maxRetries INTEGER DEFAULT 3, errorMessage TEXT, result TEXT, queuedAt DATETIME DEFAULT CURRENT_TIMESTAMP, startedAt DATETIME, completedAt DATETIME, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME)',
    'CREATE TABLE WorkflowFileVersion (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId INTEGER, fileType TEXT, content TEXT, sha256 TEXT, sizeBytes INTEGER, archivedAt DATETIME DEFAULT CURRENT_TIMESTAMP)',
    'CREATE TABLE ActivityLog (id INTEGER PRIMARY KEY, taskId INTEGER, action TEXT, createdAt DATETIME)',
    'CREATE TABLE WorkflowTransition (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId INTEGER, fromStatus TEXT, toStatus TEXT, actor TEXT, cause TEXT, phase TEXT, executionId INTEGER, sessionId INTEGER, metadata TEXT DEFAULT "{}", invariantViolation BOOLEAN DEFAULT 0, invariantMessage TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)',
    "INSERT INTO WorkflowFile (id,taskId,fileType) VALUES (1,1,'plan')",
    'INSERT INTO DeveloperModeConfig VALUES (1,1)',
    'INSERT INTO AgentSession VALUES (1,1)',
  ])
    await db.$executeRawUnsafe(sql);
  await db.$executeRawUnsafe(
    "INSERT INTO Task (id,status,workflowStatus,updatedAt,themeId) VALUES (1,'in-progress','verify_done',?,NULL)",
    now,
  );
  await db.$executeRawUnsafe("INSERT INTO AgentExecution VALUES (1,1,'running',?,?)", now, now);
});
afterEach(async () => {
  await db?.$disconnect();
  if (dir) {
    const target = resolve(dir);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith('rapitas-repair-atomic-')
    )
      throw new Error('Unsafe test cleanup path');
    await rm(target, { recursive: true, force: true });
  }
});
async function unchanged() {
  expect(await db.task.findUnique({ where: { id: 1 }, select: { workflowStatus: true } })).toEqual({
    workflowStatus: 'verify_done',
  });
  expect(await db.workflowTransition.count({ where: { cause: 'verify_repair' } })).toBe(0);
}
test('audit failure rolls back state and budget together', async () => {
  await db.$executeRawUnsafe(
    "CREATE TRIGGER fail_audit BEFORE INSERT ON WorkflowTransition BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
  );
  await expect(commit()).rejects.toThrow();
  await unchanged();
});
test('concurrent verdicts consume one attempt and retain exact recovery evidence', async () => {
  const results = await Promise.all([commit(), commit()]);
  expect(results.filter((r) => r.committed)).toHaveLength(1);
  const rows = await db.workflowTransition.findMany({ select: { metadata: true } });
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0].metadata)).toMatchObject({
    attempt: 1,
    verifyContent: input.verifyContent,
  });
});
test('durable stop intent blocks repair before task status changes', async () => {
  await db.$executeRawUnsafe(
    "INSERT INTO WorkflowTransition (taskId,cause,createdAt) VALUES (1,'theme_stop_execution_requested',?)",
    now,
  );
  expect(await commit()).toEqual({ committed: false, reason: 'stop_requested' });
  await unchanged();
});
test('new execution does not authorize an old verdict', async () => {
  await db.$executeRawUnsafe(
    "INSERT INTO AgentExecution VALUES (2,1,'running',?,?)",
    new Date(now.getTime() + 1),
    new Date(now.getTime() + 1),
  );
  expect(await commit()).toEqual({ committed: false, reason: 'execution_superseded' });
  await unchanged();
});
test('canceling execution blocks admission', async () => {
  await db.$executeRawUnsafe("UPDATE AgentExecution SET status='canceling'");
  expect(await commit()).toEqual({ committed: false, reason: 'execution_stopped' });
  await unchanged();
});
test('budget is enforced in the transaction', async () => {
  const first = await commit({ max: 1 });
  if (!first.committed) throw new Error('First repair failed');
  expect(
    await commit({ max: 1, workflowStatus: first.newStatus, updatedAt: first.updatedAt }),
  ).toEqual({ committed: false, reason: 'budget_exhausted' });
  expect(await db.workflowTransition.count()).toBe(1);
});

async function repairReceipt() {
  const result = await commit();
  if (!result.committed) throw new Error('Repair not committed');
  return { updatedAt: result.updatedAt, workflowStatus: result.newStatus, executionId: 1 };
}
test('stop after repair commit prevents queue registration', async () => {
  const receipt = await repairReceipt();
  await db.$executeRawUnsafe(
    "INSERT INTO WorkflowTransition (taskId,cause,createdAt) VALUES (1,'theme_stop_execution_requested',?)",
    new Date(),
  );
  expect(await enqueueCommittedRepair(db as unknown as PostgresClient, 1, receipt)).toBe('held');
  expect(await db.workflowQueueItem.count()).toBe(0);
});
test('concurrent repair delivery creates one durable queue item', async () => {
  const receipt = await repairReceipt();
  const results = await Promise.all(
    [1, 2].map(() => enqueueCommittedRepair(db as unknown as PostgresClient, 1, receipt)),
  );
  expect(results.sort()).toEqual(['existing', 'queued']);
  expect(await db.workflowQueueItem.count()).toBe(1);
});
test('failed queue write is observable and the same receipt can retry', async () => {
  const receipt = await repairReceipt();
  await db.$executeRawUnsafe(
    "CREATE TRIGGER fail_queue BEFORE INSERT ON WorkflowQueueItem BEGIN SELECT RAISE(ABORT, 'queue unavailable'); END",
  );
  await expect(
    enqueueCommittedRepair(db as unknown as PostgresClient, 1, receipt),
  ).rejects.toThrow();
  expect(await db.workflowQueueItem.count()).toBe(0);
  await db.$executeRawUnsafe('DROP TRIGGER fail_queue');
  expect(await enqueueCommittedRepair(db as unknown as PostgresClient, 1, receipt)).toBe('queued');
  expect(await db.workflowTransition.count({ where: { cause: 'verify_repair' } })).toBe(1);
});
test('old delivery cannot enqueue a newer execution', async () => {
  const receipt = await repairReceipt();
  await db.$executeRawUnsafe(
    "INSERT INTO AgentExecution VALUES (2,1,'running',?,?)",
    new Date(),
    new Date(),
  );
  expect(await enqueueCommittedRepair(db as unknown as PostgresClient, 1, receipt)).toBe('held');
  expect(await db.workflowQueueItem.count()).toBe(0);
});

test('stop between enqueue and acquire invalidates the persisted receipt', async () => {
  const receipt = await repairReceipt();
  await enqueueCommittedRepair(db as unknown as PostgresClient, 1, receipt);
  const item = await db.workflowQueueItem.findFirstOrThrow({
    select: { taskId: true, result: true },
  });
  expect(
    await db.$transaction((tx) =>
      canAcquireRepairQueue(tx as unknown as Prisma.TransactionClient, item),
    ),
  ).toBe(true);
  await db.$executeRawUnsafe(
    "INSERT INTO WorkflowTransition (taskId,cause,createdAt) VALUES (1,'manual_execution_stop_revert',?)",
    new Date(),
  );
  expect(
    await db.$transaction((tx) =>
      canAcquireRepairQueue(tx as unknown as Prisma.TransactionClient, item),
    ),
  ).toBe(false);
});
test('successful acquisition consumes only the repair admission receipt', async () => {
  const receipt = await repairReceipt();
  const metadata = JSON.stringify({ repairResume: receipt });
  expect(clearAcquiredRepairReceipt(metadata)).toBeNull();
  expect(clearAcquiredRepairReceipt('{"phase":"verify"}')).toBe('{"phase":"verify"}');
  expect(
    await db.$transaction((tx) =>
      canAcquireRepairQueue(tx as unknown as Prisma.TransactionClient, {
        taskId: 1,
        result: '{"repairResume":{"updatedAt":"invalid"}}',
      }),
    ),
  ).toBe(false);
});

test('feedback failure rolls back state, audit, and budget', async () => {
  await db.$executeRawUnsafe(
    "CREATE TRIGGER fail_feedback BEFORE INSERT ON WorkflowFile WHEN NEW.fileType='verify' BEGIN SELECT RAISE(ABORT, 'feedback unavailable'); END",
  );
  await expect(commit()).rejects.toThrow();
  await unchanged();
  expect(await db.workflowFileVersion.count()).toBe(0);
});
test('newer verification content cannot be overwritten by an old repair', async () => {
  await db.$executeRawUnsafe(
    "INSERT INTO WorkflowFile (taskId,fileType,content,sha256,sizeBytes) VALUES (1,'verify','New verification','digest',16)",
  );
  expect(await commit()).toEqual({ committed: false, reason: 'stale_verification' });
  await unchanged();
});
test('repair preserves the original verification and archives it atomically', async () => {
  await db.$executeRawUnsafe(
    "INSERT INTO WorkflowFile (taskId,fileType,content,sha256,sizeBytes) VALUES (1,'verify',?,'digest',?)",
    input.verifyContent,
    input.verifyContent.length,
  );
  expect((await commit()).committed).toBe(true);
  const saved = await db.workflowFile.findUniqueOrThrow({
    where: { taskId_fileType: { taskId: 1, fileType: 'verify' } },
    select: { content: true },
  });
  expect(saved.content).toContain(input.verifyContent);
  expect(saved.content).toContain('repair-feedback:start');
  expect(
    (await db.workflowFileVersion.findFirstOrThrow({ select: { content: true } })).content,
  ).toBe(input.verifyContent);
});

test('a fresh database client recovers committed repair delivery without spending budget', async () => {
  expect((await commit()).committed).toBe(true);
  await db.$disconnect();
  db = new PrismaClient({
    datasources: { db: { url: `file:${join(dir, 'test.db').replaceAll('\\', '/')}` } },
  });
  expect(await recoverCommittedRepair(db as unknown as PostgresClient, 1)).toBe('queued');
  expect(await recoverCommittedRepair(db as unknown as PostgresClient, 1)).toBe('existing');
  expect(await db.workflowTransition.count({ where: { cause: 'verify_repair' } })).toBe(1);
  expect(await db.workflowQueueItem.count()).toBe(1);
});
test('recovery preserves a stop issued after repair commit', async () => {
  expect((await commit()).committed).toBe(true);
  await db.$executeRawUnsafe(
    "INSERT INTO WorkflowTransition (taskId,cause,createdAt) VALUES (1,'theme_stop_execution_requested',?)",
    new Date(),
  );
  expect(await recoverCommittedRepair(db as unknown as PostgresClient, 1)).toBe('held');
  expect(await db.workflowQueueItem.count()).toBe(0);
});

test('periodic recovery waits for the agent, then delivers and wakes processing', async () => {
  expect((await commit()).committed).toBe(true);
  let wakes = 0;
  const later = Date.now() + 120_000;
  expect(await recoverPendingRepairs(db as unknown as PostgresClient, () => wakes++, later)).toBe(
    0,
  );
  expect(wakes).toBe(0);
  await db.$executeRawUnsafe("UPDATE AgentExecution SET status='completed'");
  expect(await recoverPendingRepairs(db as unknown as PostgresClient, () => wakes++, later)).toBe(
    1,
  );
  expect(wakes).toBe(1);
  expect(await db.workflowTransition.count({ where: { cause: 'verify_repair' } })).toBe(1);
});
