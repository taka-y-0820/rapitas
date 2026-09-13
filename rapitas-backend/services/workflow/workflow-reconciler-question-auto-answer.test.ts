/**
 * workflow-reconciler-question-auto-answer.test
 *
 * Covers healStaleQuestionAutoAnswer: timeout boundary, settle window,
 * freeTextRequired/mutatesGate exclusion, once-per-task cap, terminal-status
 * exclusion, cause-based branching (intake_question vs file_saved:question vs
 * unknown), and per-task fault isolation.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const NOW_MS = 1_800_000_000_000;
const ONE_HOUR_MS = 60 * 60 * 1000;

const ELIGIBLE_QUESTION_MD =
  '# 仕様確認\n\n```json:options\n' +
  JSON.stringify({
    questions: [
      {
        id: 'Q1',
        summary: '達成すべきゴール',
        options: [
          { key: 'A', label: '速度を優先する', consequence: '実装は最小限にする' },
          { key: 'B', label: '品質を優先する', consequence: 'テストを手厚くする' },
        ],
        freeTextRequired: false,
        recommended: 'B',
        recommendedReason: 'plan.md §テスト戦略の実測値に基づき品質優先が妥当',
      },
    ],
  }) +
  '\n```';

const FREE_TEXT_QUESTION_MD =
  '```json:options\n' +
  JSON.stringify({
    questions: [
      {
        id: 'Q1',
        summary: 'APIキー',
        options: [],
        freeTextRequired: true,
        freeTextReason: '秘匿情報',
      },
    ],
  }) +
  '\n```';

const MUTATES_GATE_QUESTION_MD =
  '```json:options\n' +
  JSON.stringify({
    questions: [
      {
        id: 'Q1',
        summary: '検出しきい値変更',
        options: [{ key: 'A', label: '検出しきい値を緩める', mutatesGate: true }],
        freeTextRequired: false,
        recommended: 'A',
        recommendedReason: '検出漏れを減らすため',
      },
    ],
  }) +
  '\n```';

const taskFindManyMock = mock(() => Promise.resolve<Record<string, unknown>[]>([]));
const fileFindFirstMock = mock(() => Promise.resolve<Record<string, unknown> | null>(null));
const transitionFindFirstMock = mock(() => Promise.resolve<Record<string, unknown> | null>(null));

const mockPrisma = {
  task: { findMany: taskFindManyMock },
  workflowFile: { findFirst: fileFindFirstMock },
  workflowTransition: { findFirst: transitionFindFirstMock },
};

/** Shared discriminator for the 3 distinct `workflowTransition.findFirst` call shapes SUT makes. */
function defaultTransitionFindFirstImpl(args: unknown) {
  const where = (args as { where?: { toStatus?: string; metadata?: { contains?: string } } })
    ?.where;
  if (where?.metadata) {
    // Lifetime prior-auto-answer check (once-per-task cap) — none by default.
    return Promise.resolve(null);
  }
  if (where?.toStatus === 'awaiting_question') {
    return Promise.resolve({ cause: 'intake_question' });
  }
  // "latest transition" lookup (no toStatus/metadata filter) — settle window check
  return Promise.resolve({ createdAt: new Date(NOW_MS - ONE_HOUR_MS - 60_000) });
}

mock.module('../../config/logger', () => ({
  getBackendLogFilePath: () => '/tmp/backend.log',
  logger: noopLogger,
  createLogger: () => noopLogger,
}));
mock.module('../../config/database', () => ({
  prisma: mockPrisma,
  ensureDatabaseConnection: async () => {},
}));

const writeWorkflowFileMock = mock(() => Promise.resolve(''));
mock.module('./workflow-file-utils', () => ({ writeWorkflowFile: writeWorkflowFileMock }));

// task 902: the reconciler no longer branches between the intake/resume
// appliers itself — it delegates to the single kind-based dispatcher, which
// has its own dedicated unit tests (workflow-handlers-resume-dispatch.test.ts)
// covering the intake-vs-resume branching. Mocked as one boundary here.
const applyQuestionAnswerByKindMock = mock(() =>
  Promise.resolve({
    taskId: 1,
    ok: true as const,
    toStatus: 'draft' as const,
    kind: 'spec_change' as const,
  }),
);
mock.module('../../routes/workflow/handlers/workflow-handlers-resume-dispatch', () => ({
  applyQuestionAnswerByKind: applyQuestionAnswerByKindMock,
}));

