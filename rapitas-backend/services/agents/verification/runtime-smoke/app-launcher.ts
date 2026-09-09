/**
 * runtime-smoke/app-launcher
 *
 * Starts the app-under-test on a dynamically allocated FREE port (so it can
 * never collide with rapitas itself or another project squatting a fixed
 * port), polls until it responds, and guarantees process-tree teardown.
 */
import { spawn, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import { existsSync, realpathSync } from 'fs';
import { dirname, join } from 'path';
import { createLogger } from '../../../../config/logger';
import { killProcessTreeSafely } from '../../agent-process-tracker';

const log = createLogger('runtime-smoke:launcher');

/** Max combined output lines retained for failure evidence. */
const MAX_LOG_LINES = 200;

/**
 * Allocate an OS-assigned free TCP port.
 *
 * @returns A currently-free port number / 空きポート番号
 */
export function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('no port allocated'))));
    });
  });
}

/** Handle for a launched app-under-test. */
export interface LaunchedApp {
  /** Last captured stdout/stderr lines (failure evidence). */
  logs(): string[];
  /** Kill the whole process tree. Idempotent. */
  stop(): void;
  /** Marks an intentional stop performed by the identity-aware registry. */
  markStopRequested?(): void;
  pid: number | undefined;
  /** True once the process has exited, whether crashed or intentionally stopped. */
  hasExited(): boolean;
  /** Exit code once the process has exited, else null. */
  exitCode(): number | null;
}

/**
 * Compute a `turbopack.root` override that covers a worktree's
 * `rapitas-frontend/node_modules` junction, which links back to the main
 * checkout and therefore resolves OUTSIDE the worktree root that
 * `next.config.ts` uses by default. Turbopack refuses to start when its root
 * doesn't contain every real path it touches ("points out of the filesystem
 * root"), so the override must be the common ancestor of the worktree and the
 * junction's real target — two directories above the resolved node_modules
 * (`.../rapitas-frontend/node_modules` -> `.../rapitas-frontend` -> the repo
 * root shared by every worktree and the main checkout).
 *
 * @param cwd - App launch cwd (expected to contain `rapitas-frontend/`). / 起動cwd
 * @returns Common-ancestor path, or undefined when not resolvable (non-worktree
 *          layouts, missing node_modules) — callers should leave the existing
 *          turbopack root untouched in that case. / 解決不能なら undefined
 */
export function computeTurbopackRootOverride(cwd: string): string | undefined {
  try {
    const nodeModulesPath = join(cwd, 'rapitas-frontend', 'node_modules');
    if (!existsSync(nodeModulesPath)) return undefined;
    const realNodeModules = realpathSync(nodeModulesPath);
    return dirname(dirname(realNodeModules));
  } catch {
    return undefined;
  }
}

/**
 * Spawn the app's start command in the worktree.
 *
 * @param command - Shell command (already port-substituted) / 起動コマンド
 * @param cwd - Worktree root / 作業ディレクトリ
 * @param port - Allocated port, also exported as env PORT / 割り当てポート
 * @returns Launch handle / 起動ハンドル
 */
