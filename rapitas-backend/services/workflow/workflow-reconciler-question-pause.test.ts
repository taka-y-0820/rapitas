/**
 * workflow-reconciler-question-pause.test
 *
 * Covers restoring an intake question pause that was cleared without an answer
 * (task 656): a live question.md whose task no longer says awaiting_question is
 * re-paused, while consistent, terminal, freshly-answered, moved-on and
 * repeatedly-clobbered tasks are left alone.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const NOW = 1_800_000_000_000;
const STALE = new Date(NOW - 10 * 60 * 1000); // older than the settle window

const fileFindManyMock = mock(() => Promise.resolve([] as { taskId: number }[]));
const taskFindUniqueMock = mock(() => Promise.resolve<Record<string, unknown> | null>(null));
const taskUpdateMock = mock(() => Promise.resolve({}));
const transitionFindFirstMock = mock(() => Promise.resolve<{ toStatus: string } | null>(null));
const transitionCountMock = mock(() => Promise.resolve(0));

const mockPrisma = {
  workflowFile: { findMany: fileFindManyMock },
  task: { findUnique: taskFindUniqueMock, update: taskUpdateMock },
  workflowTransition: { findFirst: transitionFindFirstMock, count: transitionCountMock },
};

const recordTransitionMock = mock(() => Promise.resolve(undefined));

mock.module('../../config/logger', () => ({
  getBackendLogFilePath: () => '/tmp/backend.log',
  logger: noopLogger,
  createLogger: () => noopLogger,
}));
mock.module('../../config', () => ({
  prisma: mockPrisma,
  createLogger: () => noopLogger,
  logger: noopLogger,
}));
mock.module('./transition-recorder', () => ({ recordTransition: recordTransitionMock }));

const { healOrphanedQuestionPause, RESTORE_QUESTION_PAUSE_CAUSE } =
  await import('./workflow-reconciler-question-pause');

/** Default: one pending question on a stale, non-terminal task mid-pause. */
function armHappyPath(overrides: Record<string, unknown> = {}) {
  fileFindManyMock.mockResolvedValue([{ taskId: 656 }]);
  taskFindUniqueMock.mockResolvedValue({
    id: 656,
    status: 'todo',
    workflowStatus: 'draft',
    updatedAt: STALE,
    ...overrides,
  });
  transitionFindFirstMock.mockResolvedValue({ toStatus: 'awaiting_question' });
  transitionCountMock.mockResolvedValue(0);
}

describe('healOrphanedQuestionPause', () => {
  beforeEach(() => {
    fileFindManyMock.mockReset().mockResolvedValue([]);
    taskFindUniqueMock.mockReset().mockResolvedValue(null);
    taskUpdateMock.mockReset().mockResolvedValue({});
    transitionFindFirstMock.mockReset().mockResolvedValue(null);
    transitionCountMock.mockReset().mockResolvedValue(0);
    recordTransitionMock.mockReset().mockResolvedValue(undefined);
  });

  test('restores awaiting_question when a live question.md lost its pause', async () => {
    armHappyPath();

    const restored = await healOrphanedQuestionPause(NOW);

    expect(restored).toBe(1);
    const call = taskUpdateMock.mock.calls[0]?.[0] as {
      where: { id: number };
      data: { workflowStatus: string };
    };
    expect(call.where).toEqual({ id: 656 });
    expect(call.data.workflowStatus).toBe('awaiting_question');
    const t = recordTransitionMock.mock.calls[0]?.[0] as { cause: string; fromStatus: string };
    expect(t.cause).toBe(RESTORE_QUESTION_PAUSE_CAUSE);
    expect(t.fromStatus).toBe('draft');
  });

  test('no-ops when the task already says awaiting_question', async () => {
    armHappyPath({ workflowStatus: 'awaiting_question' });

    expect(await healOrphanedQuestionPause(NOW)).toBe(0);
    expect(taskUpdateMock).not.toHaveBeenCalled();
  });

  test('leaves terminal tasks alone', async () => {
    armHappyPath({ status: 'done' });

    expect(await healOrphanedQuestionPause(NOW)).toBe(0);
    expect(taskUpdateMock).not.toHaveBeenCalled();
  });

  test('leaves a completed workflow alone', async () => {
    armHappyPath({ workflowStatus: 'completed' });

    expect(await healOrphanedQuestionPause(NOW)).toBe(0);
    expect(taskUpdateMock).not.toHaveBeenCalled();
  });

  test('waits out the settle window so an in-flight answer is not re-paused', async () => {
    armHappyPath({ updatedAt: new Date(NOW - 1000) });

    expect(await healOrphanedQuestionPause(NOW)).toBe(0);
    expect(taskUpdateMock).not.toHaveBeenCalled();
  });

  test('does not re-pause a task whose latest transition moved past the pause', async () => {
    armHappyPath();
    transitionFindFirstMock.mockResolvedValue({ toStatus: 'research_done' });

    expect(await healOrphanedQuestionPause(NOW)).toBe(0);
    expect(taskUpdateMock).not.toHaveBeenCalled();
  });

  test('gives up after the per-task restore cap so a human looks at it', async () => {
    armHappyPath();
    transitionCountMock.mockResolvedValue(3);

    expect(await healOrphanedQuestionPause(NOW)).toBe(0);
    expect(taskUpdateMock).not.toHaveBeenCalled();
  });

  // task 902: without this, an answer landing after the heal always falls
  // back to the default kind derivation, which can disagree with the kind
  // actually recorded when the question was first raised.
  test('carries the original pause kind forward into the restored transition metadata', async () => {
    armHappyPath();
    transitionFindFirstMock.mockResolvedValue({
      toStatus: 'awaiting_question',
      metadata: JSON.stringify({ kind: 'completion_confirmation' }),
    });

    const restored = await healOrphanedQuestionPause(NOW);

    expect(restored).toBe(1);
    const t = recordTransitionMock.mock.calls[0]?.[0] as {
      metadata: { kind?: string };
    };
    expect(t.metadata.kind).toBe('completion_confirmation');
  });

  test('omits kind from the restored metadata when the original pause had none', async () => {
    armHappyPath();
    transitionFindFirstMock.mockResolvedValue({ toStatus: 'awaiting_question', metadata: {} });

    await healOrphanedQuestionPause(NOW);

    const t = recordTransitionMock.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    expect(t.metadata).not.toHaveProperty('kind');
  });

  test('returns 0 without querying tasks when nothing is pending', async () => {
    fileFindManyMock.mockResolvedValue([]);

    expect(await healOrphanedQuestionPause(NOW)).toBe(0);
    expect(taskFindUniqueMock).not.toHaveBeenCalled();
  });
});
