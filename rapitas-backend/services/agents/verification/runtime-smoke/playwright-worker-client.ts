/**
 * playwright-worker-client
 *
 * Spawns playwright-worker.mjs under the system `node` binary (never `bun`)
 * and drives it over a line-delimited JSON protocol on stdin/stdout. See
 * that file's header for WHY this process boundary exists: Bun cannot
 * complete Playwright's CDP handshake with a real browser, confirmed live on
 * this machine (both the pipe and WebSocket transports hang until timeout
 * under Bun 1.3.13, while succeeding in under a second under plain Node.js).
 */
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { createLogger } from '../../../../config/logger';

const log = createLogger('playwright-worker-client');

const WORKER_SCRIPT = join(import.meta.dir, 'playwright-worker.mjs');
/** Default per-call timeout — bounds any single worker command, not just launch. */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** Result of a checkPath call — mirrors browser-smoke.ts's PathFinding minus the `path` field (the caller already knows it). */
export interface WorkerCheckPathResult {
  failedRequests?: string[];
  pendingRequests?: string[];
  httpStatus: number;
  navigationError: string | null;
  pageErrors: string[];
  consoleErrors: string[];
  serverErrors: string[];
  screenshotPath: string | null;
}

/** Result of inspecting a page-space point for a native <select>. */
export interface SelectInspection {
  isSelect: boolean;
  value?: string;
  /** The select's own on-page bounding box (page-space, same coordinate system as click x/y) — lets the overlay align to it instead of the raw click point. */
  rect?: { x: number; y: number; width: number; height: number };
  options?: Array<{ value: string; label: string; selected: boolean; disabled: boolean }>;
}

