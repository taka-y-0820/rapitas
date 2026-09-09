/**
 * workflow-reconciler.test
 *
 * Pure-logic tests for the zombie-session finalize decision: only abandoned
 * (stale, non-awaiting) active sessions are finalized — never a live long phase
 * or a session legitimately waiting on the user.
 *
 * Also covers `runHealPass`'s fault-isolation contract: `reconcileOnce()` runs
 * many UNRELATED heal passes back to back, each wrapped in `runHealPass`. A
 * throw in one pass must not propagate and abort the rest of that cycle —
 * otherwise a single deterministically-throwing row (bad shape, JS bug) in an
 * early pass would permanently starve every later pass, every cycle, forever.
 *
 * The `reconcileOnce — blocked-task pass ordering` block (task 802) exercises
 * the real `reconcileOnce()` against a stateful Prisma mock to prove
 * `healBlockedStatusDesync` runs BEFORE `requeueBlockedTasks` in the same
 * cycle, so a status/workflowStatus desync it heals is excluded from the
 * blind-retry candidate query instead of being reset to draft. Prisma must be
 * mocked BEFORE the first import of `./workflow-reconciler` (bun's
 * `mock.module` cannot retroactively rebind an already-evaluated static
 * import), so every import in this file is a dynamic `await import()` placed
 * after the `mock.module` calls below.
 */
import { describe, it, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
mock.module('../../config/logger', () => ({
  createLogger: () => noopLogger,
  logger: noopLogger,
  getBackendLogFilePath: () => '/tmp/backend.log',
}));

interface TaskRow {
  id: number;
  title: string;
  themeId: number | null;
  workflowStatus: string | null;
  completedAt: Date | null;
  updatedAt: Date;
  status: string;
  parentId: number | null;
}

/** Minimal Prisma `where` matcher covering the clause shapes the reconciler passes use. */
function matchClause(value: unknown, clause: unknown): boolean {
  if (clause === null) return value === null;
  if (clause instanceof Date) return value instanceof Date && value.getTime() === clause.getTime();
  if (clause !== null && typeof clause === 'object') {
    return Object.entries(clause as Record<string, unknown>).every(([op, opVal]) => {
      const v = value as Date | null;
      switch (op) {
        case 'in':
          return (opVal as unknown[]).includes(value);
        case 'notIn':
          return !(opVal as unknown[]).includes(value);
        case 'not':
          return value !== opVal;
        case 'lt':
          return v instanceof Date && v.getTime() < (opVal as Date).getTime();
        case 'lte':
          return v instanceof Date && v.getTime() <= (opVal as Date).getTime();
        case 'gt':
          return v instanceof Date && v.getTime() > (opVal as Date).getTime();
        case 'gte':
          return v instanceof Date && v.getTime() >= (opVal as Date).getTime();
        default:
          return true;
      }
    });
  }
  return value === clause;
}
function matchesWhere(row: TaskRow, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, clause]) =>
    matchClause((row as unknown as Record<string, unknown>)[k], clause),
  );
}

let tasks: TaskRow[] = [];
const taskFindMany = mock((args: { where?: Record<string, unknown> }) =>
  Promise.resolve(tasks.filter((t) => matchesWhere(t, args?.where))),
);
const taskFindUnique = mock((args: { where: { id: number } }) =>
  Promise.resolve(tasks.find((t) => t.id === args.where.id) ?? null),
);
const taskUpdate = mock((args: { where: { id: number }; data: Record<string, unknown> }) => {
  const row = tasks.find((t) => t.id === args.where.id);
  if (row) Object.assign(row, args.data);
  return Promise.resolve(row ?? {});
});

let blockedAt: Date | null = null;
let hasUserAdvance = false;
const workflowTransitionFindFirst = mock(
  (args: { where: { toStatus?: string; actor?: string } }) => {
    if (args.where.toStatus === 'blocked') {
      return Promise.resolve(blockedAt ? { createdAt: blockedAt } : null);
    }
    if (args.where.actor === 'user') {
      return Promise.resolve(hasUserAdvance ? { id: 1 } : null);
    }
    return Promise.resolve(null);
  },
);

