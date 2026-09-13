/**
 * TaskExecutionDrilldownModal.test
 *
 * Covers the drilldown modal (task 870): closed when taskId is null, loading
 * state, rendering the derived state/repair count/transitions on success,
 * the error state on a failed fetch, and the export link's href.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { TaskExecutionDrilldownModal } from './TaskExecutionDrilldownModal';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe('TaskExecutionDrilldownModal', () => {
  it('renders nothing when taskId is null', () => {
    render(<TaskExecutionDrilldownModal taskId={null} onClose={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the derived state, repair count, and transitions on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          taskId: 870,
          title: 'テストタスク',
          state: 'repairing',
          repairCount: 2,
          frequentFailure: false,
          stalled: false,
          elapsedMinutes: 4,
          currentPhase: 'verify',
          transitions: [
            {
              id: 1,
              fromStatus: null,
              toStatus: 'running',
              cause: 'auto_advance',
              phase: 'implement',
              actor: 'system',
              createdAt: '2026-09-07T09:00:00.000Z',
            },
          ],
        }),
    }) as unknown as typeof fetch;

    render(<TaskExecutionDrilldownModal taskId={870} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/drilldownRepairCount/)).toBeTruthy());
    expect(screen.getByText(/running/)).toBeTruthy();
    const csvLink = screen.getByText('exportCsvButton').closest('a');
    expect(csvLink?.getAttribute('href')).toContain(
      '/workflow/execution-dashboard/export?taskId=870',
    );
    const jsonLink = screen.getByText('exportJsonButton').closest('a');
    expect(jsonLink?.getAttribute('href')).toContain(
      '/workflow/execution-dashboard/export?taskId=870&format=json',
    );
  });

  it('shows the error state when the fetch fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network error')) as unknown as typeof fetch;

    render(<TaskExecutionDrilldownModal taskId={870} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('drilldownLoadFailed')).toBeTruthy());
  });
});
