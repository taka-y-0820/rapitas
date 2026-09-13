'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { API_BASE_URL } from '@/utils/api';
import { createLogger } from '@/lib/logger';
import { useServerRestartStore } from '@/stores/server-restart-store';
import { sharedEventSource } from '@/lib/sse/shared-event-source';
import { useOnVisible } from './useOnVisible';
import { getAppHidden, subscribeAppHidden } from './app-visibility-store';

const logger = createLogger('useBackendHealth');

type BackendHealthStatus = 'connected' | 'disconnected' | 'checking';

type UseBackendHealthOptions = {
  /** Health check interval (milliseconds). Default: 5000 */
  intervalMs?: number;
  /** Retry interval after disconnect detection (milliseconds). Default: 2000 */
  retryIntervalMs?: number;
  /** Callback called on reconnection */
  onReconnectAction?: () => void;
  /** Callback called on disconnection */
  onDisconnectAction?: () => void;
  /** 連続失敗がこの回数に達するまで disconnected 表示にしない（単発の遅延スパイクでモーダルが点滅するのを防ぐ）。デフォルト: 2 */
  disconnectThreshold?: number;
};

/**
 * Hook for monitoring backend connection status and detecting recovery after restart.
 * Calls onReconnect callback when disconnect→recovery is detected.
 * When shutdown event is received via SSE, treats it as intentional restart
 * and sets isIntentionalRestart flag to true.
 * Failed probes indicate connectivity loss only; they do not prove a restart.
 */
export function useBackendHealth(options: UseBackendHealthOptions = {}) {
  const {
    intervalMs = 5000,
    retryIntervalMs = 2000,
    onReconnectAction,
    onDisconnectAction,
    disconnectThreshold = 2,
  } = options;

  const [status, setStatus] = useState<BackendHealthStatus>('checking');
  const [isIntentionalRestart, setIsIntentionalRestart] = useState(false);
  const wasDisconnectedRef = useRef(false);
  const checkingRef = useRef(false);
  const consecutiveFailureCountRef = useRef(0);
  const onReconnectRef = useRef(onReconnectAction);
  const onDisconnectRef = useRef(onDisconnectAction);

  useEffect(() => {
    onReconnectRef.current = onReconnectAction;
  }, [onReconnectAction]);

  useEffect(() => {
    onDisconnectRef.current = onDisconnectAction;
  }, [onDisconnectAction]);

  // Detect shutdown events via the SHARED SSE connection. Each mount of this
  // hook previously opened its own /events/stream EventSource, multiplying
  // persistent connections toward the browser's 6-per-origin limit.
  useEffect(() => {
    return sharedEventSource.subscribe('shutdown', () => {
      logger.info('Received shutdown event - server is intentionally restarting');
      setIsIntentionalRestart(true);
    });
  }, []);

  // Mirror the intentional-restart flag to the global store so the logger and
  // connection-error UI can suppress the expected error flood app-wide.
  useEffect(() => {
    useServerRestartStore.getState().setRestarting(isIntentionalRestart);
  }, [isIntentionalRestart]);

  const checkHealth = useCallback(async () => {
    // Skip the probe while rapitas is backgrounded — saves a request every few
    // seconds when the user is in another app; useOnVisible re-checks on return.
    // getAppHidden() covers minimize, which occlusion-disabled WebView2 doesn't
    // report via document.hidden.
    if ((typeof document !== 'undefined' && document.hidden) || getAppHidden()) return;
    if (checkingRef.current) return;
    checkingRef.current = true;
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      // 8s (was 3s): the backend's event loop can lag ~1s under heavy sync
      // DB aggregation; a 3s cutoff turned ordinary load spikes into
      // "disconnected" flaps (2026-09-02 modal-loop incident).
      timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(`${API_BASE_URL}/events/status`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        consecutiveFailureCountRef.current = 0;
        if (wasDisconnectedRef.current) {
          wasDisconnectedRef.current = false;
          setIsIntentionalRestart(false);
          logger.info('Backend reconnected');
          onReconnectRef.current?.();
          // NOTE: SSE recovery is owned by sharedEventSource (auto-reconnect) —
          // no per-hook EventSource to rebuild here anymore.
        }
        setStatus('connected');
      } else {
        consecutiveFailureCountRef.current += 1;
        // Debounced: a single failed probe is a load spike, not an outage —
        // only flip the visible state after disconnectThreshold misses.
        if (consecutiveFailureCountRef.current >= disconnectThreshold) {
          if (!wasDisconnectedRef.current) {
            wasDisconnectedRef.current = true;
            logger.warn(`Backend disconnected: ${res.status} ${res.statusText}`);
            onDisconnectRef.current?.();
          }
          setStatus('disconnected');
        }
      }
    } catch (error) {
      // Determine if error is a timeout error
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      const errorMessage = isTimeout
        ? 'Request timeout'
        : error instanceof Error
          ? error.message
          : 'Unknown error';

      consecutiveFailureCountRef.current += 1;
      // Same debounce as the non-ok branch — see above.
      if (consecutiveFailureCountRef.current >= disconnectThreshold) {
        if (!wasDisconnectedRef.current) {
          wasDisconnectedRef.current = true;
          logger.warn(`Backend health check failed: ${errorMessage}`, error);
          onDisconnectRef.current?.();
        }
        setStatus('disconnected');
      }
    } finally {
      clearTimeout(timeoutId);
      checkingRef.current = false;
    }
  }, [disconnectThreshold]);

  // Single interval that adjusts based on status
  useEffect(() => {
    // Run initial check asynchronously
    const initialCheck = setTimeout(() => checkHealth(), 0);

    const currentInterval = status === 'disconnected' ? retryIntervalMs : intervalMs;
    const timer = setInterval(checkHealth, currentInterval);

    return () => {
      clearTimeout(initialCheck);
      clearInterval(timer);
    };
  }, [checkHealth, status, intervalMs, retryIntervalMs]);

  // Re-check immediately when the user returns to rapitas.
  useOnVisible(checkHealth);

  // Re-check immediately on restore from minimize. visibilitychange (behind
  // useOnVisible above) never fires for that transition because occlusion is
  // intentionally disabled, so without this the poll interval would be the
  // only thing to pick it back up.
  useEffect(() => {
    return subscribeAppHidden(() => {
      if (!getAppHidden()) checkHealth();
    });
  }, [checkHealth]);

  return { status, isConnected: status === 'connected', isIntentionalRestart };
}