const notifyQuestionAutoAnsweredMock = mock(() => Promise.resolve());
mock.module('../communication/notification-service', () => ({
  notifyQuestionAutoAnswered: notifyQuestionAutoAnsweredMock,
}));

const { healStaleQuestionAutoAnswer } = await import('./workflow-reconciler-question-auto-answer');

function baseTask(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    title: 'テストタスク',
    status: 'todo',
    workflowStatus: 'awaiting_question',
    ...overrides,
  };
}

beforeEach(() => {
  taskFindManyMock.mockReset().mockResolvedValue([baseTask()]);
  fileFindFirstMock.mockReset().mockResolvedValue({
    content: ELIGIBLE_QUESTION_MD,
    updatedAt: new Date(NOW_MS - ONE_HOUR_MS - 60_000),
  });
  transitionFindFirstMock.mockReset().mockImplementation(defaultTransitionFindFirstImpl);
  writeWorkflowFileMock.mockReset().mockResolvedValue('');
  applyQuestionAnswerByKindMock
    .mockReset()
    .mockResolvedValue({ taskId: 1, ok: true, toStatus: 'draft', kind: 'spec_change' });
  notifyQuestionAutoAnsweredMock.mockReset().mockResolvedValue(undefined);
  delete process.env.RAPITAS_QUESTION_AUTO_ANSWER_MS;
});

