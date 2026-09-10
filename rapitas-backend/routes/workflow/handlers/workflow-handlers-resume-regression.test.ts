/** Task 897 regression: real SQLite, file persistence, transition recording and
 * answer appliers. Scheduling is intercepted so fixtures never launch agents. */
import { afterAll, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PrismaClient } from '../../../generated/prisma-sqlite';
import { SQLITE_INIT_SQL } from '../../../src/generated/sqlite-init-sql';

const dir = mkdtempSync(join(tmpdir(), 'rapitas-question-regression-'));
const dbPath = join(dir, 'test.db');
const initializer = new Database(dbPath);
initializer.exec(SQLITE_INIT_SQL);
initializer.close();
const baseDb = new PrismaClient({
  datasources: { db: { url: `file:${dbPath.replaceAll('\\', '/')}` } },
});
// Inject competing writes at a query boundary; every query still uses real SQLite.
let beforePauseLookup: (() => Promise<void>) | undefined;
const db = baseDb.$extends({
  query: {
    workflowTransition: {
      async findFirst({ args, query }) {
        if (
          args.where?.toStatus === 'awaiting_question' &&
          args.select?.id &&
          !args.select.metadata
        ) {
          const intervene = beforePauseLookup;
          beforePauseLookup = undefined;
          await intervene?.();
        }
        return query(args);
      },
    },
  },
});
const createLogger = () => ({ info() {}, warn() {}, error() {}, debug() {} });
mock.module('../../../config', () => ({ prisma: db, createLogger }));
mock.module('../../../config/database', () => ({ prisma: db }));
mock.module('../../../config/logger', () => ({ createLogger }));
const redispatch = mock(async () => {});
const reexecute = mock(async () => {});
const completionGate = mock(async () => {
  throw Error('Question answers must not synchronously evaluate completion');
});
mock.module('../../../services/workflow/completion-gate', () => ({
  evaluateCompletionGate: completionGate,
  researchConcludesNoChange: () => false,
  verifyJustifiesNoChange: () => false,
}));
mock.module('./workflow-handlers-resume-redispatch', () => ({
  triggerRedispatchAfterResume: redispatch,
  triggerReExecutionAfterAnswer: reexecute,
}));
mock.module('../../../services/workflow/workflow-invariants', () => ({
  checkWorkflowInvariants: async () => [],
  normalizeWorkflowStatus: (status: string) => status,
}));
mock.module('../../../services/workflow/verify-invariant-repair', () => ({
  attemptInvariantCutoff: async () => false,
}));
mock.module('../../../services/workflow/phase-critic', () => ({
  findRecentCriticBounce: async () => null,
}));
mock.module('../../../services/memory/hypothesis-from-research', () => ({
  fileHypothesesFromResearch: async () => {},
}));
mock.module('../../../services/memory/hypothesis-from-verify', () => ({
  applyHypothesisVerdictsFromVerify: async () => {},
}));

const files = await import('../../../services/workflow/workflow-file-utils');
const archive = spyOn(files, 'archiveWorkflowFile');
const { recordTransition } = await import('../../../services/workflow/transition-recorder');
const { computeAndApplyStatusTransition } = await import('./file-save/status-transition');
const { applyQuestionAnswerByKind } = await import('./workflow-handlers-resume-dispatch');
const { handleAnswerWorkflowQuestion, applyIntakeQuestionAnswerLocked } =
  await import('./workflow-handlers-resume');
const { handleResumeFromQuestion } = await import('./workflow-handlers-resume-continuation');
const { guardStatusTransition, resolveTargetTask } = await import('./file-save/guards');
const plan = '# Approved plan\n- Preserve this approved requirement';

beforeEach(async () => {
  beforePauseLookup = undefined;
  await db.workflowTransition.deleteMany();
  await db.workflowFileVersion.deleteMany();
  await db.workflowFile.deleteMany();
  await db.task.deleteMany();
  archive.mockClear();
  redispatch.mockClear();
  reexecute.mockClear();
  completionGate.mockClear();
});
afterAll(async () => {
  archive.mockRestore();
  await db.$disconnect();
  const target = resolve(dir);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !basename(target).startsWith('rapitas-question-regression-')
  )
    throw Error('Unsafe test cleanup path');
  rmSync(target, { recursive: true, force: true });
});

