import { reviewedReplanTransition } from './requirement-replan-dispatch';
import { blockReviewedEmptyDiff } from './reviewed-empty-diff';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PrismaClient } from '../../generated/prisma-sqlite';
import type { PrismaClient as PostgresClient } from '../../generated/prisma-postgres';
import {
  commitRequirementReplan,
  completeReviewedTask,
  advanceReviewedVerify,
  assertReviewedTaskCurrent,
} from './requirement-replan-commit';
import { replanSnapshotDigest } from './requirement-replan-evidence';
import type { ReplanReviewResult } from './requirement-replan-review';
import { buildRequirementReplanContext } from './requirement-replan-context';
import { requirementReplannedSince } from './requirement-replan-guard';
import { attemptRequirementReplan } from './requirement-replan-service';
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
const digest = replanSnapshotDigest(snapshot);
const review: ReplanReviewResult = {
  snapshotDigest: digest,
  durationMs: 10,
  tokensUsed: 20,
  modelName: null,
  verdict: {
    kind: 'mismatch',
    reason: '条件と非対象指定の矛盾',
    evidence: {
      snapshotDigest: digest,
      criterionIndex: 0,
      criterion: snapshot.acceptanceCriteria[0],
      planQuote: snapshot.plan,
      failureQuote: snapshot.verify,
    },
  },
};
const commit = () => commitRequirementReplan(db as unknown as PostgresClient, 1, now, review);

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
    'CREATE TABLE RequirementReviewClaim (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId INTEGER, snapshotDigest TEXT, requestKey TEXT, status TEXT, claimToken TEXT, ownerInstanceId TEXT, heartbeatAt DATETIME, resultJson TEXT, reason TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME, UNIQUE(taskId,snapshotDigest))',
    'CREATE TABLE RequirementReviewRetryRequest (id INTEGER PRIMARY KEY AUTOINCREMENT, requestId TEXT UNIQUE, taskId INTEGER, consumedAt DATETIME, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)',
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
  await db.$executeRawUnsafe('ALTER TABLE Task ADD COLUMN workflowMode TEXT');
  await db.$executeRawUnsafe(
    'CREATE TABLE WorkflowModeConfig (id INTEGER PRIMARY KEY, mode TEXT UNIQUE, stepDefinitions TEXT)',
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

test('commits state and audit while preserving criteria and both artifacts', async () => {
  expect((await commit()).committed).toBe(true);
  const rows = await db.$queryRawUnsafe<
    Array<{ workflowStatus: string; acceptanceCriteria: string }>
  >('SELECT workflowStatus, acceptanceCriteria FROM Task');
  expect(rows[0].workflowStatus).toBe('research_done');
  expect(JSON.parse(rows[0].acceptanceCriteria)).toEqual(snapshot.acceptanceCriteria);
  expect(await db.workflowTransition.count()).toBe(1);
  expect(await db.workflowFile.count()).toBe(2);
});

test('persists the exact replan generation for guarded continuation', async () => {
  expect((await commit()).committed).toBe(true);
  const task = await db.task.findUniqueOrThrow({
    where: { id: 1 },
    select: { updatedAt: true, workflowStatus: true },
  });
  const audit = await db.workflowTransition.findFirstOrThrow({ select: { metadata: true } });
  expect(JSON.parse(audit.metadata).resumeReceipt).toEqual({
    updatedAt: task.updatedAt.toISOString(),
    workflowStatus: 'research_done',
    executionId: null,
  });
  expect(task.updatedAt.getTime()).toBeGreaterThan(now.getTime());
});

test('audit insert failure rolls back the task update in real SQLite', async () => {
  await db.$executeRawUnsafe(
    "CREATE TRIGGER reject_audit BEFORE INSERT ON WorkflowTransition BEGIN SELECT RAISE(ABORT, 'test audit failure'); END",
  );
  await expect(commit()).rejects.toThrow();
  const rows = await db.$queryRawUnsafe<Array<{ workflowStatus: string }>>(
    'SELECT workflowStatus FROM Task',
  );
  expect(rows[0].workflowStatus).toBe('plan_approved');
  expect(await db.workflowTransition.count()).toBe(0);
});

test('two concurrent requests consume at most one attempt', async () => {
  const results = await Promise.all([commit(), commit()]);
  expect(results.filter((r) => r.committed)).toHaveLength(1);
  expect(await db.workflowTransition.count()).toBe(1);
});

test('completed task cannot be reopened by an earlier review', async () => {
  await db.$executeRawUnsafe("UPDATE Task SET status = 'done', workflowStatus = 'completed'");
  expect(await commit()).toEqual({ committed: false, reason: 'protected_task_status' });
  expect(await db.workflowTransition.count()).toBe(0);
});

test('cancelled execution blocks replan even when task status remains in progress', async () => {
  await db.$executeRawUnsafe('INSERT INTO DeveloperModeConfig VALUES (1,1)');
  await db.$executeRawUnsafe('INSERT INTO AgentSession VALUES (1,1)');
  await db.$executeRawUnsafe("INSERT INTO AgentExecution VALUES (1,1,'cancelled',?)", now);
  expect(await commit()).toEqual({ committed: false, reason: 'execution_stopped' });
  expect(await db.workflowTransition.count()).toBe(0);
});

test('artifact change invalidates evidence even without task timestamp change', async () => {
  await db.$executeRawUnsafe(
    "UPDATE WorkflowFile SET content = 'replacement plan' WHERE fileType = 'plan'",
  );
  expect((await commit()).committed).toBe(false);
  expect(await db.workflowTransition.count()).toBe(0);
});

test('three persisted attempts prevent another replan', async () => {
  for (let i = 0; i < 3; i++) {
    await db.$executeRawUnsafe(
      "INSERT INTO WorkflowTransition (taskId,fromStatus,toStatus,actor,cause) VALUES (1,'plan_approved','research_done','system','requirement_evidence_replan')",
    );
  }
  expect(await commit()).toEqual({ committed: false, reason: 'budget_exhausted' });
  expect(await db.workflowTransition.count()).toBe(3);
});

test('committed evidence reaches the replacement planner without truncating requirements', async () => {
  await commit();
  const context = await buildRequirementReplanContext(db as unknown as PostgresClient, 1, 'ja');
  expect(context).toContain(snapshot.acceptanceCriteria[0]);
  expect(context).toContain(snapshot.plan);
  expect(context).toContain(snapshot.verify);
  expect(context).toContain(digest);
  await db.$executeRawUnsafe("UPDATE Task SET workflowStatus = 'plan_approved'");
  expect(await buildRequirementReplanContext(db as unknown as PostgresClient, 1, 'ja')).toBe('');
});

test('damaged committed evidence fails planning closed', async () => {
  await commit();
  await db.$executeRawUnsafe("UPDATE WorkflowTransition SET metadata = '{}'");
  await expect(
    buildRequirementReplanContext(db as unknown as PostgresClient, 1, 'en'),
  ).rejects.toThrow('Invalid requirement replan audit');
});

test('replan invalidates older phase output but not a later replacement phase', async () => {
  const client = db as unknown as PostgresClient;
  expect(await requirementReplannedSince(client, 1, now)).toBe(false);
  await commit();
  expect(await requirementReplannedSince(client, 1, now)).toBe(true);
  expect(await requirementReplannedSince(client, 2, now)).toBe(false);
  expect(await requirementReplannedSince(client, 1, new Date(Date.now() + 60000))).toBe(false);
});

test('server entry point reviews the stored source and commits the verdict', async () => {
  const result = await attemptRequirementReplan(
    db as unknown as PostgresClient,
    1,
    async (source) => {
      expect(source).toEqual({
        ...snapshot,
        planPolicy: { mode: 'comprehensive', includePlan: true },
      });
      return review;
    },
  );
  expect(result.committed).toBe(true);
});

test('unknown review keeps task and artifacts unchanged and issues no completion receipt', async () => {
  const artifacts = await db.$queryRawUnsafe('SELECT * FROM WorkflowFile ORDER BY id');
  const result = await attemptRequirementReplan(db as unknown as PostgresClient, 1, async () => ({
    ...review,
    verdict: { kind: 'unknown', reason: 'UI and cost comparison evidence is missing' },
  }));
  expect(result).toEqual({
    committed: false,
    reason: 'requires_human:UI and cost comparison evidence is missing',
  });
  expect(await db.task.findUnique({ where: { id: 1 }, select: { status: true } })).toEqual({
    status: 'blocked',
  });
  expect(await db.$queryRawUnsafe('SELECT * FROM WorkflowFile ORDER BY id')).toEqual(artifacts);
  expect(await db.$queryRawUnsafe('SELECT * FROM WorkflowTransition')).toEqual([]);
});

test('a concurrent healthy evaluation is not mistaken for a crash and does not stop the task', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = attemptRequirementReplan(db as unknown as PostgresClient, 1, async () => {
    entered();
    await gate;
    return { ...review, verdict: { kind: 'no_mismatch' as const, reason: 'matches' } };
  });
  await started;
  const duplicate = await attemptRequirementReplan(db as unknown as PostgresClient, 1);
  expect(duplicate).toEqual({ committed: false, reason: 'review_in_progress' });
  expect(await db.task.findUnique({ where: { id: 1 }, select: { status: true } })).toEqual({
    status: 'in-progress',
  });
  release();
  await first;
});

