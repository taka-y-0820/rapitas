/**
 * useWorkflowHandlers — live status sync
 *
 * The header badge renders `currentWorkflowStatus`; it must follow whichever
 * external source (files endpoint or polled task record) changed most recently.
 */
import { renderHook } from '@testing-library/react';
import type { WorkflowStatus } from '@/types';
import { useWorkflowHandlers } from '../useWorkflowHandlers';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

type Props = {
  workflowStatus: WorkflowStatus | null;
  taskWorkflowStatus: WorkflowStatus | null;
};

function render(initial: Props) {
  return renderHook(
    (props: Props) =>
      useWorkflowHandlers({
        taskId: 1,
        workflowStatus: props.workflowStatus,
        taskWorkflowStatus: props.taskWorkflowStatus,
        refetchWorkflowFiles: vi.fn(),
        restoreExecutionState: vi.fn().mockResolvedValue(null),
      }),
    { initialProps: initial },
  );
}

describe('useWorkflowHandlers status sync', () => {
  it('seeds from the files endpoint status', () => {
    const { result } = render({ workflowStatus: 'research_done', taskWorkflowStatus: null });
    expect(result.current.currentWorkflowStatus).toBe('research_done');
  });

  it('follows the polled task status when it changes after the files status', () => {
    const { result, rerender } = render({
      workflowStatus: 'plan_created',
      taskWorkflowStatus: 'plan_created',
    });
    rerender({ workflowStatus: 'plan_created', taskWorkflowStatus: 'plan_approved' });
    expect(result.current.currentWorkflowStatus).toBe('plan_approved');
  });

  it('follows the files status when it changes after the task status', () => {
    const { result, rerender } = render({
      workflowStatus: 'plan_created',
      taskWorkflowStatus: 'plan_created',
    });
    rerender({ workflowStatus: 'in_progress', taskWorkflowStatus: 'plan_created' });
    expect(result.current.currentWorkflowStatus).toBe('in_progress');
  });

  it('does not let an unchanged stale source overwrite a newer local status', () => {
    const { result, rerender } = render({
      workflowStatus: 'plan_created',
      taskWorkflowStatus: 'plan_created',
    });
    rerender({ workflowStatus: 'plan_created', taskWorkflowStatus: 'in_progress' });
    // A re-render where only unrelated props change keeps the newest value.
    rerender({ workflowStatus: 'plan_created', taskWorkflowStatus: 'in_progress' });
    expect(result.current.currentWorkflowStatus).toBe('in_progress');
  });

  it('ignores null sources', () => {
    const { result, rerender } = render({ workflowStatus: 'draft', taskWorkflowStatus: null });
    rerender({ workflowStatus: null, taskWorkflowStatus: null });
    expect(result.current.currentWorkflowStatus).toBe('draft');
  });
});
