import type { Metadata, Viewport } from 'next';
// NOTE: self-hosted (geist package) instead of next/font/google — the desktop
// app must not depend on fonts.googleapis.com at compile time: when that
// fetch failed (2026-09-07) next/font silently fell back to system fonts and
// every Latin glyph in the execution log rendered in a different, larger face.
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';
import KeyboardShortcuts from '@/components/common/KeyboardShortcuts';
import { ResumableExecutionsBanner } from '@/components/common/ResumableExecutionsBanner';
import ScheduleReminderProvider from '@/components/providers/ScheduleReminderProvider';
import { NotificationToaster } from '@/components/notifications/notification-toaster';
import { MainWindowOnly } from '@/components/common/main-window-only';
import { TaskNavigateListener } from '@/components/common/TaskNavigateListener';
import { Suspense } from 'react';
import { ToastProvider } from '@/components/ui/toast/ToastContainer';
import { ConfirmDialogProvider } from '@/components/ui/dialog/ConfirmDialogProvider';
import { PomodoroProvider } from '@/feature/tasks/pomodoro/PomodoroProvider';
import ExternalLinksProvider from '@/components/providers/ExternalLinksProvider';
import CacheWarmupInitializer from '@/components/common/CacheWarmupInitializer';
import AppVisibilityBridge from '@/components/common/AppVisibilityBridge';
import SmartCommandBar from '@/components/smart-command-bar/SmartCommandBar';
import { TerminalProvider } from '@/feature/terminal';
import { AuthProvider } from '@/contexts/AuthContext';
import ConditionalHeader from '@/components/common/conditional-header';
import AppContent from '@/components/common/AppContent';
import IntlProvider from '@/components/providers/IntlProvider';
import { VoiceInputProvider } from '@/components/voice';
import OfflineIndicatorLoader from '@/components/common/OfflineIndicatorLoader';
import UpdateBanner from '@/components/common/UpdateBanner';
import GlobalErrorReporter from '@/components/common/GlobalErrorReporter';
import SetupGate from '@/components/common/SetupGate';
// import WindowResizeOptimizer from '@/components/common/WindowResizeOptimizer';

export const metadata: Metadata = {
  title: 'Rapi+',
  description: 'A high-performance, intuitive task management application',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Rapi+',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  // NOTE: must match --accent in globals.css (was #6366f1, a near-miss indigo).
  themeColor: '#4f46e5',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/*
          NOTE: loaded as a raw stylesheet (not next/font/google) because the note
          editor (src/components/note/editor/constants.ts) lets users pick
          "Noto Sans JP" as a literal font-family string on arbitrary content;
          next/font would only expose it as a scoped class/variable, not a
          browser-wide family name any element can request.
        */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
        {/*
          SECURITY: This dangerouslySetInnerHTML is safe - it contains only
          hardcoded static JavaScript for theme initialization. No user input.
        */}
        {/* SECURITY: safe */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                const setClassOnDocumentBody = (darkMode) => {
                  document.documentElement.classList.toggle('dark', darkMode);
                };
                const localStorageTheme = localStorage.getItem('theme');
                if (localStorageTheme === 'dark') {
                  setClassOnDocumentBody(true);
                } else if (localStorageTheme === 'light') {
                  setClassOnDocumentBody(false);
                } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
                  setClassOnDocumentBody(true);
                }
              })();
            `,
          }}
        />
        {/*
          SECURITY: This dangerouslySetInnerHTML is safe - it contains only
          hardcoded static JavaScript for service worker management. No user input.
        */}
        {/* SECURITY: safe */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              // Service worker policy:
              //  - production: register /sw.js for offline + asset caching
              //  - development (localhost / 127.0.0.1): skip registration AND
              //    proactively unregister any leftover SW + nuke its caches.
              //    Without this, the cache-first strategy in /sw.js keeps
              //    serving stale /_next/ chunks across code changes, forcing
              //    devs to "Clear site data" after every edit.
              if ('serviceWorker' in navigator) {
                var isLocalDev =
                  location.hostname === 'localhost' ||
                  location.hostname === '127.0.0.1' ||
                  location.hostname === '0.0.0.0' ||
                  location.hostname.endsWith('.local');
                if (isLocalDev) {
                  navigator.serviceWorker.getRegistrations().then(function (regs) {
                    regs.forEach(function (r) { r.unregister(); });
                  });
                  if (typeof caches !== 'undefined') {
                    caches.keys().then(function (keys) {
                      keys.forEach(function (k) { caches.delete(k); });
                    });
                  }
                } else {
                  window.addEventListener('load', function() {
                    navigator.serviceWorker.register('/sw.js').catch(function() {});
                  });
                }
              }
            `,
          }}
        />
      </head>
      <body className={`${GeistSans.variable} ${GeistMono.variable}`}>
        <IntlProvider>
          <AuthProvider>
            <PomodoroProvider>
              <ToastProvider>
                {/* NOTE: ConfirmDialogProvider is inside ToastProvider so it can use toasts. */}
                <ConfirmDialogProvider>
                  <VoiceInputProvider>
                    <ExternalLinksProvider>
                      <Suspense fallback={<div className="h-16" />}>
                        <Suspense fallback={<div className="h-16" />}>
                          <ConditionalHeader />
                        </Suspense>
                        {/* <WindowResizeOptimizer /> */}
                        <AppContent>{children}</AppContent>
                        {/* Global chrome is main-window-only: mounting it in the
                            popup windows (toast, quick capture) lets shortcuts
                            and banners hijack the popup's router. */}
                        <MainWindowOnly>
                          <Suspense fallback={null}>
                            <KeyboardShortcuts />
                          </Suspense>
                          <Suspense fallback={null}>
                            <OfflineIndicatorLoader />
                          </Suspense>
                          <Suspense fallback={null}>
                            <ResumableExecutionsBanner />
                          </Suspense>
                          <Suspense fallback={null}>
                            <UpdateBanner />
                          </Suspense>
                          <GlobalErrorReporter />
                          <TaskNavigateListener />
                          <Suspense fallback={null}>
                            <SetupGate />
                          </Suspense>
                          <ScheduleReminderProvider />
                          <NotificationToaster />
                          <AppVisibilityBridge />
                          <CacheWarmupInitializer />
                          <Suspense fallback={null}>
                            <SmartCommandBar />
                          </Suspense>
                          <TerminalProvider />
                        </MainWindowOnly>
                      </Suspense>
                    </ExternalLinksProvider>
                  </VoiceInputProvider>
                </ConfirmDialogProvider>
              </ToastProvider>
            </PomodoroProvider>
          </AuthProvider>
        </IntlProvider>
      </body>
    </html>
  );
}