test('requirement edited during independent review is never replaced by an old verdict', async () => {
  const result = await attemptRequirementReplan(db as unknown as PostgresClient, 1, async () => {
    await db.$executeRawUnsafe('UPDATE Task SET acceptanceCriteria = \'["new requirement"]\'');
    return review;
  });
  expect(result).toEqual({ committed: false, reason: 'stale_snapshot' });
  expect(await db.workflowTransition.count()).toBe(0);
});

test('stop during independent review prevents the replan commit', async () => {
  const result = await attemptRequirementReplan(db as unknown as PostgresClient, 1, async () => {
    await db.$executeRawUnsafe("UPDATE Task SET status = 'todo'");
    return review;
  });
  expect(result).toEqual({ committed: false, reason: 'protected_task_status' });
  expect(await db.workflowTransition.count()).toBe(0);
});

test('unrelated user history after stop does not authorize replan', async () => {
  await db.$executeRawUnsafe(
    "INSERT INTO WorkflowTransition (taskId,actor,cause,createdAt) VALUES (1,'user','auto_run_stop_revert',?)",
    now,
  );
  await db.$executeRawUnsafe(
    "INSERT INTO WorkflowTransition (taskId,actor,cause,createdAt) VALUES (1,'user','task_description_updated',?)",
    new Date(now.getTime() + 1000),
  );
  expect(await commit()).toEqual({ committed: false, reason: 'stop_not_resumed' });
  expect(await db.workflowTransition.count()).toBe(2);
});

