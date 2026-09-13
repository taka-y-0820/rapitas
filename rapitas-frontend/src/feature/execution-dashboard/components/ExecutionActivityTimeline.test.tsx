/**
 * ExecutionActivityTimeline.test
 *
 * Covers the activity feed (task 870): empty state, most-recently-updated-first
 * ordering, stalled/frequent-failure badge visibility, and row-click wiring.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { ExecutionActivityTimeline } from './ExecutionActivityTimeline';
import type { ExecutionDashboardTask } from '../useExecutionDashboardData';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

function task(overrides: Partial<ExecutionDashboardTask>): ExecutionDashboardTask {
  return {
    taskId: 1,
    title: 'テストタスク',
    state: 'running',
    repairCount: 0,
    frequentFailure: false,
    stalled: false,
    elapsedMinutes: 3,
    currentPhase: 'implement',
    themeId: null,
    updatedAt: '2026-09-07T09:00:00.000Z',
    ...overrides,
  };
}

describe('ExecutionActivityTimeline', () => {
  it('shows the empty state when there are no tasks', () => {
    render(<ExecutionActivityTimeline tasks={[]} onSelectTask={vi.fn()} />);
    expect(screen.getByText('emptyState')).toBeTruthy();
  });

  it('orders rows by most-recently-updated first', () => {
    const tasks = [
      task({ taskId: 1, title: '古いタスク', updatedAt: '2026-09-07T08:00:00.000Z' }),
      task({ taskId: 2, title: '新しいタスク', updatedAt: '2026-09-07T09:00:00.000Z' }),
    ];
    render(<ExecutionActivityTimeline tasks={tasks} onSelectTask={vi.fn()} />);
    const titles = screen.getAllByRole('button').map((btn) => btn.textContent ?? '');
    expect(titles[0]).toContain('新しいタスク');
    expect(titles[1]).toContain('古いタスク');
  });

  it('shows the stalled badge only when stalled=true', () => {
    render(<ExecutionActivityTimeline tasks={[task({ stalled: true })]} onSelectTask={vi.fn()} />);
    expect(screen.getByText('stalledBadge')).toBeTruthy();
  });

  it('hides the stalled badge when stalled=false', () => {
    render(<ExecutionActivityTimeline tasks={[task({ stalled: false })]} onSelectTask={vi.fn()} />);
    expect(screen.queryByText('stalledBadge')).toBeNull();
  });

  it('shows the frequent-failure badge with the repair count only when frequentFailure=true', () => {
    render(
      <ExecutionActivityTimeline
        tasks={[task({ frequentFailure: true, repairCount: 3 })]}
        onSelectTask={vi.fn()}
      />,
    );
    expect(screen.getByText('frequentFailureBadge:{"count":3}')).toBeTruthy();
  });

  it('calls onSelectTask with the clicked task id', () => {
    const onSelectTask = vi.fn();
    render(
      <ExecutionActivityTimeline tasks={[task({ taskId: 42 })]} onSelectTask={onSelectTask} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onSelectTask).toHaveBeenCalledWith(42);
  });
});
