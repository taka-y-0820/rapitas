import { renderHook, act, waitFor } from '@testing-library/react';
import { useAppVisibility } from '../common/useAppVisibility';
import { setAppHidden } from '../common/app-visibility-store';

describe('useAppVisibility', () => {
  beforeEach(() => {
    vi.doMock('@tauri-apps/api/window', () => ({
      getCurrentWindow: () => ({ isMinimized: vi.fn().mockResolvedValue(false) }),
    }));
  });
  afterEach(() => {
    setAppHidden(false);
    // @ts-expect-error test cleanup of injected Tauri marker
    delete window.__TAURI_INTERNALS__;
    vi.doUnmock('@tauri-apps/api/event');
    vi.doUnmock('@tauri-apps/api/window');
  });

  it('非Tauri環境ではlistenを呼ばずfalseを返すこと', () => {
    const { result } = renderHook(() => useAppVisibility());
    expect(result.current).toBe(false);
  });

  describe('Tauri環境', () => {
    it('app://visibilityイベント購読でhidden状態が伝播すること', async () => {
      // @ts-expect-error injecting a minimal Tauri internals stub for the test
      window.__TAURI_INTERNALS__ = {};
      const mockUnlisten = vi.fn();
      const mockListen = vi.fn(
        async (_event: string, _cb: (e: { payload: { hidden: boolean } }) => void) => mockUnlisten,
      );
      vi.doMock('@tauri-apps/api/event', () => ({ listen: mockListen }));

      const { result, unmount } = renderHook(() => useAppVisibility());

      await waitFor(() => expect(mockListen).toHaveBeenCalled());

      expect(mockListen).toHaveBeenCalledWith('app://visibility', expect.any(Function));
      expect(result.current).toBe(false);

      const registeredHandler = mockListen.mock.calls[0][1] as (e: {
        payload: { hidden: boolean };
      }) => void;

      act(() => {
        registeredHandler({ payload: { hidden: true } });
      });
      expect(result.current).toBe(true);

      act(() => {
        registeredHandler({ payload: { hidden: false } });
      });
      expect(result.current).toBe(false);

      unmount();
      await waitFor(() => expect(mockUnlisten).toHaveBeenCalledTimes(1));
    });

    it('アンマウント時に購読解除されること', async () => {
      // @ts-expect-error injecting a minimal Tauri internals stub for the test
      window.__TAURI_INTERNALS__ = {};
      const mockUnlisten = vi.fn();
      const mockListen = vi.fn(async () => mockUnlisten);
      vi.doMock('@tauri-apps/api/event', () => ({ listen: mockListen }));

      const { unmount } = renderHook(() => useAppVisibility());

      await waitFor(() => expect(mockListen).toHaveBeenCalled());

      unmount();

      await waitFor(() => expect(mockUnlisten).toHaveBeenCalledTimes(1));
    });
  });
});
