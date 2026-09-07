import { describe, expect, it } from 'bun:test';
import { eligibleTopLevelTodoWhere } from './auto-run-eligibility';

describe('eligibleTopLevelTodoWhere', () => {
  it('returns the base runnable-todo shape for a theme', () => {
    expect(eligibleTopLevelTodoWhere(7)).toEqual({
      themeId: 7,
      status: 'todo',
      parentId: null,
      workflowDisabled: false,
      OR: [{ workflowStatus: null }, { workflowStatus: { not: 'awaiting_question' } }],
    });
  });

  it('merges extra clauses onto the base shape', () => {
    expect(eligibleTopLevelTodoWhere(7, { autoCreatedFromBacklog: false })).toEqual({
      themeId: 7,
      status: 'todo',
      parentId: null,
      workflowDisabled: false,
      OR: [{ workflowStatus: null }, { workflowStatus: { not: 'awaiting_question' } }],
      autoCreatedFromBacklog: false,
    });
  });
});
