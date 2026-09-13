import { renderHook, act } from '@testing-library/react';
import { useBackendHealth } from '../common/useBackendHealth';
import { sharedEventSource } from '@/lib/sse/shared-event-source';
import { useServerRestartStore } from '@/stores/server-restart-store';
import { setAppHidden } from '../common/app-visibility-store';

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/utils/api', () => ({
  API_BASE_URL: 'http://test:3001',
}));

// The hook subscribes to the shared EventSource; mock it so the suite never
// touches a real EventSource (undefined in jsdom). subscribe returns its
// unsubscribe cleanup.
vi.mock('@/lib/sse/shared-event-source', () => ({
  sharedEventSource: { subscribe: vi.fn(() => vi.fn()) },
}));

describe('useBackendHealth', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
    vi.mocked(sharedEventSource.subscribe).mockClear();
    useServerRestartStore.getState().setRestarting(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setAppHidden(false);
  });

  it('should have initial status of checking', () => {
    mockFetch.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useBackendHealth());
    expect(result.current.status).toBe('checking');
  });

  it('should set connected on successful health check', async () => {
    mockFetch.mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useBackendHealth());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.status).toBe('connected');
    expect(result.current.isConnected).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test:3001/events/status',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('should set disconnected on failed health check', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const { result } = renderHook(() => useBackendHealth({ disconnectThreshold: 1 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.status).toBe('disconnected');
    expect(result.current.isConnected).toBe(false);
  });

  it('keeps checking after a single failure and flips only at the default threshold', async () => {
    // NOTE: one failed probe is treated as a load spike (2026-09-02 modal-loop
    // incident); the visible state flips only after disconnectThreshold (2) misses.
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const { result } = renderHook(() => useBackendHealth({ intervalMs: 1000 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe('checking');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.status).toBe('disconnected');
  });

  it('should set disconnected on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const { result } = renderHook(() => useBackendHealth({ disconnectThreshold: 1 }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.status).toBe('disconnected');
  });

  it('should call onDisconnectAction when disconnecting', async () => {
    const onDisconnectAction = vi.fn();
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    renderHook(() => useBackendHealth({ disconnectThreshold: 1, onDisconnectAction }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onDisconnectAction).toHaveBeenCalledTimes(1);
  });

  it('should call onReconnectAction when recovering from disconnect', async () => {
    const onReconnectAction = vi.fn();

    // First call fails
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

    const { result } = renderHook(() =>
      useBackendHealth({
        disconnectThreshold: 1,
        onReconnectAction,
        intervalMs: 5000,
        retryIntervalMs: 2000,
      }),
    );

    // Initial check - fails
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.status).toBe('disconnected');

    // Next call succeeds
    mockFetch.mockResolvedValue({ ok: true });

    // Advance to trigger retry interval (disconnected uses retryIntervalMs=2000)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(result.current.status).toBe('connected');
    expect(onReconnectAction).toHaveBeenCalledTimes(1);
  });

  it('should only call onDisconnectAction once for consecutive failures', async () => {
    const onDisconnectAction = vi.fn();
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    renderHook(() =>
      useBackendHealth({ disconnectThreshold: 1, onDisconnectAction, retryIntervalMs: 1000 }),
    );

    // Initial check
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onDisconnectAction).toHaveBeenCalledTimes(1);

    // Second check
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // Should still be 1 - not called again
    expect(onDisconnectAction).toHaveBeenCalledTimes(1);
  });

  it('should use retryIntervalMs when disconnected', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    renderHook(() =>
      useBackendHealth({ disconnectThreshold: 1, intervalMs: 5000, retryIntervalMs: 1000 }),
    );

    // Initial check
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    mockFetch.mockClear();

    // At 1000ms (retryInterval), should check again
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(mockFetch).toHaveBeenCalled();
  });

  it('checks health immediately when restored from minimize', async () => {
    setAppHidden(true);
    mockFetch.mockResolvedValue({ ok: true });

    renderHook(() => useBackendHealth());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockFetch).not.toHaveBeenCalled();

    await act(async () => {
      setAppHidden(false);
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://test:3001/events/status',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each(['network', 'http', 'timeout'])(
    'does not announce a restart for repeated %s failures',
    async (failure) => {
      if (failure === 'http') mockFetch.mockResolvedValue({ ok: false, status: 503 });
      else
        mockFetch.mockRejectedValue(
          failure === 'timeout'
            ? new DOMException('Timed out', 'AbortError')
            : new Error('Connection refused'),
        );
      const { result } = renderHook(() =>
        useBackendHealth({ intervalMs: 1000, retryIntervalMs: 1000 }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(result.current.status).toBe('disconnected');
      expect(result.current.isIntentionalRestart).toBe(false);
      expect(useServerRestartStore.getState().isRestarting).toBe(false);
      mockFetch.mockResolvedValue({ ok: true });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(result.current.status).toBe('connected');
      expect(useServerRestartStore.getState().isRestarting).toBe(false);
    },
  );

  it('shows an explicit shutdown and clears on recovery', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));
    const { result } = renderHook(() => useBackendHealth({ disconnectThreshold: 1 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const shutdown = vi
      .mocked(sharedEventSource.subscribe)
      .mock.calls.find(([type]) => type === 'shutdown')![1];
    act(() => shutdown(new MessageEvent('shutdown')));
    expect(result.current.isIntentionalRestart).toBe(true);
    expect(useServerRestartStore.getState().isRestarting).toBe(true);
    mockFetch.mockResolvedValue({ ok: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.isIntentionalRestart).toBe(false);
    expect(useServerRestartStore.getState().isRestarting).toBe(false);
  });

  it('does not overlap slow probes and releases the guard after failure', async () => {
    let rejectProbe!: (error: Error) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectProbe = reject;
        }),
    );
    const { result } = renderHook(() => useBackendHealth({ intervalMs: 1000 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const signal = mockFetch.mock.calls[0][1].signal;
    await act(async () => {
      rejectProbe(new Error('Connection refused'));
    });
    mockFetch.mockResolvedValue({ ok: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(result.current.status).toBe('connected');
    expect(signal.aborted).toBe(false);
  });
});
