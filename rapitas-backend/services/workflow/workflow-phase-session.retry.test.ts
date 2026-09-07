/** Real relational conditional updates against an isolated SQLite database. */
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaClient } from '../../generated/prisma-sqlite';

const directory = mkdtempSync(join(tmpdir(), 'rapitas-session-retry-'));
const file = join(directory, 'test.sqlite');
const setup = new Database(file);
setup.exec(
  'CREATE TABLE AgentSession (id INTEGER PRIMARY KEY, status TEXT NOT NULL, completedAt DATETIME, lastActivityAt DATETIME, updatedAt DATETIME)',
);
setup.exec(
  'CREATE TABLE AgentExecution (id INTEGER PRIMARY KEY, sessionId INTEGER, status TEXT NOT NULL, createdAt DATETIME NOT NULL)',
);
setup.close();
const client = new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
let duringSnapshot: (() => Promise<void>) | undefined;
mock.module('../../config', () => ({
  prisma: {
    agentSession: client.agentSession,
    agentExecution: {
      findMany: async (args: unknown) => {
        const rows = await client.agentExecution.findMany(
          args as Parameters<typeof client.agentExecution.findMany>[0],
        );
        await duringSnapshot?.();
        return rows;
      },
    },
  },
}));
const warnings: unknown[] = [];
mock.module('../../config/logger', () => ({
  createLogger: () => ({ warn: (value: unknown) => warnings.push(value) }),
}));
afterEach(() => expect(warnings).toEqual([]));
const { finalizePhaseSession } = await import('./workflow-phase-session');
beforeEach(async () => {
  warnings.length = 0;
  duringSnapshot = undefined;
  await client.agentExecution.deleteMany();
  await client.agentSession.deleteMany();
  await client.$executeRawUnsafe('INSERT INTO AgentSession (id, status) VALUES (42, ?)', 'active');
  await client.$executeRawUnsafe('INSERT INTO AgentExecution VALUES (1, 42, ?, 1000)', 'failed');
  await client.$executeRawUnsafe('INSERT INTO AgentExecution VALUES (2, 42, ?, 2000)', 'completed');
});
afterAll(async () => {
  await client.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});
async function state() {
  return (
    await client.agentSession.findMany({
      where: { id: 42 },
      select: { status: true, completedAt: true },
    })
  )[0];
}

test('earlier failure followed by completed retry finalizes with a timestamp', async () => {
  expect(await finalizePhaseSession(42, true)).toBe(true);
  expect(await state()).toMatchObject({ status: 'completed', completedAt: expect.any(Date) });
});

test.each(['running', 'failed', 'cancelled', 'interrupted', 'queued'])(
  'latest %s does not credit an earlier success',
  async (status) => {
    await client.agentExecution.updateMany({ where: { id: 1 }, data: { status: 'completed' } });
    await client.agentExecution.updateMany({ where: { id: 2 }, data: { status } });
    expect(await finalizePhaseSession(42, true)).toBe(false);
    expect(await state()).toMatchObject({ status: 'active', completedAt: null });
  },
);

test.each(['canceling', 'cancelled', 'interrupted'])(
  'session %s during snapshot is never overwritten',
  async (status) => {
    duringSnapshot = async () => {
      await client.agentSession.updateMany({ where: { id: 42 }, data: { status } });
    };
    expect(await finalizePhaseSession(42, true)).toBe(false);
    expect(await state()).toMatchObject({ status, completedAt: null });
  },
);

test.each(['added', 'removed', 'changed'])(
  'execution %s after snapshot invalidates completion',
  async (change) => {
    duringSnapshot = async () => {
      if (change === 'added')
        await client.$executeRawUnsafe(
          'INSERT INTO AgentExecution VALUES (3, 42, ?, 3000)',
          'completed',
        );
      if (change === 'removed') await client.agentExecution.deleteMany({ where: { id: 1 } });
      if (change === 'changed')
        await client.agentExecution.updateMany({ where: { id: 2 }, data: { status: 'cancelled' } });
    };
    expect(await finalizePhaseSession(42, true)).toBe(false);
    expect(await state()).toMatchObject({ status: 'active', completedAt: null });
  },
);

test('artifact failure remains failed even when the final CLI succeeds', async () => {
  expect(await finalizePhaseSession(42, false)).toBe(true);
  expect((await state()).status).toBe('failed');
});

test('an empty session cannot become completed', async () => {
  await client.agentExecution.deleteMany();
  expect(await finalizePhaseSession(42, true)).toBe(false);
});

test.each(['running', 'cancelled', 'interrupted'])(
  'earlier %s cannot be hidden by a successful latest execution',
  async (status) => {
    await client.agentExecution.updateMany({ where: { id: 1 }, data: { status } });
    expect(await finalizePhaseSession(42, true)).toBe(false);
    expect((await state()).status).toBe('active');
  },
);

test('ordinary all-completed sessions retain the single-write path', async () => {
  await client.agentExecution.updateMany({ where: { id: 1 }, data: { status: 'completed' } });
  const read = mock(async () => {});
  duringSnapshot = read;
  expect(await finalizePhaseSession(42, true)).toBe(true);
  expect(read).not.toHaveBeenCalled();
});
