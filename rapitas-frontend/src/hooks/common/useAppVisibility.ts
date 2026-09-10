'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { getAppHidden, setAppHidden, subscribeAppHidden } from './app-visibility-store';

/**
 * useAppVisibility
 *
 * Subscribes to the Tauri `app://visibility` event (emitted from main.rs on
 * window minimize/restore) and reflects it into the app-visibility-store.
 * occlusion is disabled to work around a WebView2 black-screen bug, so
 * document.visibilityState stays 'visible' even while minimized — this hook
 * uses native events and reconciles isMinimized on subscription/focus so a
 * missed restore event cannot leave animations paused. Does not infer native
 * visibility from document.visibilityState. No-ops outside Tauri.
 *
 * @returns Whether the app window is currently minimized/hidden / アプリウィンドウが現在最小化中かどうか
 */
export function useAppVisibility(): boolean {
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let revision = 0;
    let reconcile: (() => void) | undefined;

    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      if (cancelled) return;
      const nativeWindow = getCurrentWindow();
      const fn = await listen<{ hidden: boolean }>('app://visibility', (event) => {
        if (cancelled) return;
        revision += 1;
        setAppHidden(!!event.payload?.hidden);
      });
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
      reconcile = () => {
        const requestRevision = ++revision;
        void nativeWindow
          .isMinimized()
          .then((minimized) => {
            // A later event/query wins over a slow native response.
            if (!cancelled && revision === requestRevision) setAppHidden(minimized);
          })
          .catch(() => {
            // Keep the last known native state if the bridge is unavailable.
          });
      };
      window.addEventListener('focus', reconcile);
      reconcile();
    })().catch(() => {
      // An unavailable native bridge must not reject the React effect.
    });

    return () => {
      cancelled = true;
      if (reconcile) window.removeEventListener('focus', reconcile);
      unlisten?.();
    };
  }, []);

  return useSyncExternalStore(subscribeAppHidden, getAppHidden, () => false);
}