const mockPrisma = {
  task: {
    findMany: taskFindMany,
    findUnique: taskFindUnique,
    update: taskUpdate,
    updateMany: mock(async (args: any) => {
      const row = tasks.find(
        (t) =>
          t.id === args.where.id &&
          t.status === args.where.status &&
          t.updatedAt.getTime() === args.where.updatedAt.getTime(),
      );
      if (!row) return { count: 0 };
      Object.assign(row, args.data);
      return { count: 1 };
    }),
  },
  agentSession: { findMany: mock(() => Promise.resolve([] as unknown[])) },
  agentExecution: { findFirst: mock(() => Promise.resolve(null as unknown)) },
  notification: { findFirst: mock(() => Promise.resolve(null as unknown)) },
  workflowTransition: {
    count: mock(() => Promise.resolve(0)),
    findFirst: workflowTransitionFindFirst,
    create: mock(() => Promise.resolve({})),
  },
  themeAutoRun: { findMany: mock(() => Promise.resolve([{ themeId: 1 }])) },
  userSettings: { findFirst: mock(() => Promise.resolve(null as unknown)) },
  activityLog: { findFirst: mock(() => Promise.resolve(null as unknown)) },
};
mock.module('../../config/database', () => ({
  prisma: mockPrisma,
  ensureDatabaseConnection: () => Promise.resolve(),
}));
mock.module('../communication/notification-service', () => ({
  createNotification: mock(() => Promise.resolve({})),
  notifyTaskCompleted: mock(() => Promise.resolve()),
  notifyAgentExecutionCompleted: mock(() => Promise.resolve()),
  notifyApprovalRequested: mock(() => Promise.resolve()),
  notifyAuthenticationFailure: mock(() => Promise.resolve()),
  notifyIntakeQuestionPending: mock(() => Promise.resolve()),
  notifyQuestionAutoAnswered: mock(() => Promise.resolve()),
  notifyPomodoroCompleted: mock(() => Promise.resolve()),
  notifyKnowledgeExtracted: mock(() => Promise.resolve()),
  AUTH_FAILURE_NOTIFICATION_TITLE: 'Claude 認証切れ',
  INTAKE_QUESTION_NOTIFICATION_TITLE: '確認の質問が回答待ちです',
  INTAKE_QUESTION_NOTIFY_WINDOW_MS: 60 * 60 * 1000,
}));
// Detection/other heal passes (task 802 scope: only the blocked-task order
// contract is under test here) — stubbed to no-ops so this test does not need
// to model their unrelated DB shapes.
mock.module('./workflow-reconciler-question-pause', () => ({
  healOrphanedQuestionPause: mock(() => Promise.resolve(0)),
}));
mock.module('./workflow-reconciler-question-auto-answer', () => ({
  healStaleQuestionAutoAnswer: mock(() => Promise.resolve({ autoAnswered: 0 })),
}));
mock.module('./workflow-reconciler-autoapprove', () => ({
  healAutoApproveStalls: mock(() => Promise.resolve(0)),
}));
mock.module('./workflow-reconciler-queue-sweep', () => ({
  sweepStaleQueueItems: mock(() => Promise.resolve(0)),
}));
mock.module('./workflow-reconciler-queue-stall', () => ({
  sweepStaleRunningItems: mock(() => Promise.resolve(0)),
  detectQueueStarvation: mock(() => Promise.resolve(0)),
}));
mock.module('./self-incident-watcher', () => ({
  runSelfIncidentWatch: mock(() => Promise.resolve(0)),
}));
mock.module('./workflow-reconciler-zero-progress', () => ({
  detectZeroProgressWhileRunning: mock(() => Promise.resolve(0)),
}));