test.each([
  ['in_progress', 'execution_continuation'],
  ['verify_done', 'completion_confirmation'],
] as const)('897 question save/answer preserves plan from %s', async (previousStatus, kind) => {
  const task = await db.task.create({
    data: { title: 'isolated 897 fixture', status: 'in-progress', workflowStatus: previousStatus },
  });
  await files.writeWorkflowFile(task.id, 'plan', plan);
  const guard = await guardStatusTransition(task.id, 'question', await resolveTargetTask(task.id));
  expect(guard).toMatchObject({ ok: true, status: previousStatus });
  await files.writeWorkflowFile(task.id, 'question', '# Continue with the approved plan?');
  await computeAndApplyStatusTransition({
    taskId: task.id,
    fileType: 'question',
    currentStatus: previousStatus,
    savedContent: '# Continue with the approved plan?',
  });
  const pause = await db.workflowTransition.findFirstOrThrow({
    where: { taskId: task.id, toStatus: 'awaiting_question' },
  });
  expect(JSON.parse(pause.metadata)).toMatchObject({ previousStatus, kind });
  const result = await applyQuestionAnswerByKind({
    taskId: task.id,
    answer: 'Continue',
    actor: 'user',
    sourceLabel: 'regression fixture',
  });
  expect(result).toMatchObject({ kind, toStatus: previousStatus });
  expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).workflowStatus).toBe(
    previousStatus,
  );
  expect(await files.readWorkflowFile(task.id, 'plan')).toBe(plan);
  expect(archive.mock.calls.filter(([, type]) => type === 'plan')).toHaveLength(0);
  expect(await db.workflowFileVersion.count({ where: { taskId: task.id, fileType: 'plan' } })).toBe(
    0,
  );
  expect(reexecute).not.toHaveBeenCalled();
  expect(completionGate).not.toHaveBeenCalled();
  expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).status).not.toBe('done');
  const resumed = await db.workflowTransition.findFirstOrThrow({
    where: { taskId: task.id, cause: 'question_resolved' },
  });
  expect(JSON.parse(resumed.metadata)).toMatchObject({
    kind,
    ...(kind === 'completion_confirmation' ? { recheckCompletionGate: true } : {}),
  });
});

test('specification answer archives plan exactly once and returns to draft', async () => {
  const task = await db.task.create({
    data: {
      title: 'isolated intake fixture',
      status: 'in-progress',
      workflowStatus: 'awaiting_question',
    },
  });
  await files.writeWorkflowFile(task.id, 'plan', plan);
  await files.writeWorkflowFile(task.id, 'question', '# What requirement changed?');
  await recordTransition({
    taskId: task.id,
    fromStatus: 'draft',
    toStatus: 'awaiting_question',
    actor: 'system',
    cause: 'intake_question',
    metadata: { kind: 'spec_change', previousStatus: 'draft' },
  });
  await applyQuestionAnswerByKind({
    taskId: task.id,
    answer: 'New requirement',
    actor: 'user',
    sourceLabel: 'regression fixture',
  });
  expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).workflowStatus).toBe(
    'draft',
  );
  expect(await db.workflowFile.count({ where: { taskId: task.id, fileType: 'plan' } })).toBe(0);
  expect(archive.mock.calls.filter(([, type]) => type === 'plan')).toHaveLength(1);
  expect(await db.workflowFileVersion.count({ where: { taskId: task.id, fileType: 'plan' } })).toBe(
    1,
  );
  expect(reexecute).toHaveBeenCalledTimes(1);
});

type Endpoint = 'answer-question' | 'resume-from-question';
type Kind = 'spec_change' | 'execution_continuation' | 'completion_confirmation';
const endpoints: Endpoint[] = ['answer-question', 'resume-from-question'];

