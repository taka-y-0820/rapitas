/**
 * server-restart-store
 *
 * Global "the backend is intentionally restarting" flag. Set when a restart is
 * initiated (header button) or detected (SSE `shutdown` event via
 * useBackendHealth), cleared on
 * reconnect. Consulted by the logger to silence the expected flood of network
 * errors and by connection-error UI to stay hidden during the restart window.
 */
import { create } from 'zustand';

interface ServerRestartState {
  isRestarting: boolean;
  setRestarting: (value: boolean) => void;
}

// Safety net: never stay suppressed longer than a restart could plausibly take,
// in case the reconnect signal is missed.
const MAX_RESTART_MS = 120_000;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

export const useServerRestartStore = create<ServerRestartState>((set) => ({
  isRestarting: false,
  setRestarting: (value) => {
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    if (value) {
      clearTimer = setTimeout(() => {
        clearTimer = null;
        set({ isRestarting: false });
      }, MAX_RESTART_MS);
    }
    set({ isRestarting: value });
  },
}));

/** Non-reactive getter for plain functions (logger, fetch helpers). */
export function isServerRestarting(): boolean {
  return useServerRestartStore.getState().isRestarting;
}
