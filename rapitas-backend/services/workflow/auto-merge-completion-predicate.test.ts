import { afterAll, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaClient, type Prisma } from '../../generated/prisma-sqlite';
import { autoMergeCompletionPredicate } from './auto-merge-completion-predicate';
const directory = mkdtempSync(join(tmpdir(), 'completion-cas-'));
const file = join(directory, 'test.sqlite');
const setup = new Database(file);
setup.exec(`CREATE TABLE Task(id INTEGER PRIMARY KEY,status TEXT,workflowStatus TEXT,completedAt DATETIME,updatedAt DATETIME);
CREATE TABLE DeveloperModeConfig(id INTEGER PRIMARY KEY,taskId INTEGER);
CREATE TABLE AgentSession(id INTEGER PRIMARY KEY,configId INTEGER);
CREATE TABLE AgentExecution(id INTEGER PRIMARY KEY,sessionId INTEGER,status TEXT);
INSERT INTO Task VALUES(1,'in-progress','verify_done',NULL,NULL);
INSERT INTO DeveloperModeConfig VALUES(1,1);
INSERT INTO AgentSession VALUES(1,1);
INSERT INTO AgentExecution VALUES(1,1,'completed');`);
setup.close();
const client = new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
beforeEach(async () => {
  await client.$executeRawUnsafe(
    "UPDATE Task SET status='in-progress',workflowStatus='verify_done',completedAt=NULL",
  );
  await client.$executeRawUnsafe("UPDATE AgentExecution SET status='completed'");
});
afterAll(async () => {
  await client.$disconnect();
  rmSync(directory, { recursive: true, force: true });
});
async function complete() {
  return client.task.updateMany({
    where: autoMergeCompletionPredicate(1) as Prisma.TaskWhereInput,
    data: { status: 'done', workflowStatus: 'completed', completedAt: new Date() },
  });
}
test('real database completes an eligible task', async () => {
  expect((await complete()).count).toBe(1);
});
test('cancellation committed after eligibility read defeats the terminal update', async () => {
  expect(
    (await client.task.findUnique({ where: { id: 1 }, select: { status: true } }))?.status,
  ).toBe('in-progress');
  await client.$executeRawUnsafe("UPDATE AgentExecution SET status='canceling'");
  expect((await complete()).count).toBe(0);
  expect(
    await client.task.findUnique({ where: { id: 1 }, select: { status: true, completedAt: true } }),
  ).toEqual({ status: 'in-progress', completedAt: null });
});
test('task block after the read also defeats completion', async () => {
  await client.$executeRawUnsafe("UPDATE Task SET status='blocked'");
  expect((await complete()).count).toBe(0);
});