test('no-mismatch verdict cannot refer to requirements changed during review', async () => {
  const result = await attemptRequirementReplan(db as unknown as PostgresClient, 1, async () => {
    await db.$executeRawUnsafe('UPDATE Task SET acceptanceCriteria = \'["new criterion"]\'');
    return { ...review, verdict: { kind: 'no_mismatch', reason: 'old snapshot only' } };
  });
  expect(result).toEqual({ committed: false, reason: 'stale_snapshot' });
});

test('no-mismatch review cannot pass a cancellation that leaves the task timestamp unchanged', async () => {
  await db.$executeRawUnsafe('INSERT INTO DeveloperModeConfig VALUES (1,1)');
  await db.$executeRawUnsafe('INSERT INTO AgentSession VALUES (1,1)');
  await db.$executeRawUnsafe("INSERT INTO AgentExecution VALUES (1,1,'running',?)", now);
  const result = await attemptRequirementReplan(db as unknown as PostgresClient, 1, async () => {
    await db.$executeRawUnsafe("UPDATE AgentExecution SET status = 'cancelled' WHERE id = 1");
    return { ...review, verdict: { kind: 'no_mismatch', reason: 'requirements match' } };
  });
  expect(result).toEqual({ committed: false, reason: 'execution_stopped' });
  expect(await db.workflowTransition.count()).toBe(0);
});