describe('healStaleQuestionAutoAnswer', () => {
  test('skips when 59 minutes 59 seconds have elapsed (below the default 60m timeout)', async () => {
    fileFindFirstMock.mockResolvedValue({
      content: ELIGIBLE_QUESTION_MD,
      updatedAt: new Date(NOW_MS - (ONE_HOUR_MS - 1000)),
    });

    const result = await healStaleQuestionAutoAnswer(new Date(NOW_MS));

    expect(result).toEqual({ scanned: 1, autoAnswered: 0, skipped: 1 });
    expect(applyQuestionAnswerByKindMock).not.toHaveBeenCalled();
  });

  test('auto-adopts when 60 minutes 1 second have elapsed', async () => {
    fileFindFirstMock.mockResolvedValue({
      content: ELIGIBLE_QUESTION_MD,
      updatedAt: new Date(NOW_MS - (ONE_HOUR_MS + 1000)),
    });

    const result = await healStaleQuestionAutoAnswer(new Date(NOW_MS));

    expect(result).toEqual({ scanned: 1, autoAnswered: 1, skipped: 0 });
    expect(applyQuestionAnswerByKindMock).toHaveBeenCalledTimes(1);
  });

  test('skips inside the settle window (a transition landed in the last 2 minutes)', async () => {
    transitionFindFirstMock.mockImplementation((args: unknown) => {
      const where = (args as { where?: { toStatus?: string; metadata?: { contains?: string } } })
        ?.where;
      if (where?.metadata) return Promise.resolve(null);
      if (where?.toStatus === 'awaiting_question') {
        return Promise.resolve({ cause: 'intake_question' });
      }
      return Promise.resolve({ createdAt: new Date(NOW_MS - 30_000) });
    });

    const result = await healStaleQuestionAutoAnswer(new Date(NOW_MS));

    expect(result.autoAnswered).toBe(0);
    expect(applyQuestionAnswerByKindMock).not.toHaveBeenCalled();
  });

  test('skips a freeTextRequired question', async () => {
    fileFindFirstMock.mockResolvedValue({
      content: FREE_TEXT_QUESTION_MD,
      updatedAt: new Date(NOW_MS - ONE_HOUR_MS - 60_000),
    });

    const result = await healStaleQuestionAutoAnswer(new Date(NOW_MS));

    expect(result.autoAnswered).toBe(0);
    expect(applyQuestionAnswerByKindMock).not.toHaveBeenCalled();
  });

  test('skips a mutatesGate recommended option', async () => {
    fileFindFirstMock.mockResolvedValue({
      content: MUTATES_GATE_QUESTION_MD,
      updatedAt: new Date(NOW_MS - ONE_HOUR_MS - 60_000),
    });

    const result = await healStaleQuestionAutoAnswer(new Date(NOW_MS));

    expect(result.autoAnswered).toBe(0);
    expect(applyQuestionAnswerByKindMock).not.toHaveBeenCalled();
  });

  test('skips when this task was already auto-answered once (1-per-task, lifetime cap)', async () => {
    transitionFindFirstMock.mockImplementation((args: unknown) => {
      const where = (args as { where?: { toStatus?: string; metadata?: { contains?: string } } })
        ?.where;
      if (where?.metadata) return Promise.resolve({ id: 999 });
      if (where?.toStatus === 'awaiting_question') {
        return Promise.resolve({ cause: 'intake_question' });
      }
      return Promise.resolve({ createdAt: new Date(NOW_MS - ONE_HOUR_MS - 60_000) });
    });

    const result = await healStaleQuestionAutoAnswer(new Date(NOW_MS));

    expect(result.autoAnswered).toBe(0);
    expect(applyQuestionAnswerByKindMock).not.toHaveBeenCalled();
  });

  test('the once-per-task lookup is unbounded (no take/window) — queries by metadata contains, not recency', async () => {
    await healStaleQuestionAutoAnswer(new Date(NOW_MS));

    const metadataCall = transitionFindFirstMock.mock.calls.find(
      (c) => (c[0] as { where?: { metadata?: unknown } })?.where?.metadata,
    );
    expect(metadataCall).toBeDefined();
    const args = metadataCall![0] as {
      where: { taskId: number; metadata: { contains: string } };
    };
    expect(args.where.taskId).toBe(1);
    expect(args.where.metadata.contains).toContain('auto_recommended');
    expect(args).not.toHaveProperty('take');
  });

  test('skips a terminal task.status', async () => {
    taskFindManyMock.mockResolvedValue([baseTask({ status: 'done' })]);

    const result = await healStaleQuestionAutoAnswer(new Date(NOW_MS));

    expect(result.autoAnswered).toBe(0);
    expect(fileFindFirstMock).not.toHaveBeenCalled();
  });

  test('calls applyQuestionAnswerByKind (as system) when cause is intake_question', async () => {
    await healStaleQuestionAutoAnswer(new Date(NOW_MS));

    expect(applyQuestionAnswerByKindMock).toHaveBeenCalledTimes(1);
    const call = applyQuestionAnswerByKindMock.mock.calls[0][0] as {
      actor: string;
      taskId: number;
    };
    expect(call.actor).toBe('system');
    expect(call.taskId).toBe(1);
  });

  // task 902: the intake-vs-resume branching moved into applyQuestionAnswerByKind
  // itself — the reconciler now delegates identically for both eligible causes.
  test('calls applyQuestionAnswerByKind identically when cause is file_saved:question', async () => {
    transitionFindFirstMock.mockImplementation((args: unknown) => {
      const where = (args as { where?: { toStatus?: string; metadata?: { contains?: string } } })
        ?.where;
      if (where?.metadata) return Promise.resolve(null);
      if (where?.toStatus === 'awaiting_question') {
        return Promise.resolve({ cause: 'file_saved:question' });
      }
      return Promise.resolve({ createdAt: new Date(NOW_MS - ONE_HOUR_MS - 60_000) });
    });

    await healStaleQuestionAutoAnswer(new Date(NOW_MS));

    expect(applyQuestionAnswerByKindMock).toHaveBeenCalledTimes(1);
    const call = applyQuestionAnswerByKindMock.mock.calls[0][0] as { actor: string };
    expect(call.actor).toBe('system');
  });

  test('skips when the pause cause is unrecognized', async () => {
    transitionFindFirstMock.mockImplementation((args: unknown) => {
      const where = (args as { where?: { toStatus?: string; metadata?: { contains?: string } } })
        ?.where;
      if (where?.metadata) return Promise.resolve(null);
      if (where?.toStatus === 'awaiting_question') {
        return Promise.resolve({ cause: 'some_other_cause' });
      }
      return Promise.resolve({ createdAt: new Date(NOW_MS - ONE_HOUR_MS - 60_000) });
    });

    const result = await healStaleQuestionAutoAnswer(new Date(NOW_MS));

    expect(result.autoAnswered).toBe(0);
    expect(applyQuestionAnswerByKindMock).not.toHaveBeenCalled();
  });

  test('one task throwing does not stop the others from being processed', async () => {
    taskFindManyMock.mockResolvedValue([baseTask({ id: 1 }), baseTask({ id: 2 })]);
    fileFindFirstMock.mockImplementation((args: unknown) => {
      const where = (args as { where?: { taskId?: number } })?.where;
      if (where?.taskId === 1) throw new Error('boom');
      return Promise.resolve({
        content: ELIGIBLE_QUESTION_MD,
        updatedAt: new Date(NOW_MS - ONE_HOUR_MS - 60_000),
      });
    });

    const result = await healStaleQuestionAutoAnswer(new Date(NOW_MS));

    expect(result.scanned).toBe(2);
    expect(result.autoAnswered).toBe(1);
    expect(result.skipped).toBe(1);
  });
});
