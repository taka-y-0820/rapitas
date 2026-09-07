import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type Row = { id: number; status: string; evidenceJson: string | null; [key: string]: unknown };
let rows: Row[];
let failCreate = false;
let loseClaim = false;
const evolution = {
  findUnique: async ({ where }: { where: { id: number } }) => rows.find((r) => r.id === where.id),
  updateMany: async ({ where, data }: { where: Row; data: Partial<Row> }) => {
    if (loseClaim) return { count: 0 };
    const row = rows.find(
      (r) =>
        r.id === where.id && r.status === where.status && r.evidenceJson === where.evidenceJson,
    );
    if (row) Object.assign(row, data);
    return { count: row ? 1 : 0 };
  },
  create: async ({ data }: { data: Omit<Row, 'id'> }) => {
    if (failCreate) throw new Error('insert failed');
    const row = { ...data, id: rows.length + 1 } as Row;
    rows.push(row);
    return row;
  },
  update: async ({ where, data }: { where: { id: number }; data: Partial<Row> }) => {
    Object.assign(rows.find((r) => r.id === where.id)!, data);
  },
};
mock.module('../../config/database', () => ({
  prisma: {
    $transaction: async (
      action: (tx: { promptEvolution: typeof evolution }) => Promise<unknown>,
    ) => {
      const before = structuredClone(rows);
      try {
        return await action({ promptEvolution: evolution });
      } catch (error) {
        rows = before;
        throw error;
      }
    },
  },
}));

const { restartUnusableTrial, staleTrialIssue, TRIAL_EVIDENCE_GRACE_MS } =
  await import('./prompt-evolution-trial-retry');
const { reserveTrialSlot, readTrialManifest } =
  await import('./comparison/prompt-comparison-trial-manifest');
let dir: string;
let oldDir: string | undefined;
const now = new Date('2026-09-08T00:00:00Z');
beforeEach(() => {
  oldDir = process.env.RAPITAS_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'trial-retry-'));
  process.env.RAPITAS_DATA_DIR = dir;
  failCreate = loseClaim = false;
  rows = [
    {
      id: 1,
      status: 'staged',
      afterPrompt: 'candidate instruction',
      beforePrompt: 'baseline',
      basePromptKey: 'workflow_role_implementer',
      category: 'workflow',
      experimentId: 5,
      reason: 'measured failure pattern',
      improvement: 'test coverage',
      evidenceJson: JSON.stringify({
        alphaBudgetK: 9,
        trialRandomSeed: 'old',
        comparisonSampleSize: 10,
      }),
    },
  ];
});
afterEach(() => {
  if (oldDir === undefined) delete process.env.RAPITAS_DATA_DIR;
  else process.env.RAPITAS_DATA_DIR = oldDir;
  rmSync(dir, { recursive: true, force: true });
});

test('successor preserves candidate identity but never inherits observations, budget, or random seed', async () => {
  const evidence = rows[0].evidenceJson;
  expect(await restartUnusableTrial(1, evidence, 'session_not_bound', now)).toEqual({
    retired: true,
    replacementId: 2,
  });
  expect(rows[0].status).toBe('rejected');
  expect(JSON.parse(rows[0].evidenceJson!)).toMatchObject({ alphaBudgetK: 9, replacementId: 2 });
  expect(rows[1]).toMatchObject({
    status: 'proposed',
    afterPrompt: 'candidate instruction',
    experimentId: 5,
  });
  expect(JSON.parse(rows[1].evidenceJson!)).toEqual({
    retryOfId: 1,
    rootCandidateId: 1,
    prospectiveRetryCount: 1,
    retryReason: 'session_not_bound',
  });
  expect(await restartUnusableTrial(1, evidence, 'session_not_bound', now)).toEqual({
    retired: false,
    replacementId: null,
  });
  expect(rows).toHaveLength(2);
});

test('failed successor insertion rolls back retirement', async () => {
  const before = structuredClone(rows);
  failCreate = true;
  await expect(
    restartUnusableTrial(1, rows[0].evidenceJson, 'execution_missing', now),
  ).rejects.toThrow('insert failed');
  expect(rows).toEqual(before);
});

test.each(['changed evidence', 'lost claim', 'already approved'])(
  'does not create a successor after %s',
  async (reason) => {
    const expected = rows[0].evidenceJson;
    if (reason === 'changed evidence') rows[0].evidenceJson = '{}';
    if (reason === 'lost claim') loseClaim = true;
    if (reason === 'already approved') rows[0].status = 'approved';
    expect(await restartUnusableTrial(1, expected, 'execution_missing', now)).toEqual({
      retired: false,
      replacementId: null,
    });
    expect(rows).toHaveLength(1);
  },
);

test.each([3, 4, -1, 'unknown'])('bounds automatic retry chains for count %s', async (count) => {
  rows[0].evidenceJson = JSON.stringify({ prospectiveRetryCount: count });
  expect(await restartUnusableTrial(1, rows[0].evidenceJson, 'execution_missing', now)).toEqual({
    retired: true,
    replacementId: null,
  });
  expect(JSON.parse(rows[0].evidenceJson!)).toMatchObject({ retryLimitReached: true });
});

test.each(['{', '[]', 'null'])('preserves malformed historical evidence %s', async (raw) => {
  rows[0].evidenceJson = raw;
  expect(await restartUnusableTrial(1, raw, 'execution_missing', now)).toEqual({
    retired: false,
    replacementId: null,
  });
  expect(rows[0].evidenceJson).toBe(raw);
  expect(rows[0].status).toBe('staged');
});

test('only confirmed old unusable slots expire; live sessions and read failures remain pending', () => {
  const candidate = {
    id: 1,
    evidenceJson: null,
    createdAt: new Date(now.getTime() - 2 * TRIAL_EVIDENCE_GRACE_MS),
  };
  const recovery = {
    recovered: 0,
    pending: 1,
    issues: [] as { assignmentId: string; reason: string }[],
  };
  expect(staleTrialIssue(candidate, recovery, now)).toBeNull(); // absent manifest
  reserveTrialSlot(
    {
      promptEvolutionId: 1,
      role: 'implementer',
      candidateVersion: 'v1',
      controlVersion: null,
      seed: 'seed',
    },
    10,
    () => true,
  );
  const path = join(dir, '.prompt-comparisons', '1.trial.json');
  const manifest = readTrialManifest(1)!;
  manifest.slots[0].createdAt = candidate.createdAt.toISOString();
  writeFileSync(path, JSON.stringify(manifest));
  const original = readFileSync(path, 'utf8');
  for (const reason of ['session_read_failed', 'outcome_write_failed']) {
    recovery.issues = [{ assignmentId: manifest.slots[0].id, reason }];
    expect(staleTrialIssue(candidate, recovery, now)).toBeNull();
  }
  recovery.issues = [];
  expect(staleTrialIssue(candidate, recovery, now)).toBeNull(); // known live session
  recovery.issues = [{ assignmentId: manifest.slots[0].id, reason: 'session_not_bound' }];
  expect(staleTrialIssue(candidate, recovery, now)).toBe('session_not_bound');
  expect(
    staleTrialIssue(
      { ...candidate, evidenceJson: JSON.stringify({ stagedAt: now.toISOString() }) },
      recovery,
      now,
    ),
  ).toBeNull();
  expect(readFileSync(path, 'utf8')).toBe(original);
  writeFileSync(path, '{');
  expect(staleTrialIssue(candidate, recovery, now)).toBeNull(); // corrupt manifest
});
