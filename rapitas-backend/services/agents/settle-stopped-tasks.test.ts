import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PrismaClient } from '../../generated/prisma-sqlite';
import type { PrismaClient as PostgresClient } from '../../generated/prisma-postgres';
import { settleStoppedTasks } from './settle-stopped-tasks';
import { settleStoppedSessions } from './settle-stopped-sessions';
import {
  recordThemeStopIntent,
  readThemeStopIntent,
  readPendingThemeStopTargets,
} from './theme-stop-intent';
let dir: string;
let db: PrismaClient;
const now = new Date('2026-09-08T00:00:00Z');
const snapshot = {
  title: 'test',
  description: '',
  goals: [],
  constraints: [],
  acceptanceCriteria: ['完了状態を維持'],
  plan: '状態処理は非対象',
  verify: '完了状態を上書きした',
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rapitas-replan-test-'));
  db = new PrismaClient({
    datasources: { db: { url: `file:${join(dir, 'test.db').replaceAll('\\', '/')}` } },
  });
  // Minimal isolated schema for the real Prisma queries; never reads the operational database.
  for (const sql of [
    'CREATE TABLE Task (id INTEGER PRIMARY KEY, title TEXT, description TEXT, goals TEXT, constraints TEXT, acceptanceCriteria TEXT, status TEXT, workflowStatus TEXT, updatedAt DATETIME, themeId INTEGER)',
    'CREATE TABLE WorkflowFile (id INTEGER PRIMARY KEY, taskId INTEGER, fileType TEXT, content TEXT, UNIQUE(taskId,fileType))',
    'CREATE TABLE DeveloperModeConfig (id INTEGER PRIMARY KEY, taskId INTEGER)',
    'CREATE TABLE AgentSession (id INTEGER PRIMARY KEY, configId INTEGER)',
    'CREATE TABLE AgentExecution (id INTEGER PRIMARY KEY, sessionId INTEGER, status TEXT, startedAt DATETIME)',
    'CREATE TABLE ThemeAutoRun (id INTEGER PRIMARY KEY, themeId INTEGER UNIQUE, status TEXT)',
    'CREATE TABLE WorkflowTransition (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId INTEGER, fromStatus TEXT, toStatus TEXT, actor TEXT, cause TEXT, phase TEXT, executionId INTEGER, sessionId INTEGER, metadata TEXT DEFAULT "{}", invariantViolation BOOLEAN DEFAULT 0, invariantMessage TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)',
  ])
    await db.$executeRawUnsafe(sql);
  await db.$executeRawUnsafe(
    'INSERT INTO Task VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
    snapshot.title,
    snapshot.description,
    '[]',
    '[]',
    JSON.stringify(snapshot.acceptanceCriteria),
    'in-progress',
    'plan_approved',
    now,
  );
  await db.$executeRawUnsafe(
    'INSERT INTO WorkflowFile VALUES (1,1,?,?), (2,1,?,?)',
    'plan',
    snapshot.plan,
    'verify',
    snapshot.verify,
  );
});

afterEach(async () => {
  await db?.$disconnect();
  // Only the unique directory returned by mkdtemp is removed.
  if (dir) {
    const target = resolve(dir);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith('rapitas-replan-test-')
    ) {
      throw new Error('Refusing cleanup outside the isolated test directory');
    }
    await rm(target, { recursive: true, force: true });
  }
});

async function cancelledExecution() {
  await db.$executeRawUnsafe('INSERT INTO DeveloperModeConfig VALUES (1,1)');
  await db.$executeRawUnsafe('INSERT INTO AgentSession VALUES (1,1)');
  await db.$executeRawUnsafe("INSERT INTO AgentExecution VALUES (1,1,'cancelled',?)", now);
}