export interface PlaywrightWorker {
  /**
   * Launch a browser, trying each channel in order; resolves with the
   * channel that succeeded.
   */
  launch(opts: {
    channels: readonly string[];
    timeoutMs?: number;
    viewport?: { width: number; height: number };
    /** Explicit `false` opens a real, visible OS browser window instead of the default headless mode. */
    headless?: boolean;
  }): Promise<{ channel: string }>;
  /** Open a fresh page and navigate it — the page stays open for subsequent screenshot() calls. */
  openAndNavigate(opts: {
    url: string;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; error?: string }>;
  /** Screenshot the currently-open page (from openAndNavigate). */
  screenshot(): Promise<Buffer>;
  /** Click at page-space coordinates (already scaled from displayed image size by the caller). */
  click(opts: { x: number; y: number }): Promise<void>;
  /** Type literal text at the current focus (click a field first). */
  type(opts: { text: string }): Promise<void>;
  /** Press a single named key — Playwright key names (e.g. "Enter", "Backspace", "ArrowLeft"). */
  pressKey(opts: { key: string }): Promise<void>;
  /** Scroll the page by a pixel delta. */
  scroll(opts: { deltaX?: number; deltaY?: number }): Promise<void>;
  /** Check whether a page-space point is inside a <select> — its native dropdown never appears in a screenshot, so the caller must detect this BEFORE clicking. */
  inspectSelect(opts: { x: number; y: number }): Promise<SelectInspection>;
  /** Set a <select>'s value directly (bypasses the native dropdown), firing input/change. */
  selectOption(opts: { x: number; y: number; value: string }): Promise<void>;
  /** One-shot navigate + settle + collect + screenshot + close for a single path. */
  checkPath(opts: {
    url: string;
    timeoutMs?: number;
    settleMs?: number;
    readySelector?: string;
    readinessTimeoutMs?: number;
    screenshotPath?: string;
  }): Promise<WorkerCheckPathResult>;
  /** Close the browser and terminate the worker process. Idempotent. */
  close(): Promise<void>;
}

interface PendingCall {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

/**
 * Spawn a new playwright-worker.mjs process and return a typed client for it.
 *
 * @returns A worker handle — call `.close()` when done, even on failure paths,
 *   to avoid leaking the child process. / ワーカーへのハンドル
 */
export function spawnPlaywrightWorker(): PlaywrightWorker {
  const proc: ChildProcess = spawn(process.env.RAPITAS_NODE_BIN || 'node', [WORKER_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let nextId = 1;
  const pending = new Map<number, PendingCall>();
  let stdoutBuffer = '';
  let exited = false;
  let spawnError: string | null = null;

  proc.on('error', (err) => {
    // ENOENT (no system `node` on PATH) lands here — reject anything already
    // queued and remember the reason so later calls fail with a clear cause
    // instead of a generic "worker exited" message.
    spawnError = err.message;
    for (const [, p] of pending) {
      clearTimeout(p.timeoutId);
      p.reject(new Error(`playwright worker failed to start: ${err.message}`));
    }
    pending.clear();
  });

  proc.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    let idx = stdoutBuffer.indexOf('\n');
    while (idx >= 0) {
      const line = stdoutBuffer.slice(0, idx);
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (line.trim()) handleLine(line);
      idx = stdoutBuffer.indexOf('\n');
    }
  });

  function handleLine(line: string): void {
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      // A stray non-protocol line (e.g. a dependency logging to stdout) must
      // not crash the client — just ignore it.
      log.debug({ line: line.slice(0, 200) }, '[playwright-worker] ignoring non-JSON stdout line');
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timeoutId);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'worker command failed'));
  }

  proc.on('exit', (code) => {
    exited = true;
    for (const [, p] of pending) {
      clearTimeout(p.timeoutId);
      p.reject(new Error(`playwright worker exited (code ${code})`));
    }
    pending.clear();
  });

  function call<T>(
    cmd: string,
    args: Record<string, unknown> = {},
    timeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  ): Promise<T> {
    if (exited) {
      return Promise.reject(new Error(spawnError || 'playwright worker already exited'));
    }
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pending.delete(id);
        // A stuck command likely means the worker itself (or the browser it
        // launched) is wedged — kill the whole tree rather than leaving it
        // to accumulate as an orphan (same class of leak this replaces the
        // regex-PID-parsing workaround for).
        proc.kill();
        reject(new Error(`playwright worker command "${cmd}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timeoutId });
      proc.stdin?.write(`${JSON.stringify({ id, cmd, args })}\n`, (err) => {
        if (err) {
          pending.delete(id);
          clearTimeout(timeoutId);
          reject(err);
        }
      });
    });
  }

  return {
    async launch(opts) {
      return call(
        'launch',
        {
          channels: opts.channels,
          timeoutMs: opts.timeoutMs,
          viewport: opts.viewport,
          headless: opts.headless,
        },
        (opts.timeoutMs ?? 20_000) + 5_000,
      );
    },
    async openAndNavigate(opts) {
      return call('openAndNavigate', { url: opts.url, timeoutMs: opts.timeoutMs });
    },
    async screenshot() {
      const { buffer } = await call<{ buffer: string }>('screenshot');
      return Buffer.from(buffer, 'base64');
    },
    async click(opts) {
      await call('click', { x: opts.x, y: opts.y });
    },
    async type(opts) {
      await call('type', { text: opts.text });
    },
    async pressKey(opts) {
      await call('pressKey', { key: opts.key });
    },
    async scroll(opts) {
      await call('scroll', { deltaX: opts.deltaX, deltaY: opts.deltaY });
    },
    async inspectSelect(opts) {
      return call('inspectSelect', { x: opts.x, y: opts.y });
    },
    async selectOption(opts) {
      await call('selectOption', { x: opts.x, y: opts.y, value: opts.value });
    },
    async checkPath(opts) {
      return call(
        'checkPath',
        {
          url: opts.url,
          timeoutMs: opts.timeoutMs,
          settleMs: opts.settleMs,
          readySelector: opts.readySelector,
          readinessTimeoutMs: opts.readinessTimeoutMs,
          screenshotPath: opts.screenshotPath,
        },
        (opts.timeoutMs ?? 25_000) +
          (opts.settleMs ?? 2_000) +
          (opts.readySelector ? (opts.readinessTimeoutMs ?? 25_000) : 0) +
          5_000,
      );
    },
    async close() {
      if (exited) return;
      try {
        await call('close', {}, 10_000);
      } catch {
        // Already gone, or didn't respond in time — kill() below covers both.
      }
      proc.kill();
    },
  };
}
