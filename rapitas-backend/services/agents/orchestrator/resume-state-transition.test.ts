/** Real SQLite transactions, isolated from the application database. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '../../../generated/prisma-sqlite';
import type { OrchestratorContext } from './types';
import { transitionResumedExecution } from './resume-state-transition';
import { ExecutionCancelledError } from '../execution-cancelled-error';

let directory: string;
let client: PrismaClient;
let observer: Database;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'rapitas-resume-state-'));
  const path = join(directory, 'test.db');
  observer = new Database(path);
  // Only columns touched by this transition; use the real generated client
  // and actual database rollback rather than simulating transaction behavior.
  observer.exec(`
    CREATE TABLE AgentExecution (id INTEGER PRIMARY KEY, status TEXT, output TEXT,
      errorMessage TEXT, updatedAt DATETIME);
    CREATE TABLE Task (id INTEGER PRIMARY KEY, status TEXT, workflowStatus TEXT,
      updatedAt DATETIME);
    INSERT INTO AgentExecution VALUES (10, 'interrupted', 'previous', 'interruption', CURRENT_TIMESTAMP);
    INSERT INTO Task VALUES (5, 'todo', 'plan_approved', CURRENT_TIMESTAMP);
  `);
  client = new PrismaClient({ datasources: { db: { url: `file:${path.replaceAll('\\', '/')}` } } });
});
afterEach(async () => {
  await client.$disconnect();
  observer.close();
  rmSync(directory, { recursive: true, force: true });
});
const states = () => ({
  execution: observer.query('SELECT status, output FROM AgentExecution WHERE id=10').get(),
  task: observer.query('SELECT status FROM Task WHERE id=5').get(),
});
const transition = (check = () => {}) =>
  transitionResumedExecution(
    client as unknown as OrchestratorContext['prisma'],
    10,
    5,
    'resumed',
    check,
  );

test('commits task and execution together', async () => {
  await transition();
  expect(states()).toEqual({
    execution: { status: 'running', output: 'resumed' },
    task: { status: 'in-progress' },
  });
});
for (const status of ['canceling', 'cancelled', 'canceled', 'completed']) {
  test(`another connection's ${status} execution is not resurrected`, async () => {
    observer.query('UPDATE AgentExecution SET status=? WHERE id=10').run(status);
    await expect(transition()).rejects.toThrow('no longer interrupted');
    expect(states()).toEqual({
      execution: { status, output: 'previous' },
      task: { status: 'todo' },
    });
  });
}
for (const status of ['blocked', 'done', 'cancelled', 'failed']) {
  test(`${status} task rolls back the execution claim`, async () => {
    observer.query('UPDATE Task SET status=? WHERE id=5').run(status);
    await expect(transition()).rejects.toThrow('no longer eligible');
    expect(states()).toEqual({
      execution: { status: 'interrupted', output: 'previous' },
      task: { status },
    });
  });
}
test('completed workflow is protected even if task status is stale todo', async () => {
  observer.exec("UPDATE Task SET workflowStatus='completed' WHERE id=5");
  await expect(transition()).rejects.toThrow('no longer eligible');
  expect(states().execution).toEqual({ status: 'interrupted', output: 'previous' });
});
for (const stopAt of [2, 3]) {
  test(`lease revoked at transaction check ${stopAt} rolls back both rows`, async () => {
    let checks = 0;
    await expect(
      transition(() => {
        if (++checks === stopAt) throw new ExecutionCancelledError('stopped');
      }),
    ).rejects.toThrow('stopped');
    expect(states()).toEqual({
      execution: { status: 'interrupted', output: 'previous' },
      task: { status: 'todo' },
    });
  });
}
