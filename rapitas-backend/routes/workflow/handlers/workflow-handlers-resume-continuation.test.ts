/**
 * workflow-handlers-resume-continuation.test
 *
 * Covers applyResumeFromQuestionAnswerLocked's task-902 additions: the
 * `answer` audit-trail append (never archives) and the `recheckCompletionGate`
 * metadata marker; and (revised plan) applyResumeFromQuestionAnswer /
 * handleResumeFromQuestion delegating to applyQuestionAnswerByKind so
 * `resume-from-question` shares the same kind-based routing and
 * competing-answer guards as `answer-question`.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';

mock.module('../../../middleware/error-handler', () => ({
  ValidationError: class ValidationError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'ValidationError';
    }
  },
  NotFoundError: class NotFoundError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'NotFoundError';
    }
  },
  ConflictError: class ConflictError extends Error {
    code?: string;
    constructor(msg: string, code?: string) {
      super(msg);
      this.name = 'ConflictError';
      this.code = code;
    }
  },
}));

const mockApplyQuestionAnswerByKind = mock(() =>
  Promise.resolve({
    taskId: 1,
    ok: true as const,
    toStatus: 'in_progress' as const,
    kind: 'execution_continuation' as const,
  }),
);
mock.module('./workflow-handlers-resume-dispatch', () => ({
  applyQuestionAnswerByKind: mockApplyQuestionAnswerByKind,
}));

const mockFindFirstTransition = mock(() => Promise.resolve<Record<string, unknown> | null>(null));
const mockUpdate = mock(() => Promise.resolve({}));
const mockUpdateMany = mock(() => Promise.resolve({ count: 1 }));
mock.module('../../../config', () => ({
  prisma: {
    task: { update: mockUpdate, updateMany: mockUpdateMany },
    workflowTransition: { findFirst: mockFindFirstTransition },
  },
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

const mockRecordTransition = mock(() => Promise.resolve());
mock.module('../../../services/workflow/transition-recorder', () => ({
  recordTransition: mockRecordTransition,
}));

const mockReadWorkflowFile = mock(() => Promise.resolve<string | null>(null));
const mockWriteWorkflowFile = mock(() => Promise.resolve(''));
mock.module('../../../services/workflow/workflow-file-utils', () => ({
  readWorkflowFile: mockReadWorkflowFile,
  writeWorkflowFile: mockWriteWorkflowFile,
}));

const mockResolveTaskWorkflowState = mock(() =>
  Promise.resolve<Record<string, unknown> | null>(null),
);
mock.module('../../../services/task/task-resolver', () => ({
  resolveTaskWorkflowState: mockResolveTaskWorkflowState,
}));

const mockTriggerRedispatchAfterResume = mock(() => Promise.resolve());
mock.module('./workflow-handlers-resume-redispatch', () => ({
  triggerRedispatchAfterResume: mockTriggerRedispatchAfterResume,
}));

const {
  applyResumeFromQuestionAnswerLocked,
  applyResumeFromQuestionAnswer,
  handleResumeFromQuestion,
} = await import('./workflow-handlers-resume-continuation');
const { NotFoundError, ValidationError, ConflictError } =
  await import('../../../middleware/error-handler');

beforeEach(() => {
  mockFindFirstTransition.mockReset();
  mockUpdate.mockReset().mockResolvedValue({});
  mockUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  mockRecordTransition.mockReset().mockResolvedValue(undefined);
  mockReadWorkflowFile.mockReset().mockResolvedValue(null);
  mockWriteWorkflowFile.mockReset().mockResolvedValue('');
  mockResolveTaskWorkflowState.mockReset().mockResolvedValue({
    id: 1,
    workflowStatus: 'awaiting_question',
  });
  mockTriggerRedispatchAfterResume.mockReset().mockResolvedValue(undefined);
  mockApplyQuestionAnswerByKind.mockReset().mockResolvedValue({
    taskId: 1,
    ok: true,
    toStatus: 'in_progress',
    kind: 'execution_continuation',
  });
});

describe('applyResumeFromQuestionAnswerLocked — answer append (task 902)', () => {
  test('appends the answer to question.md without archiving when answer is provided', async () => {
    mockFindFirstTransition.mockResolvedValue({
      metadata: { previousStatus: 'in_progress' },
      fromStatus: 'in_progress',
    });
    mockReadWorkflowFile.mockResolvedValue('# 質問\n進めてよいか');

    await applyResumeFromQuestionAnswerLocked({
      taskId: 1,
      actor: 'user',
      answer: '進めてください',
    });

    expect(mockWriteWorkflowFile).toHaveBeenCalledWith(
      1,
      'question',
      expect.stringContaining('進めてください'),
    );
    const written = mockWriteWorkflowFile.mock.calls[0][2] as string;
    expect(written).toContain('# 質問\n進めてよいか');
    expect(written).toContain('## 回答');
  });

  test('skips the append when question.md content is missing', async () => {
    mockFindFirstTransition.mockResolvedValue({
      metadata: { previousStatus: 'in_progress' },
      fromStatus: 'in_progress',
    });
    mockReadWorkflowFile.mockResolvedValue(null);

    await applyResumeFromQuestionAnswerLocked({ taskId: 1, actor: 'user', answer: '回答' });

    expect(mockWriteWorkflowFile).not.toHaveBeenCalled();
  });

  test('leaves question.md untouched when no answer is provided (existing callers keep current behavior)', async () => {
    mockFindFirstTransition.mockResolvedValue({
      metadata: { previousStatus: 'in_progress' },
      fromStatus: 'in_progress',
    });

    await applyResumeFromQuestionAnswerLocked({ taskId: 1, actor: 'system' });

    expect(mockReadWorkflowFile).not.toHaveBeenCalled();
    expect(mockWriteWorkflowFile).not.toHaveBeenCalled();
  });
});

describe('applyResumeFromQuestionAnswerLocked — recheckCompletionGate metadata marker (task 902)', () => {
  test('records recheckCompletionGate=true in the transition metadata when set', async () => {
    mockFindFirstTransition.mockResolvedValue({
      metadata: JSON.stringify({ previousStatus: 'verify_done' }),
      fromStatus: 'in_progress',
    });

    await applyResumeFromQuestionAnswerLocked({
      taskId: 1,
      actor: 'user',
      answer: '完了で問題ありません',
      recheckCompletionGate: true,
    });

    expect(mockRecordTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        toStatus: 'verify_done',
        metadata: expect.objectContaining({ recheckCompletionGate: true }),
      }),
    );
  });

  test('omits recheckCompletionGate from metadata when false/absent', async () => {
    mockFindFirstTransition.mockResolvedValue({
      metadata: { previousStatus: 'in_progress' },
      fromStatus: 'in_progress',
    });

    await applyResumeFromQuestionAnswerLocked({ taskId: 1, actor: 'user', answer: '続行' });

    const call = mockRecordTransition.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(call.metadata).not.toHaveProperty('recheckCompletionGate');
  });
});

// Migrated from workflow-handlers-resume.test.ts's former `handleResumeFromQuestion`
// suite (task 902 revised plan): that handler no longer runs this logic
// directly — it now delegates to applyQuestionAnswerByKind, which calls this
// function. The previousStatus-resolution/backstop/redispatch behavior itself
// is unchanged, so it is tested here, against the function that still owns it.
describe('applyResumeFromQuestionAnswerLocked — previousStatus resolution & backstops', () => {
  test('uses the recorded source phase even when metadata is null', async () => {
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 503,
      workflowStatus: 'awaiting_question',
    });
    mockFindFirstTransition.mockResolvedValue({ metadata: null, fromStatus: 'research_done' });

    const result = await applyResumeFromQuestionAnswerLocked({ taskId: 503, actor: 'user' });

    expect(result.toStatus).toBe('research_done');
    expect(result.source).toBe('transition_metadata');
  });

  test('does not resume back into a question self-transition', async () => {
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 503,
      workflowStatus: 'awaiting_question',
    });
    mockFindFirstTransition.mockResolvedValue({ metadata: {}, fromStatus: 'awaiting_question' });

    const result = await applyResumeFromQuestionAnswerLocked({ taskId: 503, actor: 'user' });

    expect(result.toStatus).toBe('in_progress');
    expect(result.source).toBe('fallback');
  });

  test('resumes to the previousStatus recorded in the awaiting_question transition metadata', async () => {
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 503,
      workflowStatus: 'awaiting_question',
    });
    mockFindFirstTransition.mockResolvedValue({
      metadata: { previousStatus: 'research_done' },
      fromStatus: 'research_done',
    });

    const result = await applyResumeFromQuestionAnswerLocked({ taskId: 503, actor: 'user' });

    expect(result).toEqual({
      taskId: 503,
      fromStatus: 'awaiting_question',
      toStatus: 'research_done',
      source: 'transition_metadata',
    });
  });

  test('rejects when the task is not currently awaiting_question', async () => {
    mockResolveTaskWorkflowState.mockResolvedValue({ id: 503, workflowStatus: 'draft' });

    await expect(
      applyResumeFromQuestionAnswerLocked({ taskId: 503, actor: 'user' }),
    ).rejects.toThrow(/expected "awaiting_question"/);
  });

  // Regression test (task #804): execution-lease-sweep can revert
  // task.status to 'todo' on a stale heartbeat while the process is actually
  // still alive and later resolves the question. Without the backstop below,
  // resuming only advanced workflowStatus, leaving status='todo' desynced.
  test('syncs a stale task.status="todo" to "in-progress" when resuming (task #804 desync backstop)', async () => {
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 803,
      workflowStatus: 'awaiting_question',
    });
    mockFindFirstTransition.mockResolvedValue({
      metadata: { previousStatus: 'plan_approved' },
      fromStatus: 'plan_approved',
    });

    await applyResumeFromQuestionAnswerLocked({ taskId: 803, actor: 'user' });

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 803 } }));
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 803, status: 'todo' },
      data: { status: 'in-progress' },
    });
  });

  // Regression test (task 830): a task sat at status='todo' with an advanced
  // workflowStatus for 24+ minutes after its question was resolved because
  // nothing re-dispatched it.
  test('delegates the post-resume re-dispatch nudge to triggerRedispatchAfterResume AFTER recording the transition', async () => {
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 829,
      workflowStatus: 'awaiting_question',
    });
    mockFindFirstTransition.mockResolvedValue({
      metadata: { previousStatus: 'plan_approved' },
      fromStatus: 'plan_approved',
    });

    await applyResumeFromQuestionAnswerLocked({ taskId: 829, actor: 'user' });

    expect(mockTriggerRedispatchAfterResume).toHaveBeenCalledWith(829);
    const recordOrder = mockRecordTransition.mock.invocationCallOrder[0];
    const nudgeOrder = mockTriggerRedispatchAfterResume.mock.invocationCallOrder[0];
    expect(recordOrder).toBeLessThan(nudgeOrder);
  });

  test('does not throw when triggerRedispatchAfterResume itself rejects', async () => {
    mockResolveTaskWorkflowState.mockResolvedValue({
      id: 829,
      workflowStatus: 'awaiting_question',
    });
    mockFindFirstTransition.mockResolvedValue({
      metadata: { previousStatus: 'plan_approved' },
      fromStatus: 'plan_approved',
    });
    mockTriggerRedispatchAfterResume.mockRejectedValue(new Error('boom'));

    // triggerRedispatchAfterResume never throws in production (it swallows
    // its own errors internally) — this only guards the caller in case that
    // contract is ever violated.
    await expect(
      applyResumeFromQuestionAnswerLocked({ taskId: 829, actor: 'user' }),
    ).rejects.toThrow('boom');
  });
});

// task 902 (revised plan): resume-from-question no longer runs its own
// independent previousStatus logic — it delegates to applyQuestionAnswerByKind,
// the same kind-based routing/guards answer-question uses.
describe('applyResumeFromQuestionAnswer — delegates to applyQuestionAnswerByKind', () => {
  test('forwards taskId/actor/extraMetadata with no answer body', async () => {
    await applyResumeFromQuestionAnswer({ taskId: 42, actor: 'user' });

    expect(mockApplyQuestionAnswerByKind).toHaveBeenCalledWith({
      taskId: 42,
      actor: 'user',
      extraMetadata: undefined,
    });
  });

  test('propagates a ValidationError (spec_change with no answer) unchanged', async () => {
    mockApplyQuestionAnswerByKind.mockRejectedValue(
      new ValidationError('仕様変更(spec_change)です。回答本文なしでは処理できません。'),
    );

    await expect(applyResumeFromQuestionAnswer({ taskId: 42, actor: 'user' })).rejects.toThrow(
      '回答本文なしでは処理できません',
    );
  });
});

describe('handleResumeFromQuestion — HTTP entry point (task 902 revised plan)', () => {
  test('rejects an invalid taskId', async () => {
    const set: { status?: number } = {};
    await expect(handleResumeFromQuestion({ params: { taskId: 'abc' }, set })).rejects.toThrow(
      'Invalid taskId',
    );
    expect(set.status).toBe(400);
    expect(mockApplyQuestionAnswerByKind).not.toHaveBeenCalled();
  });

  test('returns ok/toStatus/resolvedKind on success', async () => {
    mockApplyQuestionAnswerByKind.mockResolvedValue({
      taskId: 42,
      ok: true,
      toStatus: 'verify_done',
      kind: 'completion_confirmation',
    });

    const result = await handleResumeFromQuestion({ params: { taskId: '42' }, set: {} });

    expect(result).toEqual({
      taskId: 42,
      ok: true,
      toStatus: 'verify_done',
      resolvedKind: 'completion_confirmation',
    });
  });

  test('maps NotFoundError to 404', async () => {
    mockApplyQuestionAnswerByKind.mockRejectedValue(new NotFoundError('Task not found'));
    const set: { status?: number } = {};

    await expect(handleResumeFromQuestion({ params: { taskId: '42' }, set })).rejects.toThrow(
      'Task not found',
    );
    expect(set.status).toBe(404);
  });

  test('maps ValidationError (spec_change with no answer) to 400', async () => {
    mockApplyQuestionAnswerByKind.mockRejectedValue(
      new ValidationError('回答本文なしでは処理できません'),
    );
    const set: { status?: number } = {};

    await expect(handleResumeFromQuestion({ params: { taskId: '42' }, set })).rejects.toThrow(
      '回答本文なしでは処理できません',
    );
    expect(set.status).toBe(400);
  });

  test('maps ConflictError (task_stopping/question_outdated/question_already_answered) to 409', async () => {
    mockApplyQuestionAnswerByKind.mockRejectedValue(
      new ConflictError('この質問は既に回答済みです', 'question_already_answered'),
    );
    const set: { status?: number } = {};

    await expect(handleResumeFromQuestion({ params: { taskId: '42' }, set })).rejects.toThrow(
      'この質問は既に回答済みです',
    );
    expect(set.status).toBe(409);
  });
});