test('a matching review after three replans does not require a fourth attempt', async () => {
  for (let i = 0; i < 3; i++) {
    await db.$executeRawUnsafe(
      "INSERT INTO WorkflowTransition (taskId,fromStatus,toStatus,actor,cause) VALUES (1,'plan_approved','research_done','system','requirement_evidence_replan')",
    );
  }
  const result = await attemptRequirementReplan(db as unknown as PostgresClient, 1, async () => ({
    ...review,
    verdict: { kind: 'no_mismatch', reason: 'requirements match' },
  }));
  expect(result).toMatchObject({ committed: false, reason: 'no_mismatch' });
  expect(result.completionReceipt?.review.snapshotDigest).toBe(digest);
  expect(await db.workflowTransition.count()).toBe(3);
});

test('durable stop intent blocks review admission before process cancellation finishes', async () => {
  await db.$executeRawUnsafe('INSERT INTO DeveloperModeConfig VALUES (1,1)');
  await db.$executeRawUnsafe('INSERT INTO AgentSession VALUES (1,1)');
  await db.$executeRawUnsafe("INSERT INTO AgentExecution VALUES (1,1,'running',?)", now);
  await db.$executeRawUnsafe(
    "INSERT INTO WorkflowTransition (taskId,actor,cause,createdAt) VALUES (1,'system','theme_stop_execution_requested',?)",
    new Date(now.getTime() + 1000),
  );
  expect(await commit()).toEqual({ committed: false, reason: 'stop_not_resumed' });
  const result = await attemptRequirementReplan(db as unknown as PostgresClient, 1, async () => ({
    ...review,
    verdict: { kind: 'no_mismatch', reason: 'requirements match' },
  }));
  expect(result).toEqual({ committed: false, reason: 'stop_not_resumed' });
  expect(await db.workflowTransition.count()).toBe(1);
});

async function prepareCompletion() {
  await db.$executeRawUnsafe('ALTER TABLE Task ADD COLUMN parentId INTEGER');
  await db.$executeRawUnsafe('ALTER TABLE Task ADD COLUMN completedAt DATETIME');
  return () =>
    completeReviewedTask(
      db as unknown as PostgresClient,
      {
        taskId: 1,
        executionId: null,
        evaluatedUpdatedAt: now,
        review: { ...review, verdict: { kind: 'no_mismatch', reason: 'matching requirements' } },
      },
      { cause: 'verify_passed' },
    );
}

test('completion commits state and audit once for concurrent callers', async () => {
  const complete = await prepareCompletion();
  const results = await Promise.all([complete(), complete()]);
  expect(results.filter((r) => r.committed)).toHaveLength(1);
  expect(
    await db.task.findUnique({ where: { id: 1 }, select: { status: true, workflowStatus: true } }),
  ).toEqual({ status: 'done', workflowStatus: 'completed' });
  expect(await db.workflowTransition.count({ where: { cause: 'verify_passed' } })).toBe(1);
});

test('completion audit failure rolls back the completed state', async () => {
  const complete = await prepareCompletion();
  await db.$executeRawUnsafe(
    "CREATE TRIGGER reject_completion BEFORE INSERT ON WorkflowTransition BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
  );
  await expect(complete()).rejects.toThrow();
  expect(await db.task.findUnique({ where: { id: 1 }, select: { status: true } })).toEqual({
    status: 'in-progress',
  });
});

test('replan committed after review prevents old completion', async () => {
  const complete = await prepareCompletion();
  expect((await commit()).committed).toBe(true);
  expect((await complete()).committed).toBe(false);
  expect(await db.workflowTransition.count({ where: { cause: 'verify_passed' } })).toBe(0);
});

test('stop intent arriving after review prevents completion without a task timestamp change', async () => {
  const complete = await prepareCompletion();
  await db.$executeRawUnsafe(
    "INSERT INTO WorkflowTransition (taskId,actor,cause,createdAt) VALUES (1,'system','theme_stop_execution_requested',?)",
    now,
  );
  expect(await complete()).toEqual({ committed: false, reason: 'stop_not_resumed' });
});

test('new open subtask prevents parent completion', async () => {
  const complete = await prepareCompletion();
  await db.$executeRawUnsafe("INSERT INTO Task (id,parentId,status) VALUES (2,1,'todo')");
  expect(await complete()).toEqual({ committed: false, reason: 'open_subtasks' });
});

