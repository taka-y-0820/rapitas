import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { SystemStatusPanel } from '../SystemStatusPanel';
import { setAppHidden } from '@/hooks/common/app-visibility-store';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock('@/utils/api', () => ({
  API_BASE_URL: 'http://test:3001',
}));

describe('SystemStatusPanel', () => {
  const mockFetch = vi.fn();

  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    setHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setAppHidden(false);
  });

  it('renders nothing before the first /health response arrives', () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(<SystemStatusPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a healthy pill and the tile values from /health', async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        status: 'healthy',
        uptimeSeconds: 3725,
        activeExecutions: 0,
        runningExecutions: 2,
        interruptedExecutions: 0,
        queueDepth: 3,
        activePreviewCount: 1,
      }),
    });

    render(<SystemStatusPanel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockFetch).toHaveBeenCalledWith('http://test:3001/health');
    expect(screen.getByText('systemStatus.pill.healthy')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument(); // running
    expect(screen.getByText('3')).toBeInTheDocument(); // queue depth
    expect(screen.getByText('1')).toBeInTheDocument(); // active preview sessions
    expect(screen.getByText('1h 2m')).toBeInTheDocument(); // uptime
  });

  it('derives a busy pill when executions are actively running', async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        status: 'healthy',
        uptimeSeconds: 10,
        activeExecutions: 1,
        runningExecutions: 1,
        interruptedExecutions: 0,
        queueDepth: 0,
      }),
    });

    render(<SystemStatusPanel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText('systemStatus.pill.busy')).toBeInTheDocument();
  });

  it('derives an interrupted pill when interruptedExecutions > 0', async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        status: 'healthy',
        uptimeSeconds: 10,
        activeExecutions: 0,
        runningExecutions: 0,
        interruptedExecutions: 2,
        queueDepth: 0,
      }),
    });

    render(<SystemStatusPanel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText('systemStatus.pill.interrupted')).toBeInTheDocument();
  });

  // Counter-example from task 913: a failed resumable-interrupted computation on
  // the backend must never render as the healthy pill, even when raw counts are 0.
  it("shows the 'unknown' pill when interruptedExecutionsDegraded is true, even with status='healthy' and interruptedExecutions=0", async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        status: 'healthy',
        uptimeSeconds: 10,
        activeExecutions: 0,
        runningExecutions: 0,
        interruptedExecutions: 0,
        interruptedExecutionsDegraded: true,
        queueDepth: 0,
      }),
    });

    render(<SystemStatusPanel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText('systemStatus.pill.unknown')).toBeInTheDocument();
    expect(screen.queryByText('systemStatus.pill.healthy')).not.toBeInTheDocument();
  });

  it('shows an unhealthy pill when the fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));

    render(<SystemStatusPanel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText('systemStatus.pill.unhealthy')).toBeInTheDocument();
  });

  it.each([0, 1])('shows unknown when live ownership is unavailable, count=%s', async (count) => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        status: 'healthy',
        activeExecutions: count,
        runningExecutions: count,
        activeExecutionsDegraded: true,
        interruptedExecutions: 0,
      }),
    });
    render(<SystemStatusPanel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('systemStatus.pill.unknown')).toBeInTheDocument();
    expect(screen.queryByText('systemStatus.pill.healthy')).not.toBeInTheDocument();
    expect(screen.queryByText('systemStatus.pill.busy')).not.toBeInTheDocument();
  });

  it('re-polls every 10s but skips the request while the tab is hidden', async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        status: 'healthy',
        uptimeSeconds: 10,
        activeExecutions: 0,
        runningExecutions: 0,
        interruptedExecutions: 0,
        queueDepth: 0,
      }),
    });

    render(<SystemStatusPanel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    setHidden(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    setHidden(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('polls immediately when restored from minimize', async () => {
    setAppHidden(true);
    mockFetch.mockResolvedValue({
      json: async () => ({
        status: 'healthy',
        uptimeSeconds: 10,
        activeExecutions: 0,
        runningExecutions: 0,
        interruptedExecutions: 0,
        queueDepth: 0,
      }),
    });

    render(<SystemStatusPanel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockFetch).not.toHaveBeenCalled();

    await act(async () => {
      setAppHidden(false);
    });

    expect(mockFetch).toHaveBeenCalledWith('http://test:3001/health');
  });

  it('cleans up the polling interval on unmount', async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        status: 'healthy',
        uptimeSeconds: 10,
        activeExecutions: 0,
        runningExecutions: 0,
        interruptedExecutions: 0,
        queueDepth: 0,
      }),
    });

    const { unmount } = render(<SystemStatusPanel />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