test('session update failure propagates and durable targets allow a later retry', async () => {
  await cancelledExecution();
  await db.$executeRawUnsafe("ALTER TABLE AgentSession ADD COLUMN status TEXT DEFAULT 'running'");
  await db.$executeRawUnsafe('ALTER TABLE AgentSession ADD COLUMN updatedAt DATETIME');
  const client = db as unknown as PostgresClient;
  await recordThemeStopIntent(client, 1, [1]);
  await db.$executeRawUnsafe(
    "CREATE TRIGGER reject_session_update BEFORE UPDATE ON AgentSession BEGIN SELECT RAISE(ABORT, 'session write failure'); END",
  );
  await expect(settleStoppedSessions(client, [1])).rejects.toThrow();
  expect(await db.agentSession.findUnique({ where: { id: 1 }, select: { status: true } })).toEqual({
    status: 'running',
  });
  await db.$executeRawUnsafe('DROP TRIGGER reject_session_update');
  const targets = await readPendingThemeStopTargets(client, 1);
  expect(targets).toEqual([1]);
  await settleStoppedSessions(client, targets);
  expect(await db.agentSession.findUnique({ where: { id: 1 }, select: { status: true } })).toEqual({
    status: 'cancelled',
  });
});

test('session settlement preserves an active execution sharing the cancelled targets session', async () => {
  await cancelledExecution();
  await db.$executeRawUnsafe("ALTER TABLE AgentSession ADD COLUMN status TEXT DEFAULT 'running'");
  await db.$executeRawUnsafe('ALTER TABLE AgentSession ADD COLUMN updatedAt DATETIME');
  await db.$executeRawUnsafe("INSERT INTO AgentExecution VALUES (2,1,'running',?)", now);
  await settleStoppedSessions(db as unknown as PostgresClient, [1]);
  expect(await db.agentSession.findUnique({ where: { id: 1 }, select: { status: true } })).toEqual({
    status: 'running',
  });
  await db.$executeRawUnsafe("UPDATE AgentExecution SET status = 'cancelled' WHERE id = 2");
  await settleStoppedSessions(db as unknown as PostgresClient, [1]);
  expect(await db.agentSession.findUnique({ where: { id: 1 }, select: { status: true } })).toEqual({
    status: 'cancelled',
  });
});

test('stop settlement records task state and stop history atomically', async () => {
  await cancelledExecution();
  expect(await settleStoppedTasks(db as unknown as PostgresClient, [1])).toEqual([1]);
  expect(await settleStoppedTasks(db as unknown as PostgresClient, [1])).toEqual([]);
  const task = await db.task.findUnique({
    where: { id: 1 },
    select: { status: true, workflowStatus: true },
  });
  expect(task).toEqual({ status: 'todo', workflowStatus: 'plan_approved' });
  expect(await db.workflowTransition.count()).toBe(1);
});

test('stop settlement preserves a newer execution', async () => {
  await cancelledExecution();
  await db.$executeRawUnsafe("INSERT INTO AgentExecution VALUES (2,1,'running',?)", now);
  expect(await settleStoppedTasks(db as unknown as PostgresClient, [1])).toEqual([]);
  expect(await db.workflowTransition.count()).toBe(0);
});

test('stop settlement never reopens completed or held tasks', async () => {
  await cancelledExecution();
  for (const [status, workflowStatus] of [
    ['done', 'completed'],
    ['blocked', 'plan_approved'],
    ['in-progress', 'completed'],
  ]) {
    await db.$executeRawUnsafe(
      'UPDATE Task SET status = ?, workflowStatus = ?',
      status,
      workflowStatus,
    );
    expect(await settleStoppedTasks(db as unknown as PostgresClient, [1])).toEqual([]);
    expect(
      await db.task.findUnique({
        where: { id: 1 },
        select: { status: true, workflowStatus: true },
      }),
    ).toEqual({ status, workflowStatus });
  }
  expect(await db.workflowTransition.count()).toBe(0);
});

test('stop settlement audit failure rolls back the task status', async () => {
  await cancelledExecution();
  await db.$executeRawUnsafe(
    "CREATE TRIGGER reject_stop_audit BEFORE INSERT ON WorkflowTransition BEGIN SELECT RAISE(ABORT, 'audit failure'); END",
  );
  await expect(settleStoppedTasks(db as unknown as PostgresClient, [1])).rejects.toThrow();
  expect(await db.task.findUnique({ where: { id: 1 }, select: { status: true } })).toEqual({
    status: 'in-progress',
  });
});

