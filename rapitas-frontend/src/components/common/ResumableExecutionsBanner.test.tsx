/**
 * ResumableExecutionsBanner — render guards
 *
 * The banner must never paint an interrupted/in-progress card with nothing in
 * it: a stale connectionError while the backend is connected used to do that.
 */
import { render, screen } from '@testing-library/react';
import { ResumableExecutionsBanner } from './ResumableExecutionsBanner';
import type { UseResumableExecutionsReturn } from '../resumable-executions/useResumableExecutions';

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('@/stores/task-detail-visibility-store', () => ({
  useTaskDetailVisibilityStore: (sel: (s: { isTaskDetailVisible: boolean }) => unknown) =>
    sel({ isTaskDetailVisible: false }),
}));
vi.mock('@/stores/server-restart-store', () => ({
  useServerRestartStore: (sel: (s: { isRestarting: boolean }) => unknown) =>
    sel({ isRestarting: false }),
}));
vi.mock('../resumable-executions/ExecutionItem', () => ({
  ExecutionItem: () => <div data-testid="execution-item" />,
}));
vi.mock('../resumable-executions/QuickActions', () => ({
  QuickActions: () => <div data-testid="quick-actions" />,
}));

const hookState: Partial<UseResumableExecutionsReturn> = {};
vi.mock('../resumable-executions/useResumableExecutions', () => ({
  useResumableExecutions: () => hookState,
}));

function setHook(overrides: Partial<UseResumableExecutionsReturn>) {
  const base: UseResumableExecutionsReturn = {
    executions: [],
    isLoading: false,
    isDismissed: false,
    resumingIds: new Set(),
    dismissingIds: new Set(),
    connectionError: null,
    isConnected: true,
    isIntentionalRestart: false,
    runningCount: 0,
    interruptedCount: 0,
    setIsDismissed: vi.fn(),
    setConnectionError: vi.fn(),
    fetchResumableExecutions: vi.fn().mockResolvedValue([]),
    handleResume: vi.fn(),
    handleDismiss: vi.fn(),
    handleDismissAll: vi.fn(),
    handleResumeAll: vi.fn(),
    formatTimeAgo: () => 'now',
  };
  for (const key of Object.keys(hookState)) delete (hookState as Record<string, unknown>)[key];
  Object.assign(hookState, base, overrides);
}

describe('ResumableExecutionsBanner', () => {
  it('renders nothing when there are no executions and no error', () => {
    setHook({});
    const { container } = render(<ResumableExecutionsBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a stale error while the backend is connected (0 interrupted)', () => {
    setHook({ connectionError: new Error('timeout'), isConnected: true });
    const { container } = render(<ResumableExecutionsBanner />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('interruptedWork')).toBeNull();
  });

  it('renders the connection-error card only when actually disconnected', () => {
    setHook({ connectionError: new Error('down'), isConnected: false });
    render(<ResumableExecutionsBanner />);
    expect(screen.getByText('connectionError')).toBeInTheDocument();
    expect(screen.queryByText('interruptedWork')).toBeNull();
  });

  it('renders the interrupted card with its count when work exists', () => {
    setHook({
      executions: [
        {
          id: 1,
          taskId: 10,
          status: 'interrupted',
          canResume: true,
        } as UseResumableExecutionsReturn['executions'][number],
      ],
      interruptedCount: 1,
    });
    render(<ResumableExecutionsBanner />);
    expect(screen.getByText('interruptedWork')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('sits at the bottom edge now that the floating AI icon is gone', () => {
    setHook({
      executions: [
        {
          id: 2,
          taskId: 11,
          status: 'running',
          canResume: false,
        } as UseResumableExecutionsReturn['executions'][number],
      ],
      runningCount: 1,
    });
    const { container } = render(<ResumableExecutionsBanner />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('bottom-6');
    expect(root.className).not.toContain('bottom-20');
  });
});
