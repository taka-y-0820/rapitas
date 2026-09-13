'use client';

/**
 * NotificationToastPage
 *
 * Content of the app's own global toast window (Tauri: frameless,
 * always-on-top, non-focusable, bottom-right). Shows one notification at a
 * time: the first payload arrives via URL query (window creation), later ones
 * via the 'rapitas:toast' event. Auto-hides after a few seconds; hovering
 * pauses the timer; clicking navigates the main window to the link.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlarmClock, Check, HelpCircle, X } from 'lucide-react';
import { API_BASE_URL } from '@/utils/api';
import { ToastQuestionOptions } from './_components/ToastQuestionOptions';

interface ToastPayload {
  title: string;
  body: string;
  link: string | null;
  /** Set for memo reminders — enables the mark-done action. */
  memoId?: number | null;
  /** Set for agent questions — the toast answers them inline. */
  taskId?: number | null;
  /** 'question' marks an agent question (see useBrowserNotifications). */
  kind?: string | null;
}

const isQuestionPayload = (p: ToastPayload | null): p is ToastPayload & { taskId: number } =>
  !!p && p.kind === 'question' && typeof p.taskId === 'number';

const AUTO_HIDE_MS = 8000;

const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Play a short two-tone chime via WebAudio — no asset file, and the window's
 * autoplay policy allows it without a user gesture (see main.rs browser args).
 */
const playChime = () => {
  try {
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const play = (freq: number, at: number, dur: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + dur + 0.05);
    };
    // Gentle ascending fifth — audible but not alarming.
    play(659.25, 0, 0.28); // E5
    play(987.77, 0.16, 0.4); // B5
    setTimeout(() => void ctx.close(), 1200);
  } catch {
    /* sound is best-effort */
  }
};

/** Dismiss this toast window (no-op outside Tauri). */
const hideToastWindow = async () => {
  if (!inTauri()) return;
  // Parks the window off-screen instead of hide(): tao's show() would steal
  // focus on the next notification, and hidden WebView2s stop navigating.
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('toast_dismiss').catch(() => {});
};

export default function NotificationToastPage() {
  const t = useTranslations('notification');
  const [payload, setPayload] = useState<ToastPayload | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const payloadRef = useRef<ToastPayload | null>(null);
  payloadRef.current = payload;

  // `next` is the payload just received (state has not committed yet when the
  // listener arms the timer); mouse-leave re-arms from the ref.
  const armAutoHide = useCallback((next?: ToastPayload | null) => {
    clearTimeout(hideTimerRef.current);
    // A question blocks the workflow until answered — it stays until the user
    // acts (option, ×, Esc) instead of sliding away after 8 seconds.
    if (isQuestionPayload(next ?? payloadRef.current)) return;
    hideTimerRef.current = setTimeout(() => void hideToastWindow(), AUTO_HIDE_MS);
  }, []);

  // Grow/shrink the window to the rendered content (question options need
  // more than the default 116px). Measured after paint; no-op outside Tauri.
  const syncHeight = useCallback(() => {
    if (!inTauri()) return;
    requestAnimationFrame(() => {
      const height = Math.ceil(document.documentElement.scrollHeight);
      void import('@tauri-apps/api/core').then(({ invoke }) =>
        invoke('toast_resize', { height }).catch(() => {}),
      );
    });
  }, []);

  // Initial payload is PULLED via toast_ready once mounted (the window is
  // created hidden; the command reveals it) — a URL query can't carry it
  // (WebviewUrl::App treats the path as a PathBuf) and an emit at creation
  // time races this listener's registration. Later payloads arrive by event.
  useEffect(() => {
    if (!inTauri()) return;
    let unlisten: (() => void) | undefined;
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<ToastPayload>('rapitas:toast', (e) => {
        const next = { ...e.payload, link: e.payload.link || null };
        setPayload(next);
        playChime();
        armAutoHide(next);
      }).then((fn) => {
        unlisten = fn;
      });
    });
    import('@tauri-apps/api/core').then(({ invoke }) => {
      invoke<ToastPayload | null>('toast_ready')
        .then((initial) => {
          if (initial) {
            const next = { ...initial, link: initial.link || null };
            setPayload(next);
            playChime();
            armAutoHide(next);
          }
        })
        .catch(() => {});
    });
    // Esc dismisses, same as the × button.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void hideToastWindow();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(hideTimerRef.current);
      window.removeEventListener('keydown', onKey);
      unlisten?.();
    };
  }, [armAutoHide]);

  // Theme sync — this window loads once and then only hides/shows, so follow
  // the main window's stored theme (same approach as the quick-capture popup).
  useEffect(() => {
    const applyTheme = () => {
      const stored = localStorage.getItem('theme');
      const dark =
        stored === 'dark' ||
        (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    applyTheme();
    window.addEventListener('storage', applyTheme);
    return () => window.removeEventListener('storage', applyTheme);
  }, []);

  const open = async () => {
    if (!inTauri()) return;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('toast_navigate', { link: payload?.link ?? null }).catch(() => {});
  };

  // Mark the reminder's memo as done straight from the toast, then dismiss.
  const markDone = async () => {
    const memoId = payload?.memoId;
    if (!memoId) return;
    try {
      await fetch(`${API_BASE_URL}/memos/${memoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDone: true }),
      });
    } catch {
      /* non-critical — the memo stays open and can be completed from /memos */
    }
    void hideToastWindow();
  };

  const isQuestion = isQuestionPayload(payload);

  // Re-measure whenever a new payload lands (question ↔ reminder heights differ).
  useEffect(() => {
    syncHeight();
  }, [payload, syncHeight]);

  return (
    // The whole surface is the click target; the timer pauses while hovered.
    <div
      onMouseEnter={() => clearTimeout(hideTimerRef.current)}
      onMouseLeave={() => armAutoHide()}
      className="fixed inset-0 flex select-none flex-col border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-indigo-dark-900"
    >
      <div className="flex items-stretch">
        <button
          onClick={open}
          className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left"
        >
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-400">
            {isQuestion ? (
              <HelpCircle className="h-4 w-4" aria-hidden="true" />
            ) : (
              <AlarmClock className="h-4 w-4" aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              {payload?.title ?? ''}
            </span>
            <span className="mt-0.5 block text-xs leading-snug text-zinc-600 line-clamp-3 dark:text-zinc-300">
              {payload?.body ?? ''}
            </span>
          </span>
        </button>
        <div className="flex flex-col items-end justify-between py-1.5 pr-1.5">
          <button
            onClick={() => void hideToastWindow()}
            aria-label={t('close')}
            title={t('close')}
            className="p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            <X className="h-4 w-4" />
          </button>
          {payload?.memoId != null && (
            <button
              onClick={() => void markDone()}
              className="flex items-center gap-1 rounded-md bg-green-50 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-100 dark:bg-green-950/40 dark:text-green-400 dark:hover:bg-green-950/60"
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {t('markMemoDone')}
            </button>
          )}
        </div>
      </div>
      {isQuestion && (
        <ToastQuestionOptions
          key={payload.taskId}
          taskId={payload.taskId}
          onAnswered={() => {
            // Leave the confirmation visible briefly, then slide away.
            clearTimeout(hideTimerRef.current);
            hideTimerRef.current = setTimeout(() => void hideToastWindow(), 2500);
          }}
          onLayoutChange={syncHeight}
        />
      )}
    </div>
  );
}
