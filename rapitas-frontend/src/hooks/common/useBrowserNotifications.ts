'use client';

/**
 * Browser Notification Hook
 *
 * Connects to the SSE notifications channel and displays native OS
 * notifications: the Tauri notification plugin inside the desktop app
 * (real Windows toasts — WebView2 has no working Notification API), the
 * browser Notification API otherwise. Handles permission requests,
 * reconnection, and event parsing.
 */
import { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createLogger } from '@/lib/logger';
import { sharedEventSource } from '@/lib/sse/shared-event-source';
import { isTauri } from '@/utils/tauri';
import { resolveNotificationText } from '@/components/notifications/notification-type-icons';

const logger = createLogger('useBrowserNotifications');

/** Reminder types alert even while the window is focused — that is their job. */
const REMINDER_TYPES = new Set(['memo_reminder', 'habit_reminder', 'schedule_reminder']);

/**
 * An agent question blocks the workflow until answered, so it alerts like a
 * reminder and the desktop toast lets the user pick an option in place
 * (kind: 'question' → the toast page fetches the pending question.md).
 */
const QUESTION_TYPES = new Set(['auto_run_awaiting_answer']);

/**
 * Ship a native-notification failure to the backend error buffer — the desktop
 * webview's console is invisible, so this is the only diagnosable trail.
 */
const reportNotificationError = (message: string) => {
  void import('@/utils/api')
    .then(({ API_BASE_URL }) =>
      fetch(`${API_BASE_URL}/system/errors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `tauri-notification: ${message}`.slice(0, 2000) }),
      }),
    )
    .catch(() => {});
};

/** Notification event payload from SSE. */
export interface SSENotificationPayload {
  notification: {
    id: number;
    type: string;
    title: string;
    message: string;
    link?: string | null;
    /** JSON string in the DB row; may arrive parsed depending on the sender. */
    metadata?: string | Record<string, unknown> | null;
  };
  unreadCount: number;
}

/**
 * Extract the memo id from a notification's metadata (memo reminders carry
 * `{"memoId": n}`), tolerating both the raw DB string and a parsed object.
 *
 * @param metadata - Notification metadata / 通知メタデータ
 * @returns The memo id, or null / メモID(無ければnull)
 */
export function extractMemoId(
  metadata: string | Record<string, unknown> | null | undefined,
): number | null {
  try {
    const obj = typeof metadata === 'string' ? (JSON.parse(metadata) as unknown) : metadata;
    const id = (obj as { memoId?: unknown } | null | undefined)?.memoId;
    return typeof id === 'number' && Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Extract the task id from a notification's metadata (auto-run notifications
 * carry `{"taskId": n}`), tolerating both the raw DB string and a parsed object.
 *
 * @param metadata - Notification metadata / 通知メタデータ
 * @returns The task id, or null / タスクID(無ければnull)
 */
export function extractTaskId(
  metadata: string | Record<string, unknown> | null | undefined,
): number | null {
  try {
    const obj = typeof metadata === 'string' ? (JSON.parse(metadata) as unknown) : metadata;
    const id = (obj as { taskId?: unknown } | null | undefined)?.taskId;
    return typeof id === 'number' && Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

/** Hook options. */
interface UseBrowserNotificationsOptions {
  /** Enable/disable the hook. Defaults to true. */
  enabled?: boolean;
  /** Callback when a notification is received. */
  onNotification?: (payload: SSENotificationPayload) => void;
}

/**
 * Subscribe to SSE notifications and show browser push notifications.
 *
 * Requests Notification API permission on mount. Connects to the
 * notifications SSE channel and displays native notifications for
 * each event received.
 *
 * @param options - Hook configuration. / フック設定
 * @returns Permission state and unread count. / 許可状態と未読数
 */
export function useBrowserNotifications(options: UseBrowserNotificationsOptions = {}) {
  const { enabled = true, onNotification } = options;
  const t = useTranslations('notification');
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [unreadCount, setUnreadCount] = useState(0);
  const onNotificationRef = useRef(onNotification);

  useEffect(() => {
    onNotificationRef.current = onNotification;
  }, [onNotification]);

  // Request notification permission (browser only — the Tauri plugin path
  // requests its own permission lazily on first send)
  const requestPermission = useCallback(async () => {
    if (typeof window === 'undefined' || isTauri() || !('Notification' in window)) return;

    if (Notification.permission === 'granted') {
      setPermission('granted');
      return;
    }

    if (Notification.permission !== 'denied') {
      const result = await Notification.requestPermission();
      setPermission(result);
    } else {
      setPermission('denied');
    }
  }, []);

  // Show a native OS notification (Tauri plugin in the desktop app, browser
  // Notification API elsewhere).
  const showNotification = useCallback(
    (payload: SSENotificationPayload) => {
      if (typeof window === 'undefined') return;
      const { notification } = payload;
      // Reminders alert even while focused (the user asked for OS-level
      // visibility); everything else stays quiet unless the window is in the
      // background, to avoid double-alerting on top of the in-app UI.
      const isQuestion = QUESTION_TYPES.has(notification.type);
      if (!REMINDER_TYPES.has(notification.type) && !isQuestion && document.hasFocus()) return;

      const { title, message } = resolveNotificationText(t, notification);

      if (isTauri()) {
        // The app's OWN always-on-top toast window — per user decision, Windows
        // toasts are not used at all: the OS can silently drop them (AUMID,
        // focus assist, per-app settings) and WebView2's Notification API is
        // non-functional anyway.
        void (async () => {
          try {
            const { invoke } = await import('@tauri-apps/api/core');
            await invoke('show_toast_window', {
              title,
              body: message,
              link: notification.link ?? null,
              memoId: extractMemoId(notification.metadata),
              taskId: isQuestion ? extractTaskId(notification.metadata) : null,
              kind: isQuestion ? 'question' : null,
            });
          } catch (e) {
            logger.errorThrottled('Toast window failed:', e);
            reportNotificationError(e instanceof Error ? e.message : String(e));
          }
        })();
        return;
      }

      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const icon = '/icon-192x192.png';

      const n = new Notification(title, {
        body: message,
        icon,
        tag: `rapitas-${notification.id}`,
        silent: false,
      });

      n.onclick = () => {
        window.focus();
        n.close();
      };

      // Auto-close after 5 seconds
      setTimeout(() => n.close(), 5000);
    },
    [t],
  );

  // Subscribe to notification events on the SHARED SSE connection. A dedicated
  // per-mount EventSource here previously added to the browser's 6-per-origin
  // connection budget alongside every other SSE hook.
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    requestPermission();

    return sharedEventSource.subscribe('new_notification', (event) => {
      try {
        const payload = JSON.parse(event.data) as SSENotificationPayload;
        setUnreadCount(payload.unreadCount);
        showNotification(payload);
        onNotificationRef.current?.(payload);
      } catch (e) {
        logger.errorThrottled('Failed to parse notification event:', e);
      }
    });
  }, [enabled, requestPermission, showNotification]);

  return { permission, unreadCount, requestPermission };
}