test('durable stop request recovers exact targets after they are no longer active', async () => {
  await cancelledExecution();
  const client = db as unknown as PostgresClient;
  const requestId = await recordThemeStopIntent(client, 10, [1, 1]);
  expect(await readPendingThemeStopTargets(client, 10)).toEqual([1]);
  expect(await readPendingThemeStopTargets(client, 1)).toEqual([]);
  expect(await readThemeStopIntent(client, requestId)).toEqual([1]);
  expect(await settleStoppedTasks(client, await readThemeStopIntent(client, requestId))).toEqual([
    1,
  ]);
  expect(await readThemeStopIntent(client, '00000000-0000-0000-0000-000000000000')).toEqual([]);
});

test('missing stop target rolls back all intent records', async () => {
  await cancelledExecution();
  await expect(
    recordThemeStopIntent(db as unknown as PostgresClient, 10, [1, 999]),
  ).rejects.toThrow('Stop target execution missing');
  expect(await db.workflowTransition.count()).toBe(0);
});

test('a later stop attempt recovers durable targets after settlement failed', async () => {
  await cancelledExecution();
  const client = db as unknown as PostgresClient;
  await recordThemeStopIntent(client, 10, [1]);
  await db.$executeRawUnsafe(
    "CREATE TRIGGER fail_settlement BEFORE INSERT ON WorkflowTransition WHEN NEW.cause = 'auto_run_stop_revert' BEGIN SELECT RAISE(ABORT, 'settlement unavailable'); END",
  );
  await expect(settleStoppedTasks(client, [1])).rejects.toThrow();
  await db.$executeRawUnsafe('DROP TRIGGER fail_settlement');
  // No request id or in-memory execution list is used by the recovery attempt.
  const pending = await readPendingThemeStopTargets(client, 10);
  expect(pending).toEqual([1]);
  expect(await settleStoppedTasks(client, pending)).toEqual([1]);
  expect(await readPendingThemeStopTargets(client, 10)).toEqual([]);
});

test.each([null, 'running', 'failed', 'completed'])(
  'failed session recovery preserves newer %s execution',
  async (newer) => {
    await cancelledExecution();
    await db.$executeRawUnsafe("ALTER TABLE AgentSession ADD COLUMN status TEXT DEFAULT 'failed'");
    await db.$executeRawUnsafe('ALTER TABLE AgentSession ADD COLUMN updatedAt DATETIME');
    if (newer)
      await db.$executeRawUnsafe('INSERT INTO AgentExecution VALUES (2,1,?,?)', newer, now);
    await settleStoppedSessions(db as unknown as PostgresClient, [1]);
    const session = await db.agentSession.findUnique({
      where: { id: 1 },
      select: { status: true },
    });
    expect(session?.status).toBe(newer ? 'failed' : 'cancelled');
  },
);

test('manual execution pending session settles only after its execution is cancelled', async () => {
  await cancelledExecution();
  await db.$executeRawUnsafe("ALTER TABLE AgentSession ADD COLUMN status TEXT DEFAULT 'pending'");
  await db.$executeRawUnsafe('ALTER TABLE AgentSession ADD COLUMN updatedAt DATETIME');
  await db.$executeRawUnsafe("UPDATE AgentExecution SET status = 'running' WHERE id = 1");
  await settleStoppedSessions(db as unknown as PostgresClient, [1]);
  expect(await db.agentSession.findUnique({ where: { id: 1 }, select: { status: true } })).toEqual({
    status: 'pending',
  });
  await db.$executeRawUnsafe("UPDATE AgentExecution SET status = 'cancelled' WHERE id = 1");
  await settleStoppedSessions(db as unknown as PostgresClient, [1]);
  expect(await db.agentSession.findUnique({ where: { id: 1 }, select: { status: true } })).toEqual({
    status: 'cancelled',
  });
});

test('stop intent batch remains atomic when a later audit row fails', async () => {
  await cancelledExecution();
  await db.$executeRawUnsafe("INSERT INTO AgentExecution VALUES (2,1,'running',?)", now);
  await db.$executeRawUnsafe(
    "CREATE TRIGGER reject_second_intent BEFORE INSERT ON WorkflowTransition WHEN NEW.executionId = 2 BEGIN SELECT RAISE(ABORT, 'second audit rejected'); END",
  );
  await expect(recordThemeStopIntent(db as unknown as PostgresClient, 1, [1, 2])).rejects.toThrow();
  expect(await db.workflowTransition.count()).toBe(0);
});
