/**
 * preview-session-manager
 *
 * Live-preview feature: for a task's latest git worktree, start its dev
 * server (via the same rapitas.runtime.json + app-launcher.ts machinery
 * runtime-smoke verification already uses) and keep a persistent headless
 * browser tab open (via playwright-worker-client, a Node.js child process —
 * see that file's header for why Bun can't drive Playwright directly) so the
 * embedded preview panel can repeatedly screenshot it. Unlike runtime-smoke's
 * one-shot verification run, sessions here are long-lived (until explicitly
 * stopped or idle) and held in-process — this module is NOT responsible for
 * verification pass/fail judgement. Relaying user interactions (click/type/
 * scroll/select) to a live session lives in preview-interaction.ts, which
 * reads the `sessions` map this module owns.
 */
import { existsSync } from 'fs';
import { createLogger } from '../../../config/logger';
import { prisma } from '../../../config/database';
import { resolveLatestSessionWorktree } from '../agent-session-resolver';
import type { LaunchedApp } from '../verification/runtime-smoke/app-launcher';
import {
  acquireRuntimeServer,
  releaseRuntimeServer,
} from '../verification/runtime-smoke/worktree-server-registry';
import { resolveRuntimeConfig } from '../verification/runtime-smoke/runtime-config';
import {
  spawnPlaywrightWorker,
  type PlaywrightWorker,
} from '../verification/runtime-smoke/playwright-worker-client';

const log = createLogger('preview-session');

/** Bounds the browser-launch step — a hung/missing channel fails in seconds, not minutes. */
const BROWSER_LAUNCH_TIMEOUT_MS = 20_000;

/** Stop a session after this long without a screenshot request. */
const IDLE_TIMEOUT_MS = 15 * 60_000;
/** How often the sweep checks for idle sessions. */
const SWEEP_INTERVAL_MS = 60_000;

export interface PreviewSession {
  app: Pick<LaunchedApp, 'logs' | 'stop'>;
  worker: PlaywrightWorker;
  url: string;
  startedAt: Date;
  lastAccessedAt: Date;
}

// Exported for preview-interaction.ts (interact/inspect need the same live
// session map) — kept in this file since startPreview/stopPreview own its
// lifecycle; interact/inspect only ever read an existing entry or touch
// lastAccessedAt, never create/delete one.
export const sessions = new Map<number, PreviewSession>();

/**
 * Resources for an in-progress (not yet fully established) startPreview
 * call, keyed by taskId. The dev-server process and headless browser are
 * genuinely slow to spin up (launch, health-poll, navigate — tens of
 * seconds), and the HTTP handler keeps running to completion even after the
 * calling client gives up waiting (a timed-out fetch on the frontend does
 * NOT cancel the in-flight request on the server). Without tracking these
 * as soon as they're created, a client that gives up (navigates away, hits
 * its own timeout) leaves the dev server + browser running forever — never
 * reachable via `sessions` because the attempt never got that far. Every
 * stopPreview/new startPreview call for the task kills whatever's here, so
 * retries self-heal instead of piling up orphaned processes (confirmed live:
 * three abandoned `next dev` instances all fighting over the same `.next`
 * build cache, which is almost certainly why every one of them then hung).
 */
type PendingPreview = {
  app?: Pick<LaunchedApp, 'logs' | 'stop'>;
  worker?: PlaywrightWorker;
  controller?: AbortController;
};
const pending = new Map<number, PendingPreview>();
const requestVersions = new Map<number, number>();

/** Stop and forget an in-progress launch for a task, if one is tracked. */
async function killPending(taskId: number): Promise<void> {
  const p = pending.get(taskId);
  if (!p) return;
  pending.delete(taskId);
  p.controller?.abort();
  if (p.worker) await p.worker.close().catch(() => {});
  if (p.app) p.app.stop();
}

/**
 * Stop THIS invocation's own app/worker directly (not via a `pending` map
 * lookup) and remove the map entry only if it still points at these exact
 * resources. Guards against a slow, failing startPreview call for taskId
 * accidentally killing a DIFFERENT, newer startPreview call's already-
 * further-along resources — which a plain `killPending(taskId)` could do if
 * two calls for the same task ever overlap (each call always kills whatever
 * it finds pending/established for the task before starting its own, so
 * this is an edge case, not the common path, but still worth not getting
 * wrong).
 */
async function cleanupOwnAttempt(
  taskId: number,
  app: Pick<LaunchedApp, 'logs' | 'stop'>,
  worker?: PlaywrightWorker,
): Promise<void> {
  if (worker) await worker.close().catch(() => {});
  app.stop();
  if (pending.get(taskId)?.app === app) pending.delete(taskId);
}

/** Reasons startPreview can fail — mapped to a Japanese message by the route layer's caller. */
export type StartPreviewFailureReason =
  | 'no_worktree'
  | 'not_configured'
  | 'config_error'
  | 'unhealthy'
  | 'no_browser'
  | 'error';

export type StartPreviewResult =
  | { ok: true; url: string }
  | { ok: false; reason: StartPreviewFailureReason; message: string };

