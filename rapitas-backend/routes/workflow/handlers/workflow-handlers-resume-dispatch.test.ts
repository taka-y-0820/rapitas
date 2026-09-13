/**
 * workflow-handlers-resume-dispatch.test
 *
 * Covers applyQuestionAnswerByKind: kind resolution (recorded vs derived vs
 * explicit-in-metadata), strategy routing to the intake/resume appliers, and
 * the three competing-answer conflict guards (task_stopping, question_outdated,
 * question_already_answered).
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test';

const mockFindFirstTransition = mock(() => Promise.resolve<Record<string, unknown> | null>(null));
const mockUpdateMany = mock(() => Promise.resolve({ count: 1 }));
mock.module('../../../config', () => ({
  prisma: {
    workflowTransition: { findFirst: mockFindFirstTransition },
    task: { updateMany: mockUpdateMany },
  },
}));

mock.module('../../../middleware/error-handler', () => ({
  NotFoundError: class NotFoundError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'NotFoundError';
    }
  },
  ValidationError: class ValidationError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'ValidationError';
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

const mockIsLatestExecutionCancelled = mock(() => Promise.resolve(false));
mock.module('../../../services/workflow/publication-cancellation-guard', () => ({
  isLatestExecutionCancelled: mockIsLatestExecutionCancelled,
}));

const mockApplyIntakeQuestionAnswerLocked = mock(() =>
  Promise.resolve({ taskId: 1, ok: true as const, toStatus: 'draft' as const }),
);
mock.module('./workflow-handlers-resume', () => ({
  applyIntakeQuestionAnswerLocked: mockApplyIntakeQuestionAnswerLocked,
}));

const mockApplyResumeFromQuestionAnswerLocked = mock(() =>
  Promise.resolve({
    taskId: 1,
    fromStatus: 'awaiting_question' as const,
    toStatus: 'in_progress' as const,
    source: 'transition_metadata' as const,
  }),
);
mock.module('./workflow-handlers-resume-continuation', () => ({
  applyResumeFromQuestionAnswerLocked: mockApplyResumeFromQuestionAnswerLocked,
}));

const { applyQuestionAnswerByKind } = await import('./workflow-handlers-resume-dispatch');

const BASE_PARAMS = {
  taskId: 1,
  answer: '回答本文',
  actor: 'user' as const,
  sourceLabel: 'ユーザー選択',
};

beforeEach(() => {
  mockFindFirstTransition.mockReset();
  mockUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  mockIsLatestExecutionCancelled.mockReset().mockResolvedValue(false);
  mockApplyIntakeQuestionAnswerLocked
    .mockReset()
    .mockResolvedValue({ taskId: 1, ok: true, toStatus: 'draft' });
  mockApplyResumeFromQuestionAnswerLocked.mockReset().mockResolvedValue({
    taskId: 1,
    fromStatus: 'awaiting_question',
    toStatus: 'in_progress',
    source: 'transition_metadata',
  });
});

describe('applyQuestionAnswerByKind — kind resolution and routing', () => {
  test('cause=intake_question resolves spec_change and calls applyIntakeQuestionAnswerLocked', async () => {
    mockFindFirstTransition.mockResolvedValue({
      id: 1,
      cause: 'intake_question',
      fromStatus: 'draft',
      metadata: {},
    });

    const result = await applyQuestionAnswerByKind(BASE_PARAMS);

    expect(result.kind).toBe('spec_change');
    expect(mockApplyIntakeQuestionAnswerLocked).toHaveBeenCalledTimes(1);
    expect(mockApplyResumeFromQuestionAnswerLocked).not.toHaveBeenCalled();
    const call = mockApplyIntakeQuestionAnswerLocked.mock.calls[0][0] as { extraMetadata?: object };
    expect(call.extraMetadata).toEqual({ kind: 'spec_change' });
  });

  test('cause=file_saved:question with previousStatus!=verify_done resolves execution_continuation, recheckCompletionGate=false', async () => {
    mockFindFirstTransition.mockResolvedValue({
      id: 2,
      cause: 'file_saved:question',
      fromStatus: 'in_progress',
      metadata: { previousStatus: 'in_progress' },
    });

    const result = await applyQuestionAnswerByKind(BASE_PARAMS);

    expect(result.kind).toBe('execution_continuation');
    expect(mockApplyResumeFromQuestionAnswerLocked).toHaveBeenCalledTimes(1);
    expect(mockApplyIntakeQuestionAnswerLocked).not.toHaveBeenCalled();
    const call = mockApplyResumeFromQuestionAnswerLocked.mock.calls[0][0] as {
      recheckCompletionGate?: boolean;
      answer?: string;
    };
    expect(call.recheckCompletionGate).toBe(false);
    expect(call.answer).toBe('回答本文');
  });

  test('cause=file_saved:question with previousStatus=verify_done resolves completion_confirmation, recheckCompletionGate=true', async () => {
    mockFindFirstTransition.mockResolvedValue({
      id: 3,
      cause: 'file_saved:question',
      fromStatus: 'verify_done',
      metadata: { previousStatus: 'verify_done' },
    });

    const result = await applyQuestionAnswerByKind(BASE_PARAMS);

    expect(result.kind).toBe('completion_confirmation');
    const call = mockApplyResumeFromQuestionAnswerLocked.mock.calls[0][0] as {
      recheckCompletionGate?: boolean;
    };
    expect(call.recheckCompletionGate).toBe(true);
  });

  test('an explicit kind recorded in metadata is honored over the derived default', async () => {
    mockFindFirstTransition.mockResolvedValue({
      id: 4,
      cause: 'file_saved:question',
      fromStatus: 'verify_done',
      metadata: JSON.stringify({ previousStatus: 'verify_done', kind: 'execution_continuation' }),
    });

    const result = await applyQuestionAnswerByKind(BASE_PARAMS);

    expect(result.kind).toBe('execution_continuation');
  });
});

// task 902 (revised plan): resume-from-question calls this with no answer
// body. execution_continuation/completion_confirmation must accept that;
// spec_change must not silently treat an unconfirmed change as answered.
describe('applyQuestionAnswerByKind — answer is optional except for spec_change', () => {
  test('execution_continuation succeeds with no answer provided', async () => {
    mockFindFirstTransition.mockResolvedValue({
      id: 5,
      cause: 'file_saved:question',
      fromStatus: 'in_progress',
      metadata: { previousStatus: 'in_progress' },
    });

    const result = await applyQuestionAnswerByKind({
      taskId: 1,
      actor: 'user',
    });

    expect(result.kind).toBe('execution_continuation');
    expect(mockApplyResumeFromQuestionAnswerLocked).toHaveBeenCalledTimes(1);
    const call = mockApplyResumeFromQuestionAnswerLocked.mock.calls[0][0] as { answer?: string };
    expect(call.answer).toBeUndefined();
  });

  test('completion_confirmation succeeds with no answer provided', async () => {
    mockFindFirstTransition.mockResolvedValue({
      id: 6,
      cause: 'file_saved:question',
      fromStatus: 'verify_done',
      metadata: { previousStatus: 'verify_done' },
    });

    const result = await applyQuestionAnswerByKind({
      taskId: 1,
      actor: 'user',
    });

    expect(result.kind).toBe('completion_confirmation');
    expect(mockApplyResumeFromQuestionAnswerLocked).toHaveBeenCalledTimes(1);
  });

  test('spec_change with no answer is rejected with a ValidationError and applies no state change', async () => {
    mockFindFirstTransition.mockResolvedValue({
      id: 7,
      cause: 'intake_question',
      fromStatus: 'draft',
      metadata: {},
    });

    await expect(applyQuestionAnswerByKind({ taskId: 1, actor: 'user' })).rejects.toThrow(
      '回答本文なしでは処理できません',
    );
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockApplyIntakeQuestionAnswerLocked).not.toHaveBeenCalled();
    expect(mockApplyResumeFromQuestionAnswerLocked).not.toHaveBeenCalled();
  });

  test('spec_change with an empty-string answer is rejected the same as no answer', async () => {
    mockFindFirstTransition.mockResolvedValue({
      id: 8,
      cause: 'intake_question',
      fromStatus: 'draft',
      metadata: {},
    });

    await expect(
      applyQuestionAnswerByKind({ taskId: 1, actor: 'user', answer: '' }),
    ).rejects.toThrow('回答本文なしでは処理できません');
    expect(mockApplyIntakeQuestionAnswerLocked).not.toHaveBeenCalled();
  });

  test('an existing required-answer call (auto-answer heal pass shape) still works unchanged', async () => {
    mockFindFirstTransition.mockResolvedValue({
      id: 9,
      cause: 'intake_question',
      fromStatus: 'draft',
      metadata: {},
    });

    const result = await applyQuestionAnswerByKind(BASE_PARAMS);

    expect(result.kind).toBe('spec_change');
    expect(mockApplyIntakeQuestionAnswerLocked).toHaveBeenCalledTimes(1);
  });
});

describe('applyQuestionAnswerByKind — conflict guards', () => {
  test('throws NotFoundError when no awaiting_question transition is on record', async () => {
    mockFindFirstTransition.mockResolvedValue(null);

    await expect(applyQuestionAnswerByKind(BASE_PARAMS)).rejects.toThrow(
      'No pending question found',
    );
    expect(mockApplyIntakeQuestionAnswerLocked).not.toHaveBeenCalled();
    expect(mockApplyResumeFromQuestionAnswerLocked).not.toHaveBeenCalled();
  });

  test('task_stopping: rejects and applies no state change when the latest execution is cancelled', async () => {
    mockFindFirstTransition.mockResolvedValue({
      id: 1,
      cause: 'intake_question',
      fromStatus: 'draft',
      metadata: {},
    });
    mockIsLatestExecutionCancelled.mockResolvedValue(true);

    await expect(applyQuestionAnswerByKind(BASE_PARAMS)).rejects.toThrow(
      'タスクの実行が停止されています',
    );
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockApplyIntakeQuestionAnswerLocked).not.toHaveBeenCalled();
    expect(mockApplyResumeFromQuestionAnswerLocked).not.toHaveBeenCalled();
  });

  test('question_outdated: rejects when a newer awaiting_question pause has superseded the captured one', async () => {
    let call = 0;
    mockFindFirstTransition.mockImplementation(() => {
      call++;
      // First call ("target") returns id=1; second call (staleness re-check)
      // returns a NEWER pause (id=2) — simulating a heal-pass re-pause that
      // landed between the two reads.
      if (call === 1) {
        return Promise.resolve({
          id: 1,
          cause: 'intake_question',
          fromStatus: 'draft',
          metadata: {},
        });
      }
      return Promise.resolve({ id: 2 });
    });

    await expect(applyQuestionAnswerByKind(BASE_PARAMS)).rejects.toThrow(
      'この質問は既に別の質問に置き換わっています',
    );
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockApplyIntakeQuestionAnswerLocked).not.toHaveBeenCalled();
    expect(mockApplyResumeFromQuestionAnswerLocked).not.toHaveBeenCalled();
  });

  test('question_already_answered: rejects when the CAS touch finds 0 rows (a concurrent answer already landed)', async () => {
    mockFindFirstTransition.mockResolvedValue({
      id: 1,
      cause: 'intake_question',
      fromStatus: 'draft',
      metadata: {},
    });
    mockUpdateMany.mockResolvedValue({ count: 0 });

    await expect(applyQuestionAnswerByKind(BASE_PARAMS)).rejects.toThrow(
      'この質問は既に回答済みです',
    );
    expect(mockApplyIntakeQuestionAnswerLocked).not.toHaveBeenCalled();
    expect(mockApplyResumeFromQuestionAnswerLocked).not.toHaveBeenCalled();
  });
});