test('a new execution after review invalidates the completion receipt', async () => {
  const complete = await prepareCompletion();
  await db.$executeRawUnsafe('INSERT INTO DeveloperModeConfig VALUES (1,1)');
  await db.$executeRawUnsafe('INSERT INTO AgentSession VALUES (1,1)');
  await db.$executeRawUnsafe("INSERT INTO AgentExecution VALUES (1,1,'running',?)", now);
  expect(await complete()).toEqual({ committed: false, reason: 'execution_superseded' });
});

test('own verify transition renews the receipt and permits later atomic completion', async () => {
  await prepareCompletion();
  const client = db as unknown as PostgresClient;
  const reviewed = await attemptRequirementReplan(client, 1, async () => ({
    ...review,
    verdict: { kind: 'no_mismatch', reason: 'requirements match' },
  }));
  const renewed = await advanceReviewedVerify(client, reviewed.completionReceipt!);
  expect(renewed.evaluatedUpdatedAt.getTime()).toBeGreaterThan(now.getTime());
  expect(
    await db.task.findUnique({ where: { id: 1 }, select: { status: true, workflowStatus: true } }),
  ).toEqual({ status: 'in-progress', workflowStatus: 'verify_done' });
  expect((await completeReviewedTask(client, renewed, { cause: 'verify_passed' })).committed).toBe(
    true,
  );
  expect(await db.workflowTransition.count()).toBe(2);
});

test('a concurrent edit cannot be blessed by renewing a verify receipt', async () => {
  await prepareCompletion();
  const client = db as unknown as PostgresClient;
  const reviewed = await attemptRequirementReplan(client, 1, async () => ({
    ...review,
    verdict: { kind: 'no_mismatch', reason: 'requirements match' },
  }));
  await db.$executeRawUnsafe("UPDATE Task SET description = 'new instructions'");
  await expect(advanceReviewedVerify(client, reviewed.completionReceipt!)).rejects.toThrow(
    'stale_snapshot',
  );
  expect(await db.workflowTransition.count()).toBe(0);
});

async function emptyDiffReceipt() {
  await prepareCompletion();
  const client = db as unknown as PostgresClient;
  const reviewed = await attemptRequirementReplan(client, 1, async () => ({
    ...review,
    verdict: { kind: 'no_mismatch', reason: 'requirements match' },
  }));
  return advanceReviewedVerify(client, reviewed.completionReceipt!);
}

test('empty-diff hold rolls back when its audit fails in SQLite', async () => {
  const receipt = await emptyDiffReceipt();
  await db.$executeRawUnsafe(
    "CREATE TRIGGER reject_empty_diff BEFORE INSERT ON WorkflowTransition WHEN NEW.cause = 'verify_no_changes' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
  );
  await expect(
    blockReviewedEmptyDiff(db as unknown as PostgresClient, receipt, 'no_changes'),
  ).rejects.toThrow();
  expect(
    await db.task.findUnique({ where: { id: 1 }, select: { status: true, updatedAt: true } }),
  ).toEqual({
    status: 'in-progress',
    updatedAt: receipt.evaluatedUpdatedAt,
  });
  expect(await db.workflowTransition.count({ where: { cause: 'verify_no_changes' } })).toBe(0);
});

test('empty-diff hold does not overwrite a stopped task in SQLite', async () => {
  const receipt = await emptyDiffReceipt();
  await db.task.updateMany({ where: { id: 1 }, data: { status: 'todo' } });
  await expect(
    blockReviewedEmptyDiff(db as unknown as PostgresClient, receipt, 'no_changes'),
  ).rejects.toThrow('task changed');
  expect(await db.task.findUnique({ where: { id: 1 }, select: { status: true } })).toEqual({
    status: 'todo',
  });
  expect(await db.workflowTransition.count({ where: { cause: 'verify_no_changes' } })).toBe(0);
});

test('concurrent empty-diff holds create only one durable hold', async () => {
  const receipt = await emptyDiffReceipt();
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      blockReviewedEmptyDiff(db as unknown as PostgresClient, receipt, 'no_changes'),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(
    await db.task.findUnique({ where: { id: 1 }, select: { status: true, workflowStatus: true } }),
  ).toEqual({ status: 'blocked', workflowStatus: 'verify_done' });
  expect(await db.workflowTransition.count({ where: { cause: 'verify_no_changes' } })).toBe(1);
});