async function pendingQuestion(kind: Kind) {
  const previousStatus = kind === 'completion_confirmation' ? 'verify_done' : 'in_progress';
  const task = await db.task.create({
    data: {
      title: 'isolated API regression',
      status: 'in-progress',
      workflowStatus: previousStatus,
    },
  });
  await files.writeWorkflowFile(task.id, 'plan', plan);
  const guard = await guardStatusTransition(task.id, 'question', await resolveTargetTask(task.id));
  expect(guard).toMatchObject({ ok: true, status: previousStatus });
  await files.writeWorkflowFile(task.id, 'question', '# Pending question');
  await computeAndApplyStatusTransition({
    taskId: task.id,
    fileType: 'question',
    currentStatus: previousStatus,
    savedContent: '# Pending question',
  });
  if (kind === 'spec_change') {
    await recordTransition({
      taskId: task.id,
      fromStatus: previousStatus,
      toStatus: 'awaiting_question',
      cause: 'intake_question',
      actor: 'system',
      metadata: { kind, previousStatus },
    });
  }
  return task.id;
}

function callEndpoint(endpoint: Endpoint, taskId: number, set: { status?: number } = {}) {
  const params = { taskId: String(taskId) };
  return endpoint === 'answer-question'
    ? handleAnswerWorkflowQuestion({
        params,
        set,
        body: { answer: 'Approved answer' },
        headers: { 'x-rapitas-source': 'operator' },
      })
    : handleResumeFromQuestion({ params, set });
}

async function snapshot(taskId: number) {
  return {
    task: await db.task.findUniqueOrThrow({ where: { id: taskId } }),
    question: await files.readWorkflowFile(taskId, 'question'),
    plan: await files.readWorkflowFile(taskId, 'plan'),
    versions: await db.workflowFileVersion.count({ where: { taskId } }),
  };
}

