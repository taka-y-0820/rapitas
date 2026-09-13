/**
 * useExecutionDashboardData.test
 *
 * Covers the polling hook (task 870): fetches on mount, re-polls every 10s
 * while visible, skips the request while the tab/app is hidden, and re-polls
 * immediately on restore from minimize (same contract as SystemStatusPanel's
 * poller — see its test for the reference pattern).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useExecutionDashboardData } from './useExecutionDashboardData';
import { setAppHidden } from '@/hooks/common/app-visibility-store';

vi.mock('@/utils/api', () => ({
  API_BASE_URL: 'http://test:3001',
}));

describe('useExecutionDashboardData', () => {
  const mockFetch = vi.fn();

  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  };

  const okResponse = () => ({
    json: async () => ({
      success: true,
      stallThresholdMinutes: 5,
      totalActiveCount: 0,
      truncated: false,
      tasks: [],
    }),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okResponse());
    setHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setAppHidden(false);
  });

  it('fetches the dashboard list on mount and sets loaded=true', async () => {
    const { result } = renderHook(() => useExecutionDashboardData());
    expect(result.current.loaded).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(mockFetch).toHaveBeenCalledWith('http://test:3001/workflow/execution-dashboard');
    expect(result.current.loaded).toBe(true);
    expect(result.current.data?.success).toBe(true);
  });

  it('re-polls every 10s but skips while the tab is hidden', async () => {
    renderHook(() => useExecutionDashboardData());
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
    renderHook(() => useExecutionDashboardData());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockFetch).not.toHaveBeenCalled();

    await act(async () => {
      setAppHidden(false);
    });

    expect(mockFetch).toHaveBeenCalledWith('http://test:3001/workflow/execution-dashboard');
  });

  it('sets data to null and loaded=true when the fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    const { result } = renderHook(() => useExecutionDashboardData());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.loaded).toBe(true);
    expect(result.current.data).toBeNull();
  });

  it('cleans up the polling interval on unmount', async () => {
    const { unmount } = renderHook(() => useExecutionDashboardData());
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