/**
 * Start (or restart) a preview session for a task: launch its worktree's dev
 * server on a free port and open a persistent headless-browser tab on it.
 * Falls back to the theme's primary working directory when the task has no
 * (or no longer usable) worktree, so a task that hasn't been agent-executed
 * yet can still be previewed — same rapitas.runtime.json mechanism, just
 * pointed at the shared checkout instead of an isolated worktree.
 *
 * @param taskId - Task whose latest worktree to preview. / 対象タスクID
 * @param opts.headless - Explicit `false` opens a real, visible OS browser
 *   window instead of the default headless tab — used by the task-detail
 *   preview-settings modal's "test in a normal window" mode. / 通常表示モード
 * @returns The base URL on success, or a typed failure reason + message. / 起動結果
 */
export async function startPreview(
  taskId: number,
  opts?: { headless?: boolean },
): Promise<StartPreviewResult> {
  const stopping = stopPreview(taskId);
  const version = requestVersions.get(taskId);
  await stopping;
  if (requestVersions.get(taskId) !== version)
    return { ok: false, reason: 'error', message: 'preview request superseded' };
  const controller = new AbortController();
  const attempt: PendingPreview = { controller };
  pending.set(taskId, attempt);
  try {
    const session = await resolveLatestSessionWorktree(taskId);
    let workdir =
      session?.worktreePath && existsSync(session.worktreePath) ? session.worktreePath : null;

    if (!workdir) {
      const task = await prisma.task
        .findUnique({
          where: { id: taskId },
          select: { theme: { select: { workingDirectory: true } } },
        })
        .catch(() => null);
      const themeDir = task?.theme?.workingDirectory;
      if (themeDir && existsSync(themeDir)) {
        log.info(
          { taskId, themeDir },
          '[preview] no worktree for task — falling back to theme working directory',
        );
        workdir = themeDir;
      }
    }

    if (!workdir) {
      return {
        ok: false,
        reason: 'no_worktree',
        message:
          'このタスクのworktreeもテーマの作業ディレクトリも見つかりません。テーマに作業ディレクトリを設定するか、エージェントを一度実行してください。',
      };
    }

    const loaded = await resolveRuntimeConfig({ workdir, taskId });
    if (loaded === null) {
      return {
        ok: false,
        reason: 'not_configured',
        message:
          'このプロジェクトのプレビュー設定がありません。テーマ設定でプレビュー設定(JSON)を登録するか、rapitas.runtime.json を配置してください。',
      };
    }
    if (loaded.error || !loaded.config) {
      return {
        ok: false,
        reason: 'config_error',
        message: `プレビュー設定が不正です: ${loaded.error}`,
      };
    }
    const cfg = loaded.config;

    if (controller.signal.aborted || pending.get(taskId) !== attempt)
      return { ok: false, reason: 'error', message: 'preview request cancelled' };
    const acquired = await acquireRuntimeServer(workdir, cfg, {
      signal: controller.signal,
      label: `preview-${taskId}`,
    });
    if (!acquired.ok) {
      if (pending.get(taskId) === attempt) pending.delete(taskId);
      return { ok: false, reason: 'unhealthy', message: acquired.reason };
    }
    const { port, baseUrl, lease } = acquired;
    // Compatibility handle for preview session consumers: stop releases ONLY
    // this lease, never the shared OS process.
    const app = { logs: acquired.logs, stop: () => releaseRuntimeServer(lease) };
    if (controller.signal.aborted || pending.get(taskId) !== attempt) {
      app.stop();
      return { ok: false, reason: 'error', message: 'preview request cancelled' };
    }
    attempt.app = app;
    const worker = spawnPlaywrightWorker();
    attempt.worker = worker;

    try {
      log.info({ taskId, headless: opts?.headless ?? true }, '[preview] launching browser');
      const { channel } = await worker.launch({
        channels: ['msedge', 'chrome'],
        timeoutMs: BROWSER_LAUNCH_TIMEOUT_MS,
        viewport: { width: 1280, height: 800 },
        headless: opts?.headless,
      });
      log.info({ taskId, channel }, '[preview] browser launched');
    } catch (e) {
      log.warn(
        { taskId, err: e instanceof Error ? e.message : e },
        '[preview] no system browser available',
      );
      await cleanupOwnAttempt(taskId, app, worker);
      return {
        ok: false,
        reason: 'no_browser',
        message: `システムのEdge/Chromeが見つかりません: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`,
      };
    }

    try {
      log.info({ taskId, baseUrl }, '[preview] navigating headless tab to app');
      const nav = await worker.openAndNavigate({ url: baseUrl, timeoutMs: 25_000 });
      if (!nav.ok) throw new Error(nav.error || 'navigation failed');

      // Ownership check mirrors cleanupOwnAttempt's — only claim the `pending`
      // slot (and hand off to `sessions`) if a newer call hasn't already
      // replaced it out from under this one.
      if (pending.get(taskId)?.app !== app) {
        log.info({ taskId }, '[preview] superseded by a newer preview request — discarding');
        await worker.close().catch(() => {});
        app.stop();
        return { ok: false, reason: 'error', message: 'superseded by a newer preview request' };
      }
      pending.delete(taskId);
      sessions.set(taskId, {
        app,
        worker,
        url: baseUrl,
        startedAt: new Date(),
        lastAccessedAt: new Date(),
      });
      log.info({ taskId, baseUrl, port }, '[preview] session started');
      return { ok: true, url: baseUrl };
    } catch (e) {
      log.warn(
        { taskId, baseUrl, err: e instanceof Error ? e.message : e },
        '[preview] navigation to app failed',
      );
      await cleanupOwnAttempt(taskId, app, worker);
      return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  } finally {
    if (pending.get(taskId) === attempt) await killPending(taskId);
  }
}

/**
 * Stop a task's preview session (dev server + headless browser), AND cancel
 * an in-progress start attempt for the same task if one is still launching
 * (see `pending`) — e.g. the user clicks Stop while the UI is showing
 * "starting...". No-op if neither is present.
 *
 * @param taskId - Task whose preview to stop. / 対象タスクID
 */
export async function stopPreview(taskId: number): Promise<void> {
  requestVersions.set(taskId, (requestVersions.get(taskId) ?? 0) + 1);
  const s = sessions.get(taskId);
  if (s) {
    sessions.delete(taskId);
    await s.worker.close().catch(() => {});
    s.app.stop();
    log.info({ taskId }, '[preview] session stopped');
  }
  await killPending(taskId);
}

/**
 * Stop every active/in-progress preview session. Called from the backend's
 * graceful shutdown path so a `playwright-worker.mjs` process (and the
 * browser it launched) never outlives the backend process that started it —
 * previously nothing closed these on shutdown, so restarting the server
 * while a preview was open/starting left the worker + browser running as
 * orphans, accumulating across repeated restarts.
 */
export async function stopAllPreviewSessions(): Promise<void> {
  const taskIds = new Set<number>([...sessions.keys(), ...pending.keys()]);
  if (taskIds.size === 0) return;
  log.info({ count: taskIds.size }, '[preview] stopping all sessions for shutdown');
  await Promise.all([...taskIds].map((taskId) => stopPreview(taskId)));
}

export interface PreviewStatus {
  active: boolean;
  url?: string;
  startedAt?: string;
  /**
   * A start attempt is in flight (dev server booting / health-check polling
   * / browser launching) but not yet in `sessions`. Distinguishes "nothing
   * running, show Start" from "already starting elsewhere, don't offer
   * Start again" — e.g. the page was reloaded moments after clicking Start,
   * before the original (now-gone) request had a chance to resolve.
   */
  pending?: boolean;
}

/**
 * @param taskId - Task to check. / 対象タスクID
 * @returns Whether a preview is running (or starting), and since when. / 起動状態
 */
export function getPreviewStatus(taskId: number): PreviewStatus {
  const s = sessions.get(taskId);
  if (s) return { active: true, url: s.url, startedAt: s.startedAt.toISOString() };
  if (pending.has(taskId)) return { active: false, pending: true };
  return { active: false };
}

/**
 * Count of fully-established preview sessions right now — each one holds a
 * live playwright-worker.mjs process + browser + dev server. Surfaced in the
 * system status panel so this normally-invisible resource usage (the whole
 * reason this session spent effort on stray-process cleanup) is visible to
 * the user instead of only discoverable via manual process inspection.
 *
 * @returns Number of active sessions (does not include in-progress `pending` launches). / 起動中セッション数
 */
export function getActivePreviewCount(): number {
  return sessions.size;
}

export type ScreenshotResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; reason: 'not_active' | 'error'; message?: string };