for (const endpoint of endpoints) {
  test.each(['execution_continuation', 'completion_confirmation'] as const)(
    `${endpoint}: guard-inclusive %s preserves plan and returns recorded kind`,
    async (kind) => {
      const taskId = await pendingQuestion(kind);
      const question = await files.readWorkflowFile(taskId, 'question');
      const result = await callEndpoint(endpoint, taskId);
      const expectedStatus = kind === 'completion_confirmation' ? 'verify_done' : 'in_progress';
      expect(result).toMatchObject({ ok: true, toStatus: expectedStatus, resolvedKind: kind });
      const after = await snapshot(taskId);
      expect(after.task.workflowStatus).toBe(expectedStatus);
      expect(after.task.status).not.toBe('done');
      expect(after.plan).toBe(plan);
      expect(await db.workflowFileVersion.count({ where: { taskId, fileType: 'plan' } })).toBe(0);
      expect(archive.mock.calls.filter(([, type]) => type === 'plan')).toHaveLength(0);
      expect(reexecute).not.toHaveBeenCalled();
      expect(completionGate).not.toHaveBeenCalled();
      if (endpoint === 'resume-from-question') expect(after.question).toBe(question);
      else expect(after.question).toContain('Approved answer');
      const transition = await db.workflowTransition.findFirstOrThrow({
        where: { taskId, cause: 'question_resolved' },
        orderBy: { id: 'desc' },
      });
      expect(JSON.parse(transition.metadata)).toMatchObject({
        kind,
        ...(kind === 'completion_confirmation' ? { recheckCompletionGate: true } : {}),
      });
    },
  );

  test(`${endpoint}: specification changes require an answer and archive only on acceptance`, async () => {
    const taskId = await pendingQuestion('spec_change');
    const before = await snapshot(taskId);
    const set: { status?: number } = {};
    if (endpoint === 'resume-from-question') {
      await expect(callEndpoint(endpoint, taskId, set)).rejects.toThrow();
      expect(set.status).toBe(400);
      expect(await snapshot(taskId)).toEqual(before);
      expect(archive).not.toHaveBeenCalled();
      expect(redispatch).not.toHaveBeenCalled();
      expect(reexecute).not.toHaveBeenCalled();
    } else {
      expect(await callEndpoint(endpoint, taskId, set)).toMatchObject({
        resolvedKind: 'spec_change',
        toStatus: 'draft',
      });
      expect(archive.mock.calls.filter(([, type]) => type === 'plan')).toHaveLength(1);
      expect(await db.workflowFileVersion.count({ where: { taskId, fileType: 'plan' } })).toBe(1);
      expect((await snapshot(taskId)).task.workflowStatus).toBe('draft');
      expect((await snapshot(taskId)).plan).toBeNull();
      expect(reexecute).toHaveBeenCalledTimes(1);
    }
    expect(completionGate).not.toHaveBeenCalled();
  });

  test(`${endpoint}: persisted stop refuses answer without changing task or files`, async () => {
    const taskId = await pendingQuestion('execution_continuation');
    await recordTransition({
      taskId,
      fromStatus: 'awaiting_question',
      toStatus: 'awaiting_question',
      cause: 'manual_execution_stop_revert',
      actor: 'user',
    });
    const before = await snapshot(taskId);
    const set: { status?: number } = {};
    await expect(callEndpoint(endpoint, taskId, set)).rejects.toThrow();
    expect(set.status).toBe(409);
    expect(await snapshot(taskId)).toEqual(before);
    expect(redispatch).not.toHaveBeenCalled();
    expect(reexecute).not.toHaveBeenCalled();
  });

  test(`${endpoint}: a newer question arriving during lookup rejects the stale answer`, async () => {
    const taskId = await pendingQuestion('execution_continuation');
    const before = await snapshot(taskId);
    let injected = false;
    beforePauseLookup = async () => {
      injected = true;
      await recordTransition({
        taskId,
        fromStatus: 'in_progress',
        toStatus: 'awaiting_question',
        cause: 'file_saved:question',
        actor: 'system',
        metadata: { kind: 'execution_continuation', previousStatus: 'in_progress' },
      });
    };
    const set: { status?: number } = {};
    try {
      await expect(callEndpoint(endpoint, taskId, set)).rejects.toThrow();
      expect(injected).toBe(true);
      expect(set.status).toBe(409);
      expect(await snapshot(taskId)).toEqual(before);
      expect(redispatch).not.toHaveBeenCalled();
      expect(reexecute).not.toHaveBeenCalled();
    } finally {
      beforePauseLookup = undefined;
    }
  });

  test(`${endpoint}: simultaneous answers apply once and reject the second with 409`, async () => {
    const taskId = await pendingQuestion('execution_continuation');
    const sets: { status?: number }[] = [{}, {}];
    const results = await Promise.allSettled(
      sets.map((set) => callEndpoint(endpoint, taskId, set)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(sets.filter((set) => set.status === 409)).toHaveLength(1);
    expect(
      await db.workflowTransition.count({ where: { taskId, cause: 'question_resolved' } }),
    ).toBe(1);
    expect(redispatch).toHaveBeenCalledTimes(1);
    expect(archive).not.toHaveBeenCalled();
    expect((await snapshot(taskId)).plan).toBe(plan);
    expect(completionGate).not.toHaveBeenCalled();
  });

  test(`${endpoint}: stop arriving after the first check prevents the answer`, async () => {
    const taskId = await pendingQuestion('execution_continuation');
    const before = await snapshot(taskId);
    let injected = false;
    beforePauseLookup = async () => {
      injected = true;
      // The stop intent is durable without replacing the pending-question row.
      await recordTransition({
        taskId,
        fromStatus: 'awaiting_question',
        toStatus: 'in_progress',
        cause: 'manual_execution_stop_revert',
        actor: 'user',
      });
    };
    const set: { status?: number } = {};
    try {
      await expect(callEndpoint(endpoint, taskId, set)).rejects.toMatchObject({
        code: 'task_stopping',
      });
      expect(injected).toBe(true);
      expect(set.status).toBe(409);
      expect(await snapshot(taskId)).toEqual(before);
      expect(redispatch).not.toHaveBeenCalled();
      expect(reexecute).not.toHaveBeenCalled();
      expect(completionGate).not.toHaveBeenCalled();
    } finally {
      beforePauseLookup = undefined;
    }
  });
}

// AC5 層1（task 902 第3次改訂）: 旧挙動（answer-questionが常にreset_draft相当の
// applyIntakeQuestionAnswerLockedを無条件に通っていた — task 897の根本原因）と
// 修正後（kindベースのapplyQuestionAnswerByKind）を、同一の本番appliersを使って
// 実測・対比する。再実装によるモックではなく実関数を直接呼ぶため、比較結果が
// 実装から乖離しない。
type ContrastMetrics = {
  archiveCount: number;
  reexecuteCount: number;
  transitions: string[];
  elapsedMs: number;
};

async function transitionSequence(taskId: number): Promise<string[]> {
  const rows = await db.workflowTransition.findMany({
    where: { taskId },
    orderBy: { id: 'asc' },
    select: { fromStatus: true, toStatus: true },
  });
  return rows.map((t) => `${t.fromStatus ?? 'null'}->${t.toStatus}`);
}

/** 修正後(kindベース)の実測: 対象kindの保留質問をapplyQuestionAnswerByKindで解決する。 */
async function measureNewBehavior(kind: Kind): Promise<ContrastMetrics> {
  const taskId = await pendingQuestion(kind);
  archive.mockClear();
  reexecute.mockClear();
  const start = performance.now();
  await applyQuestionAnswerByKind({
    taskId,
    answer: 'Continue',
    actor: 'user',
    sourceLabel: 'ac5 layer1 contrast (current)',
  });
  const elapsedMs = performance.now() - start;
  return {
    archiveCount: archive.mock.calls.filter(([, type]) => type === 'plan').length,
    reexecuteCount: reexecute.mock.calls.length,
    transitions: await transitionSequence(taskId),
    elapsedMs,
  };
}

/**
 * 旧挙動の実測: 対象kindの保留質問に対し、kind解決を経由せず
 * applyIntakeQuestionAnswerLocked（reset_draft相当）を直接呼ぶ。これは
 * answer-questionがkindを無視して常にこの経路を通っていた897当時の実際の
 * コードパスと同一の本番関数呼び出しであり、再現用の別実装ではない。
 */
async function measureOldBehavior(kind: Kind): Promise<ContrastMetrics> {
  const taskId = await pendingQuestion(kind);
  archive.mockClear();
  reexecute.mockClear();
  const start = performance.now();
  await applyIntakeQuestionAnswerLocked({
    taskId,
    answer: 'Continue',
    actor: 'user',
    sourceLabel: 'ac5 layer1 contrast (legacy always-reset_draft)',
  });
  const elapsedMs = performance.now() - start;
  return {
    archiveCount: archive.mock.calls.filter(([, type]) => type === 'plan').length,
    reexecuteCount: reexecute.mock.calls.length,
    transitions: await transitionSequence(taskId),
    elapsedMs,
  };
}

test.each(['spec_change', 'execution_continuation', 'completion_confirmation'] as const)(
  'AC5 層1: %s — 旧挙動(常にreset_draft)と修正後(kindベース)のarchive回数/再実行要求回数/状態遷移/所要時間を実測・対比する',
  async (kind) => {
    const oldMetrics = await measureOldBehavior(kind);
    const newMetrics = await measureNewBehavior(kind);

    console.log(
      `[AC5層1] kind=${kind} 旧挙動: archive=${oldMetrics.archiveCount} reexecute=${oldMetrics.reexecuteCount} ` +
        `elapsedMs=${oldMetrics.elapsedMs.toFixed(2)} transitions=${JSON.stringify(oldMetrics.transitions)}`,
    );
    console.log(
      `[AC5層1] kind=${kind} 修正後: archive=${newMetrics.archiveCount} reexecute=${newMetrics.reexecuteCount} ` +
        `elapsedMs=${newMetrics.elapsedMs.toFixed(2)} transitions=${JSON.stringify(newMetrics.transitions)}`,
    );

    // 旧挙動はkindを無視して常にreset_draft経路を通るため、archive=1・reexecute=1に固定される。
    expect(oldMetrics.archiveCount).toBe(1);
    expect(oldMetrics.reexecuteCount).toBe(1);

    if (kind === 'spec_change') {
      // spec_changeは旧・新どちらも同じreset_draft経路を通るため差が出ない —
      // これは意図した一致であり退行ではない（AC1の維持を裏付ける）。
      expect(newMetrics.archiveCount).toBe(oldMetrics.archiveCount);
      expect(newMetrics.reexecuteCount).toBe(oldMetrics.reexecuteCount);
    } else {
      // execution_continuation/completion_confirmationでは、修正後はplan.mdを
      // archiveせず再実行も要求しない — 旧挙動との差分そのものがAC5の実測対象。
      expect(newMetrics.archiveCount).not.toBe(oldMetrics.archiveCount);
      expect(newMetrics.archiveCount).toBe(0);
      expect(newMetrics.reexecuteCount).toBe(0);
    }
  },
);
