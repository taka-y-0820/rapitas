import { act, renderHook, waitFor } from '@testing-library/react';
import { useAppVisibility } from '../common/useAppVisibility';
import { setAppHidden } from '../common/app-visibility-store';

const native = vi.hoisted(() => ({
  isMinimized: vi.fn(),
  listen: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ isMinimized: native.isMinimized }),
}));

describe('native visibility reconciliation', () => {
  beforeEach(() => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    native.listen.mockReset().mockResolvedValue(vi.fn());
    native.isMinimized.mockReset().mockResolvedValue(false);
    setAppHidden(false);
  });
  afterEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    setAppHidden(false);
  });

  it('clears stale hidden state when mounting after a missed restore event', async () => {
    setAppHidden(true);
    const { result } = renderHook(() => useAppVisibility());
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('reconciles native state on focus after a missed restore event', async () => {
    native.isMinimized.mockResolvedValue(true);
    const { result } = renderHook(() => useAppVisibility());
    await waitFor(() => expect(result.current).toBe(true));
    native.isMinimized.mockResolvedValue(false);
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('does not overwrite a newer native event with an older query result', async () => {
    let resolve!: (value: boolean) => void;
    native.isMinimized.mockReturnValue(
      new Promise<boolean>((r) => {
        resolve = r;
      }),
    );
    const { result } = renderHook(() => useAppVisibility());
    await waitFor(() => expect(native.isMinimized).toHaveBeenCalled());
    act(() => native.listen.mock.calls[0][1]({ payload: { hidden: true } }));
    await act(async () => resolve(false));
    expect(result.current).toBe(true);
  });
});
