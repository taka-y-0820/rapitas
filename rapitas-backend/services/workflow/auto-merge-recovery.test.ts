import { beforeEach, expect, mock, test } from 'bun:test';
import type { PrismaClient } from '../../generated/prisma-postgres';
let enabled = true;
let integration: number | null = 1;
mock.module('./automation-policy', () => ({
  resolveAutomationPolicy: async () => ({ autoMergePR: enabled }),
}));
mock.module('../github/pr-link', () => ({ resolveIntegrationId: async () => integration }));
const { recoverMergedTasks } = await import('./auto-merge-recovery');
const at = new Date('2026-09-01T00:00:00Z');
const task = { id: 1, githubPrId: 8, updatedAt: at, workingDirectory: '/repo', theme: null };
let rows: Array<{ id: number; status: string; completedAt: Date; createdAt: Date }>;
const update = mock(async (_args: unknown) => ({ count: 1 }));
const read = mock(async (_repo: string, _number: number) => ({
  state: 'MERGED',
  number: 8,
  url: 'https://github.com/owner/repo/pull/8',
  mergedAt: '2026-09-02T00:00:00Z',
}));
const db = {
  task: { findMany: async () => [task], updateMany: update },
  agentExecution: { findMany: async () => rows },
  gitHubPullRequest: {
    findFirst: async () => ({
      linkedTaskId: 1,
      url: 'https://github.com/owner/repo/pull/8',
      integration: { ownerName: 'owner', repositoryName: 'repo' },
    }),
  },
} as unknown as PrismaClient;
beforeEach(() => {
  enabled = true;
  integration = 1;
  rows = [{ id: 10, status: 'completed', completedAt: at, createdAt: at }];
  update.mockReset().mockResolvedValue({ count: 1 });
  read
    .mockReset()
    .mockResolvedValue({
      state: 'MERGED',
      number: 8,
      url: 'https://github.com/owner/repo/pull/8',
      mergedAt: '2026-09-02T00:00:00Z',
    });
});
test('recovers persistence failure without invoking a merge', async () => {
  expect(await recoverMergedTasks(db, read)).toBe(1);
  expect(read).toHaveBeenCalledWith('owner/repo', 8);
  expect(update).toHaveBeenCalledTimes(1);
});
for (const status of ['running', 'pending', 'canceling', 'failed', 'cancelled']) {
  test(`latest ${status} execution is not recovered`, async () => {
    rows[0].status = status;
    expect(await recoverMergedTasks(db, read)).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });
}
test('rerun completed after old merge cannot use that merge as evidence', async () => {
  rows[0].completedAt = new Date('2026-09-03T00:00:00Z');
  expect(await recoverMergedTasks(db, read)).toBe(0);
  expect(update).not.toHaveBeenCalled();
});
test('foreign repository evidence is rejected', async () => {
  read.mockResolvedValue({
    state: 'MERGED',
    number: 8,
    url: 'https://github.com/other/repo/pull/8',
    mergedAt: '2026-09-02T00:00:00Z',
  });
  expect(await recoverMergedTasks(db, read)).toBe(0);
  expect(update).not.toHaveBeenCalled();
});
test('GitHub read failure is deferred', async () => {
  read.mockRejectedValue(new Error('offline'));
  expect(await recoverMergedTasks(db, read)).toBe(0);
  expect(update).not.toHaveBeenCalled();
});
test('lost conditional update is not counted as recovered', async () => {
  update.mockResolvedValue({ count: 0 });
  expect(await recoverMergedTasks(db, read)).toBe(0);
});
test('disabled merge automation and unresolved repository hold', async () => {
  enabled = false;
  expect(await recoverMergedTasks(db, read)).toBe(0);
  enabled = true;
  integration = null;
  expect(await recoverMergedTasks(db, read)).toBe(0);
  expect(update).not.toHaveBeenCalled();
});

test('real SQLite conditional write rejects stop, new run and task revision races', async () => {
  const { Database } = await import('bun:sqlite');
  const { PrismaClient: SQLiteClient } = await import('../../generated/prisma-sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = mkdtempSync(join(tmpdir(), 'merged-recovery-'));
  const file = join(directory, 'test.db');
  const setup = new Database(file);
  setup.exec(`CREATE TABLE Task(id INTEGER PRIMARY KEY,status TEXT,workflowStatus TEXT,githubPrId INTEGER,updatedAt DATETIME,completedAt DATETIME);
    CREATE TABLE DeveloperModeConfig(id INTEGER PRIMARY KEY,taskId INTEGER);
    CREATE TABLE AgentSession(id INTEGER PRIMARY KEY,configId INTEGER);
    CREATE TABLE AgentExecution(id INTEGER PRIMARY KEY,sessionId INTEGER,status TEXT,completedAt DATETIME);
    INSERT INTO Task VALUES(1,'in-progress','verify_done',8,${at.getTime()},NULL);
    INSERT INTO DeveloperModeConfig VALUES(1,1);
    INSERT INTO AgentSession VALUES(1,1);
    INSERT INTO AgentExecution VALUES(10,1,'completed',${at.getTime()});`);
  setup.close();
  const client = new SQLiteClient({ datasources: { db: { url: `file:${file}` } } });
  try {
    for (const mutation of [
      "UPDATE AgentExecution SET status='canceling' WHERE id=10",
      "INSERT INTO AgentExecution VALUES(11,1,'running',NULL)",
      'UPDATE Task SET githubPrId=9',
      `UPDATE Task SET updatedAt=${at.getTime() + 1}`,
      '',
    ]) {
      await client.$executeRawUnsafe('DELETE FROM AgentExecution WHERE id=11');
      await client.$executeRawUnsafe("UPDATE AgentExecution SET status='completed' WHERE id=10");
      await client.$executeRawUnsafe(
        `UPDATE Task SET status='in-progress',workflowStatus='verify_done',githubPrId=8,updatedAt=${at.getTime()},completedAt=NULL`,
      );
      update.mockImplementation(async (args) => {
        if (mutation) await client.$executeRawUnsafe(mutation);
        return client.task.updateMany(args as Parameters<typeof client.task.updateMany>[0]);
      });
      expect(await recoverMergedTasks(db, read)).toBe(mutation ? 0 : 1);
      const persisted = await client.task.findUnique({
        where: { id: 1 },
        select: { status: true },
      });
      expect(persisted?.status).toBe(mutation ? 'in-progress' : 'done');
    }
  } finally {
    await client.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  }
});