/**
 * Screenshot the task's current preview tab. Re-screenshotting the SAME live
 * page (not re-navigating) lets the image reflect the dev server's own HMR
 * updates between polls, not just the state at start time.
 *
 * @param taskId - Task whose preview to screenshot. / 対象タスクID
 * @returns PNG buffer, or a reason the preview isn't available. / スクリーンショット結果
 */
export async function screenshotPreview(taskId: number): Promise<ScreenshotResult> {
  const s = sessions.get(taskId);
  if (!s) return { ok: false, reason: 'not_active' };
  s.lastAccessedAt = new Date();
  try {
    const buffer = await s.worker.screenshot();
    return { ok: true, buffer };
  } catch (e) {
    return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

// Idle sweep — stop sessions nobody has screenshotted in a while, so a user
// who navigates away without clicking "stop" doesn't leave a dev server (and
// a headless browser) running indefinitely. unref() so this timer alone
// never keeps the process alive.
setInterval(() => {
  const now = Date.now();
  for (const [taskId, s] of sessions) {
    if (now - s.lastAccessedAt.getTime() > IDLE_TIMEOUT_MS) {
      log.info({ taskId }, '[preview] idle session swept');
      void stopPreview(taskId);
    }
  }
}, SWEEP_INTERVAL_MS).unref();
