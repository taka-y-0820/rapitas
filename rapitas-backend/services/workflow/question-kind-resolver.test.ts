import { describe, expect, test } from 'bun:test';
import {
  resolveExplicitOrDefaultKind,
  resolveQuestionAnswerStrategy,
  readQuestionMetadata,
} from './question-kind-resolver';

test.each([null, undefined, '', '{', 'null', '[]', '42'])(
  'invalid or non-object metadata %p uses the legacy fallback',
  (value) => {
    expect(readQuestionMetadata(value)).toEqual({});
  },
);

describe('resolveExplicitOrDefaultKind', () => {
  test('intake_question always resolves to spec_change regardless of explicitKind', () => {
    expect(
      resolveExplicitOrDefaultKind({
        cause: 'intake_question',
        explicitKind: 'completion_confirmation',
        currentStatus: 'draft',
      }),
    ).toBe('spec_change');
  });

  test('intake_question resolves to spec_change with no explicitKind', () => {
    expect(resolveExplicitOrDefaultKind({ cause: 'intake_question', currentStatus: 'draft' })).toBe(
      'spec_change',
    );
  });

  test('explicit execution_continuation is honored for a non-intake cause', () => {
    expect(
      resolveExplicitOrDefaultKind({
        cause: 'file_saved:question',
        explicitKind: 'execution_continuation',
        currentStatus: 'verify_done',
      }),
    ).toBe('execution_continuation');
  });

  test('explicit completion_confirmation is honored for a non-intake cause', () => {
    expect(
      resolveExplicitOrDefaultKind({
        cause: 'file_saved:question',
        explicitKind: 'completion_confirmation',
        currentStatus: 'in_progress',
      }),
    ).toBe('completion_confirmation');
  });

  test('defaults to completion_confirmation when currentStatus is verify_done and no explicit kind', () => {
    expect(
      resolveExplicitOrDefaultKind({ cause: 'file_saved:question', currentStatus: 'verify_done' }),
    ).toBe('completion_confirmation');
  });

  test('defaults to execution_continuation for any other status with no explicit kind', () => {
    expect(
      resolveExplicitOrDefaultKind({ cause: 'file_saved:question', currentStatus: 'in_progress' }),
    ).toBe('execution_continuation');
  });

  test('an explicit spec_change from a non-intake cause is ignored (not a valid explicit value)', () => {
    expect(
      resolveExplicitOrDefaultKind({
        cause: 'file_saved:question',
        explicitKind: 'spec_change',
        currentStatus: 'verify_done',
      }),
    ).toBe('completion_confirmation');
  });

  test('an invalid/unknown explicitKind falls back to the default derivation', () => {
    expect(
      resolveExplicitOrDefaultKind({
        cause: 'file_saved:question',
        explicitKind: 'not_a_real_kind',
        currentStatus: 'in_progress',
      }),
    ).toBe('execution_continuation');
  });

  test('missing cause with no explicit kind falls back to the default derivation', () => {
    expect(resolveExplicitOrDefaultKind({ cause: null, currentStatus: 'verify_done' })).toBe(
      'completion_confirmation',
    );
  });
});

describe('resolveQuestionAnswerStrategy', () => {
  test('spec_change maps to reset_draft', () => {
    expect(resolveQuestionAnswerStrategy('spec_change')).toBe('reset_draft');
  });

  test('execution_continuation maps to resume_previous_with_answer', () => {
    expect(resolveQuestionAnswerStrategy('execution_continuation')).toBe(
      'resume_previous_with_answer',
    );
  });

  test('completion_confirmation maps to resume_previous_no_gate', () => {
    expect(resolveQuestionAnswerStrategy('completion_confirmation')).toBe(
      'resume_previous_no_gate',
    );
  });
});