// Import AFTER all mock.module calls — reconcileOnce()'s module-level
// `import { prisma } from '../../config/database'` binds at first import.
const { shouldFinalizeSession, STALE_SESSION_MS, runHealPass, reconcileOnce } =
  await import('./workflow-reconciler');

const NOW = 1_000_000_000_000;
const stale = NOW - STALE_SESSION_MS - 1; // just past the threshold
const fresh = NOW - 60_000; // 1 min ago

describe('shouldFinalizeSession', () => {
  it('finalizes a stale, non-awaiting active session', () => {
    expect(shouldFinalizeSession({ lastActivityAtMs: stale, nowMs: NOW })).toBe(true);
  });

  it.each([
    {
      name: 'a session within the staleness window (live long phase)',
      input: { lastActivityAtMs: fresh, nowMs: NOW },
    },
    {
      name: 'a session awaiting user input',
      input: { lastActivityAtMs: stale, nowMs: NOW, latestExecStatus: 'waiting_for_input' },
    },
    {
      name: 'a task awaiting a clarifying question',
      input: { lastActivityAtMs: stale, nowMs: NOW, taskWorkflowStatus: 'awaiting_question' },
    },
  ])('does NOT finalize $name', ({ input }) => {
    expect(shouldFinalizeSession(input)).toBe(false);
  });

  it('staleness threshold exceeds the 30m phase timeout (no false finalize of a max-length phase)', () => {
    expect(STALE_SESSION_MS).toBeGreaterThan(30 * 60 * 1000);
  });
});

describe('runHealPass — fault isolation', () => {
  it('returns the real count when the pass succeeds', async () => {
    const pass = mock(() => Promise.resolve(3));

    const count = await runHealPass('someHealPass', pass);

    expect(count).toBe(3);
  });

  it('swallows a throwing pass and returns 0 instead of propagating', async () => {
    const pass = mock(() => Promise.reject(new Error('bad row shape')));

    await expect(runHealPass('someHealPass', pass)).resolves.toBe(0);
  });

  it('one throwing pass does not prevent a SUBSEQUENT pass from running', async () => {
    const failing = mock(() => Promise.reject(new Error('boom')));
    const succeeding = mock(() => Promise.resolve(5));

    // Mirrors reconcileOnce()'s sequential await chain: pass 1 throws, pass 2
    // must still run and return its real count.
    const first = await runHealPass('failingPass', failing);
    const second = await runHealPass('succeedingPass', succeeding);

    expect(first).toBe(0);
    expect(second).toBe(5);
    expect(succeeding).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileOnce — blocked-task pass ordering (task 802)', () => {
  beforeEach(() => {
    // reconcileOnce() always reads real Date.now() internally (no nowMs
    // param) — anchor test fixtures to the real clock, not a fixed constant.
    const realNow = Date.now();
    tasks = [
      {
        id: 800,
        title: 'task 800',
        themeId: 1,
        workflowStatus: 'plan_approved',
        completedAt: null,
        updatedAt: new Date(realNow - 30 * 60 * 1000), // settled (> 3 min)
        status: 'blocked',
        parentId: null,
      },
    ];
    blockedAt = new Date(realNow - 40 * 60 * 1000);
    hasUserAdvance = true;
    taskFindMany.mockClear();
    taskUpdate.mockClear();
    workflowTransitionFindFirst.mockClear();
  });

  test('healBlockedStatusDesync heals status BEFORE requeueBlockedTasks sees it — no draft reset', async () => {
    const counts = await reconcileOnce();

    expect(counts.statusDesyncsHealed).toBe(1);
    // requeueBlockedTasks' own candidate query (status:'blocked') found nothing
    // to retry — the heal already flipped status to 'todo' in the same cycle.
    expect(counts.retriedBlocked).toBe(0);

    const task800 = tasks.find((t) => t.id === 800);
    expect(task800?.status).toBe('todo');
    // workflowStatus is untouched — requeueBlockedTasks would have reset it to
    // 'draft'; the heal never touches it (only `status` is restored).
    expect(task800?.workflowStatus).toBe('plan_approved');
  });
});