test('empty-diff audit preserves a readable diagnostic and gate reason', async () => {
  const receipt = await emptyDiffReceipt();
  await blockReviewedEmptyDiff(db as unknown as PostgresClient, receipt, 'no_changes');
  const audit = await db.workflowTransition.findFirst({
    where: { cause: 'verify_no_changes' },
    select: { invariantMessage: true, metadata: true, invariantViolation: true },
  });
  expect(audit?.invariantMessage).toContain('without implementation changes');
  expect(audit?.invariantMessage).not.toContain('???');
  expect(JSON.parse(audit!.metadata)).toEqual({ reason: 'no_changes' });
  expect(audit?.invariantViolation).toBe(true);
});

test('durable stop intent prevents an empty-diff hold before task cancellation settles', async () => {
  const receipt = await emptyDiffReceipt();
  await db.$executeRawUnsafe(
    "INSERT INTO WorkflowTransition (taskId,actor,cause,createdAt) VALUES (1,'system','theme_stop_execution_requested',?)",
    new Date(),
  );
  await expect(
    blockReviewedEmptyDiff(db as unknown as PostgresClient, receipt, 'no_changes'),
  ).rejects.toThrow('stop not resumed');
  expect(
    await db.task.findUnique({ where: { id: 1 }, select: { status: true, updatedAt: true } }),
  ).toEqual({ status: 'in-progress', updatedAt: receipt.evaluatedUpdatedAt });
  expect(await db.workflowTransition.count({ where: { cause: 'verify_no_changes' } })).toBe(0);
});

test('a new execution invalidates the old empty-diff hold', async () => {
  const receipt = await emptyDiffReceipt();
  await db.$executeRawUnsafe('INSERT INTO DeveloperModeConfig VALUES (1,1)');
  await db.$executeRawUnsafe('INSERT INTO AgentSession VALUES (1,1)');
  await db.$executeRawUnsafe("INSERT INTO AgentExecution VALUES (1,1,'running',?)", new Date());
  await expect(
    blockReviewedEmptyDiff(db as unknown as PostgresClient, receipt, 'no_changes'),
  ).rejects.toThrow('execution superseded');
  expect(await db.workflowTransition.count({ where: { cause: 'verify_no_changes' } })).toBe(0);
});

test('preflight admission reads current evidence without advancing or auditing completion', async () => {
  const receipt = await emptyDiffReceipt();
  const before = await db.workflowTransition.count();
  await assertReviewedTaskCurrent(db as unknown as PostgresClient, receipt);
  expect(await db.workflowTransition.count()).toBe(before);
  expect(
    await db.task.findUnique({ where: { id: 1 }, select: { status: true, updatedAt: true } }),
  ).toEqual({ status: 'in-progress', updatedAt: receipt.evaluatedUpdatedAt });
});

test('preflight admission refuses durable stop before external work', async () => {
  const receipt = await emptyDiffReceipt();
  await db.$executeRawUnsafe(
    "INSERT INTO WorkflowTransition (taskId,actor,cause,createdAt) VALUES (1,'system','theme_stop_execution_requested',?)",
    new Date(),
  );
  await expect(assertReviewedTaskCurrent(db as unknown as PostgresClient, receipt)).rejects.toThrow(
    'stop_not_resumed',
  );
});

test('reviewed replan dispatches a planner and preserves the approval gate', async () => {
  expect((await commit()).committed).toBe(true);
  expect(
    await reviewedReplanTransition(db as unknown as PostgresClient, 1, 'research_done'),
  ).toEqual({
    role: 'planner',
    outputFile: 'plan',
    nextStatus: 'plan_created',
  });
  expect(
    await reviewedReplanTransition(db as unknown as PostgresClient, 1, 'plan_created'),
  ).toBeNull();
  expect(
    await reviewedReplanTransition(db as unknown as PostgresClient, 1, 'plan_approved'),
  ).toEqual({
    role: 'implementer',
    outputFile: null,
    nextStatus: 'in_progress',
  });
});