export function launchApp(command: string, cwd: string, port: number): LaunchedApp {
  const lines: string[] = [];
  const push = (chunk: Buffer | string): void => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      lines.push(line.length > 400 ? `${line.slice(0, 400)}…` : line);
      if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
    }
  };

  const turbopackRoot = computeTurbopackRootOverride(cwd);
  log.info({ command, cwd, port, turbopackRoot }, '[runtime-smoke] launching app under test');
  const proc: ChildProcess = spawn(command, {
    shell: true,
    cwd,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      BROWSER: 'none',
      CI: '1',
      ...(turbopackRoot ? { RAPITAS_TURBOPACK_ROOT: turbopackRoot } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', push);
  proc.stderr?.on('data', push);
  proc.on('error', (err) => push(`[spawn error] ${err.message}`));

  let stopped = false;
  let stopRequested = false;
  let exited = false;
  let lastExitCode: number | null = null;
  proc.on('exit', (code) => {
    exited = true;
    lastExitCode = code;
    if (!stopped && !stopRequested) {
      // Exiting before anyone called stop() means the app crashed on its
      // own — this is the fast, precise failure signal that used to be
      // masked by waitForHealthy() spinning for the full readyTimeoutMs
      // before falling back to a log-text guess.
      log.warn(
        { command, cwd, port, exitCode: code, logsTail: lines.slice(-25).join('\n') },
        '[runtime-smoke] app exited unexpectedly before it was stopped',
      );
    }
  });

  return {
    pid: proc.pid,
    logs: () => [...lines],
    hasExited: () => exited,
    exitCode: () => lastExitCode,
    markStopRequested: () => {
      stopRequested = true;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (proc.pid) {
        // killProcessTreeSafely refuses the port-3001 backend, so a
        // misconfigured start command can never take rapitas down. Passing
        // cwd lets it sweep subtrees orphaned by a dead intermediate parent
        // (tauri-cli's BeforeDevCommand leak) that `taskkill /T` cannot reach.
        killProcessTreeSafely(proc.pid, { workdir: cwd });
      }
    },
  };
}

/** Emit a heartbeat log line every this many poll attempts (~7.5s at the 1.5s poll interval). */
const HEALTH_LOG_EVERY_N_ATTEMPTS = 5;

/**
 * Poll a URL until the app responds (any HTTP status < 500 counts as "up" —
 * a dev server 404 on the health path still proves the process is serving).
 *
 * The poll loop used to be silent end-to-end — a stuck launch produced no
 * server-side signal beyond the initial spawn log until the overall timeout
 * fired, making it impossible to tell whether the app was still compiling,
 * refusing every connection, or the health check itself had hung. Logs a
 * heartbeat every few attempts plus a final success/timeout summary so the
 * stall point is visible in the running server's logs, not just inferred
 * after the fact from `app.logs()`.
 *
 * @param url - Health URL / ヘルスチェックURL
 * @param timeoutMs - Overall deadline / 全体タイムアウト
 * @param logContext - Extra fields (e.g. taskId) merged into every log line for correlation. / ログ相関用の追加フィールド
 * @param shouldAbort - Checked every poll iteration; returning true short-circuits
 *   the wait immediately instead of spinning until timeoutMs (e.g. the launched
 *   process already crashed). / 早期終了判定
 * @returns true when responsive within the deadline / 応答すれば true
 */
export async function waitForHealthy(
  url: string,
  timeoutMs: number,
  logContext: Record<string, unknown> = {},
  shouldAbort?: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let attempt = 0;
  let lastStatus: number | undefined;
  let lastError = '';
  log.info({ url, timeoutMs, ...logContext }, '[runtime-smoke] polling health endpoint');
  while (Date.now() < deadline) {
    if (shouldAbort?.()) {
      log.warn(
        { url, attempt, elapsedMs: Date.now() - startedAt, ...logContext },
        '[runtime-smoke] health poll aborted — launched process already exited',
      );
      return false;
    }
    attempt++;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4_000) });
      lastStatus = res.status;
      if (res.status < 500) {
        log.info(
          { url, attempt, elapsedMs: Date.now() - startedAt, status: res.status, ...logContext },
          '[runtime-smoke] health check succeeded',
        );
        return true;
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (attempt % HEALTH_LOG_EVERY_N_ATTEMPTS === 0) {
      log.info(
        {
          url,
          attempt,
          elapsedMs: Date.now() - startedAt,
          remainingMs: Math.max(0, deadline - Date.now()),
          lastStatus,
          lastError,
          ...logContext,
        },
        '[runtime-smoke] still waiting for health check',
      );
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  log.warn(
    {
      url,
      attempts: attempt,
      elapsedMs: Date.now() - startedAt,
      lastStatus,
      lastError,
      ...logContext,
    },
    '[runtime-smoke] health check timed out',
  );
  return false;
}
