import { parseReplanVerdict } from './requirement-replan-verdict';
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

async function emptyDiffReceipt() {
  await prepareCompletion();
  const client = db as unknown as PostgresClient;
  const reviewed = await attemptRequirementReplan(client, 1, async () => ({
    ...review,
    verdict: { kind: 'no_mismatch', reason: 'requirements match' },
  }));
  return advanceReviewedVerify(client, reviewed.completionReceipt!);
}

test('configured no-plan workflow receives a guarded completion receipt', async () => {
  await prepareCompletion();
  await db.$executeRawUnsafe("UPDATE Task SET workflowMode = 'standard'");
  await db.$executeRawUnsafe(
    "INSERT INTO WorkflowModeConfig VALUES (1,'standard',?)",
    '{"phases":{"includePlan":false}}',
  );
  await db.workflowFile.deleteMany({ where: { fileType: 'plan' } });
  const client = db as unknown as PostgresClient;
  const result = await attemptRequirementReplan(client, 1, async (source) => {
    expect(source.plan).toBe('');
    expect(source.planPolicy).toEqual({ mode: 'standard', includePlan: false });
    return {
      ...review,
      snapshotDigest: replanSnapshotDigest(source),
      verdict: { kind: 'no_mismatch', reason: 'planning intentionally omitted' },
    };
  });
  expect(result.reason).toBe('no_mismatch');
  expect(result.completionReceipt).toBeDefined();
  const receipt = await advanceReviewedVerify(client, result.completionReceipt!);
  await assertReviewedTaskCurrent(client, receipt);
  expect(await db.task.findUnique({ where: { id: 1 }, select: { status: true } })).toEqual({
    status: 'in-progress',
  });
});

test('required missing plan never reaches the independent reviewer', async () => {
  await db.workflowFile.deleteMany({ where: { fileType: 'plan' } });
  let calls = 0;
  const result = await attemptRequirementReplan(db as unknown as PostgresClient, 1, async () => {
    calls++;
    return review;
  });
  expect(result.reason).toBe('not_reviewable');
  expect(calls).toBe(0);
});

test('mode setting changed after review invalidates the completion receipt', async () => {
  const receipt = await emptyDiffReceipt();
  await db.$executeRawUnsafe(
    "INSERT INTO WorkflowModeConfig VALUES (1,'comprehensive',?)",
    '{"includePlan":false}',
  );
  await expect(assertReviewedTaskCurrent(db as unknown as PostgresClient, receipt)).rejects.toThrow(
    'stale_snapshot',
  );
  expect(await db.workflowTransition.count({ where: { cause: 'verify_passed' } })).toBe(0);
});

test('description evidence survives transactional replan without rewriting requirements', async () => {
  const description = 'Delayed questions must preserve completed status.';
  await db.$executeRawUnsafe(
    'UPDATE Task SET description = ?, acceptanceCriteria = ?',
    description,
    '[]',
  );
  const result = await attemptRequirementReplan(
    db as unknown as PostgresClient,
    1,
    async (source) => ({
      ...review,
      snapshotDigest: replanSnapshotDigest(source),
      verdict: parseReplanVerdict(
        JSON.stringify({
          kind: 'mismatch',
          reason: 'Original requested state preservation is excluded',
          requirementUnmet: true,
          planPreventsRequirement: true,
          preservesRequirements: true,
          requiresOverridingUserConstraint: false,
          requirementIsRequestedOutcome: true,
          criterionSource: 'description',
          criterionIndex: 0,
          planLines: [0, 0],
          failureLines: [0, 0],
        }),
        source,
      ),
    }),
  );
  expect(result.committed).toBe(true);
  const task = await db.task.findUnique({
    where: { id: 1 },
    select: { description: true, acceptanceCriteria: true, workflowStatus: true },
  });
  expect(task).toEqual({ description, acceptanceCriteria: '[]', workflowStatus: 'research_done' });
  const audit = await db.workflowTransition.findFirst({
    where: { cause: 'requirement_evidence_replan' },
    select: { metadata: true },
  });
  expect(JSON.parse(audit!.metadata).evidence.criterionSource).toBe('description');
});
