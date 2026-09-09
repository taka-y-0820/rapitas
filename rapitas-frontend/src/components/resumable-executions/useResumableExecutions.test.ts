/**
 * useResumableExecutions.test
 *
 * Verifies that a backend-signaled DB query failure (503) on
 * `/agents/resumable-executions` surfaces as a connection error instead of
 * silently rendering as "no interrupted executions" (task 913).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/utils/api', () => ({
  API_BASE_URL: 'http://api.test',
  fetchWithRetry: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock('@/hooks/common/useBackendHealth', () => ({
  useBackendHealth: () => ({ isConnected: true, isIntentionalRestart: false }),
}));
vi.mock('@/hooks/common/useOnVisible', () => ({ useOnVisible: () => {} }));
vi.mock('@/hooks/common/app-visibility-store', () => ({
  getAppHidden: () => false,
  subscribeAppHidden: () => () => {},
}));
vi.mock('@/stores/execution-state-store', () => ({
  useExecutionStateStore: () => 0,
}));
vi.mock('@/components/ui/toast/ToastContainer', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

const fetchMock = vi.fn();

import { useResumableExecutions } from './useResumableExecutions';

describe('useResumableExecutions', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sets connectionError when the backend returns 503 (DB query failure)', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) // /settings (autoResume)
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' });

    const { result } = renderHook(() => useResumableExecutions());

    await waitFor(() => expect(result.current.connectionError).not.toBeNull());
    expect(result.current.executions).toEqual([]);
  });

  it('leaves connectionError null on a normal empty 200 response', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => [] }) // /settings (autoResume)
      .mockResolvedValueOnce({ ok: true, json: async () => [] }); // /resumable-executions

    const { result } = renderHook(() => useResumableExecutions());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.connectionError).toBeNull();
    expect(result.current.executions).toEqual([]);
  });
});
