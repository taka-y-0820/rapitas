/**
 * APIClient
 *
 * Optimized HTTP client providing caching, request deduplication, debouncing,
 * throttling, parallel fetching, prefetching, and batch support.
 * Not responsible for persistence — that is delegated to ApiClientCache.
 */

import { API_BASE_URL } from '@/utils/api';
import { offlineFetch } from '@/lib/offline-queue';
import { createLogger } from '@/lib/logger';
import { ApiClientCache } from './cache';
import { ApiClientBatch } from './batch';
import type { RequestOptions } from './types';

const logger = createLogger('api-client');

/**
 * Hard ceiling on any single API request. Without a cap, a stalled
 * connection (backend deadlock, dropped TCP keep-alive, etc.) leaves the
 * promise hanging forever. The same promise is then returned by the
 * in-flight dedup map, so EVERY subsequent caller for the same path also
 * hangs — which is exactly the "task detail page stays in loading state
 * until server restart" symptom users reported. Restarting the backend
 * forced TCP RST → fetch finally rejected → queue cleared → recovery.
 *
 * 30s is generous enough for legitimately slow workflow endpoints but
 * short enough that a recoverable hang surfaces as an actionable error.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Marks every request from this client as UI-originated so the backend's
 * ui-activity-tracker can defer boundary self-restarts while the user is
 * actively operating the UI (RAPITAS_RESTART_UI_QUIET_MS quiet gate).
 *
 * NOTE: Values must mirror UI_SOURCE_HEADER / UI_SOURCE_VALUE in
 * rapitas-backend/services/scheduling/auto-restart-merged-code/ui-activity-tracker.ts
 * — the backend constants cannot be imported across packages.
 */
export const UI_SOURCE_HEADER = 'X-Rapitas-Source';
export const UI_SOURCE_VALUE = 'ui';

/**
 * Per-attempt timeout for idempotent GETs. A healthy backend serves GETs in
 * well under a second (verified: GET /tasks/:id ≈ 0.2s), so a GET that stalls
 * this long is almost always a dead/stale keep-alive connection or a transient
 * backend hiccup under load — NOT a legitimately slow response. Aborting at 15s
 * frees the connection and lets the retry below open a FRESH one, which is what
 * turns the "task detail page never loads (Request timeout after 30002ms)"
 * symptom into an automatic recovery.
 */
const GET_ATTEMPT_TIMEOUT_MS = 15_000;
/** Transient-error retries for idempotent GETs (mutations are never retried). */
const MAX_GET_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 300;

/** Whether an error from performFetch is transient and safe to retry a GET on. */
export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('Request timeout after') || // our abort timeout
    msg.includes('Failed to fetch') || // network / dropped connection
    /API Error: 5\d\d/.test(msg) // 5xx
  );
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class APIClient {
  private cache = new ApiClientCache();
  private batch = new ApiClientBatch();
  private requestQueue = new Map<string, Promise<unknown>>();
  private requestQueueAt = new Map<string, number>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private throttleLastCall = new Map<string, number>();

  constructor() {
    // Belt-and-braces sweep: drop any in-flight entry older than 2× the
    // timeout. This protects against edge cases where the abort signal
    // didn't actually surface a rejection (custom transports, polyfills,
    // etc.). The map is a memory cache only — clearing it loses dedup
    // benefit for that one request, never correctness.
    if (typeof window !== 'undefined') {
      window.setInterval(
        () => this.sweepStaleRequestQueueEntries(REQUEST_TIMEOUT_MS * 2),
        REQUEST_TIMEOUT_MS,
      );
      // Also sweep when the tab becomes visible again — covers the
      // "laptop closed for 5 minutes, all promises orphaned" case.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this.sweepStaleRequestQueueEntries(REQUEST_TIMEOUT_MS);
        }
      });
    }
  }

  private sweepStaleRequestQueueEntries(maxAgeMs: number): void {
    const now = Date.now();
    for (const [key, startedAt] of this.requestQueueAt) {
      if (now - startedAt > maxAgeMs) {
        this.requestQueue.delete(key);
        this.requestQueueAt.delete(key);
      }
    }
  }

  /**
   * Basic fetch with caching and in-flight deduplication.
   *
   * @param path - API path relative to base URL / ベースURLからの相対パス
   * @param options - Fetch options including cache control / キャッシュ制御を含むフェッチオプション
   * @returns Response typed as T / レスポンス
   */
  async fetch<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = `${API_BASE_URL}${path}`;
    const cacheKey = `${options.method || 'GET'}:${url}:${JSON.stringify(options.body || {})}`;

    if (!options.skipCache && (!options.method || options.method === 'GET')) {
      const cached = this.cache.get<T>(cacheKey);
      if (cached) return cached;
    }

    const existingRequest = this.requestQueue.get(cacheKey);
    if (existingRequest) return existingRequest as Promise<T>;

    const isGet = !options.method || options.method.toUpperCase() === 'GET';
    // Retry idempotent GETs on transient errors (timeout / dropped connection /
    // 5xx). The retry runs INSIDE the deduped promise, so every caller waiting on
    // this path gets the recovered result instead of a shared timeout failure.
    const runner =
      isGet && !options.skipRetry
        ? () => this.getWithRetries<T>(url, options)
        : () => this.performFetch<T>(url, options, options.timeoutMs ?? REQUEST_TIMEOUT_MS);

    const request = runner()
      .then((data) => {
        if (options.method === 'GET' || !options.method) {
          this.cache.set(cacheKey, data, options.cacheTime);
        }
        this.requestQueue.delete(cacheKey);
        this.requestQueueAt.delete(cacheKey);
        return data;
      })
      .catch((error) => {
        this.requestQueue.delete(cacheKey);
        this.requestQueueAt.delete(cacheKey);
        throw error;
      });

    this.requestQueue.set(cacheKey, request);
    this.requestQueueAt.set(cacheKey, Date.now());
    return request;
  }

  /**
   * Run an idempotent GET with bounded retries on transient errors, each
   * attempt on a fresh connection (the prior attempt's socket is aborted). This
   * recovers from a stale/dropped keep-alive that would otherwise stall until
   * the hard timeout and blank the page.
   */
  private async getWithRetries<T>(url: string, options: RequestOptions): Promise<T> {
    const perAttempt = options.timeoutMs ?? GET_ATTEMPT_TIMEOUT_MS;
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_GET_RETRIES; attempt++) {
      try {
        return await this.performFetch<T>(url, options, perAttempt);
      } catch (err) {
        lastError = err;
        if (attempt === MAX_GET_RETRIES || !isTransientError(err)) throw err;
        await delay(RETRY_BASE_DELAY_MS * (attempt + 1));
      }
    }
    throw lastError;
  }

  /**
   * Queue a request into the next batch window.
   *
   * @param path - API path / APIパス
   * @param options - Fetch options / フェッチオプション
   * @returns Response typed as T / レスポンス
   */
  async batchFetch<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.batch.enqueue<T>(path, options, (p, o) => this.fetch(p, o));
  }

  /**
   * Execute only the last of consecutive identical requests within the delay window.
   *
   * @param path - API path / APIパス
   * @param options - Fetch options / フェッチオプション
   * @param delay - Debounce delay in milliseconds / デバウンス遅延（ミリ秒）
   * @returns Response typed as T / レスポンス
   */
  async debouncedFetch<T = unknown>(
    path: string,
    options: RequestOptions = {},
    delay: number = 300,
  ): Promise<T> {
    const key = `${path}:${JSON.stringify(options)}`;

    return new Promise((resolve, reject) => {
      const existing = this.debounceTimers.get(key);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(async () => {
        try {
          const result = await this.fetch<T>(path, options);
          resolve(result);
          this.debounceTimers.delete(key);
        } catch (error) {
          reject(error);
          this.debounceTimers.delete(key);
        }
      }, delay);

      this.debounceTimers.set(key, timer);
    });
  }

  /**
   * Execute a request at most once per interval; returns cached data when throttled.
   *
   * @param path - API path / APIパス
   * @param options - Fetch options / フェッチオプション
   * @param interval - Minimum interval between calls in milliseconds / 最小呼び出し間隔（ミリ秒）
   * @returns Response typed as T / レスポンス
   * @throws {Error} When throttled and no cached data is available / スロットル中かつキャッシュなしの場合
   */
  async throttledFetch<T = unknown>(
    path: string,
    options: RequestOptions = {},
    interval: number = 1000,
  ): Promise<T> {
    const key = `${path}:${JSON.stringify(options)}`;
    const now = Date.now();
    const lastCall = this.throttleLastCall.get(key) || 0;

    if (now - lastCall < interval) {
      const cacheKey = `${options.method || 'GET'}:${API_BASE_URL}${path}:${JSON.stringify(options.body || {})}`;
      const cached = this.cache.get<T>(cacheKey);
      if (cached) return cached;
      throw new Error('Request throttled and no cache available');
    }

    this.throttleLastCall.set(key, now);
    return this.fetch<T>(path, options);
  }

  /**
   * Execute multiple named requests in parallel; individual failures do not abort others.
   *
   * @param requests - Map of result key to request descriptor / 結果キーとリクエスト定義のマップ
   * @returns Record keyed by request name; failures contain `{ error }` / リクエスト名をキーとするレコード
   */
  async parallelFetch<T extends Record<string, unknown>>(
    requests: Record<string, { path: string; options?: RequestOptions }>,
  ): Promise<T> {
    const entries = Object.entries(requests);
    const results = await Promise.allSettled(
      entries.map(([_, req]) => this.fetch(req.path, req.options)),
    );

    const response: Record<string, unknown> = {};
    entries.forEach(([key], index) => {
      const result = results[index];
      response[key] = result.status === 'fulfilled' ? result.value : { error: result.reason };
    });

    return response as T;
  }

  /**
   * Warm up the cache by pre-fetching a list of paths.
   *
   * @param paths - API paths to prefetch / プリフェッチするAPIパス一覧
   * @param cacheTime - TTL in milliseconds / ミリ秒単位のTTL
   */
  async prefetch(paths: string[], cacheTime?: number): Promise<void> {
    await Promise.allSettled(paths.map((path) => this.fetch(path, { cacheTime })));
  }

  /**
   * Clear cache entries matching a pattern, or clear all entries.
   *
   * @param pattern - Optional substring to match against cache keys / キャッシュキーに対するサブ文字列フィルター
   */
  clearCache(pattern?: string): void {
    this.cache.clear(pattern);
  }

  /**
   * Return aggregate cache statistics for diagnostics.
   *
   * @returns Size in bytes and per-entry metadata / バイト単位のサイズとエントリメタデータ
   */
  getCacheStats(): {
    size: number;
    entries: Array<{ key: string; size: number; age: number }>;
  } {
    return this.cache.getStats();
  }

  /**
   * Low-level fetch with auth credentials and JSON content-type.
   *
   * Uses `offlineFetch` from lib/offline-queue so that write requests
   * (POST/PUT/PATCH/DELETE) are automatically queued in IndexedDB when
   * the network is unavailable and replayed when it comes back.
   * GET requests pass through to native fetch — they are not queued.
   *
   * When a mutation is queued offline, `offlineFetch` returns a synthetic
   * `202 Accepted` with body `{ queued: true }`. We detect this case and
   * return it as `T` (the caller will see a partial response, but the
   * mutation is durably persisted and will replay on reconnection).
   *
   * @param url - Full URL / 完全なURL
   * @param options - Fetch options / フェッチオプション
   * @returns Parsed JSON response / パース済みJSONレスポンス
   * @throws {Error} On non-2xx responses / 2xx以外のレスポンス時
   */
  private async performFetch<T>(
    url: string,
    options: RequestOptions,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const requestStartedAt = Date.now();
    const method = (options.method || 'GET').toUpperCase();
    const requestLabel = `${method} ${(() => {
      try {
        return new URL(url).pathname + new URL(url).search;
      } catch {
        return url;
      }
    })()}`;

    // Compose any caller-provided AbortSignal with our timeout signal so
    // either source can cancel the request. AbortSignal.any is in modern
    // browsers; fall back to manual chaining when unavailable.
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      // Surface BOTH the URL and the elapsed time so the user can find
      // which endpoint stalled without diving into devtools network tab.
      const elapsed = Date.now() - requestStartedAt;
      const msg = `Request timeout after ${elapsed}ms — ${requestLabel}`;

      // A timeout is a transient transport failure. Group the warning across
      // endpoints for one minute; the caller still receives the full error.
      logger.warnThrottled('[api-client] timeout', requestLabel);
      timeoutController.abort(new Error(msg));
    }, timeoutMs);

    let signal: AbortSignal = timeoutController.signal;
    const callerSignal = (options as RequestOptions & { signal?: AbortSignal }).signal;
    if (callerSignal) {
      const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal })
        .any;
      if (typeof anyFn === 'function') {
        signal = anyFn([timeoutController.signal, callerSignal]);
      } else if (callerSignal.aborted) {
        timeoutController.abort(callerSignal.reason);
      } else {
        callerSignal.addEventListener('abort', () => timeoutController.abort(callerSignal.reason));
      }
    }

    const fetchInit: RequestInit = {
      ...options,
      signal,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        [UI_SOURCE_HEADER]: UI_SOURCE_VALUE,
        ...options.headers,
      },
    };

    try {
      // NOTE: offlineFetch relies on IndexedDB and navigator.onLine which
      // only exist in the browser. During SSR (Next.js server components)
      // fall back to native fetch — offline queuing is a client-only concern.
      let response: Response;
      if (typeof window !== 'undefined') {
        const pathname = (() => {
          try {
            return new URL(url).pathname;
          } catch {
            return url;
          }
        })();
        response = await offlineFetch(url, fetchInit, `${method} ${pathname}`);
      } else {
        response = await fetch(url, fetchInit);
      }

      if (!response.ok) {
        const error = await response.text().catch(() => 'Unknown error');
        throw new Error(`API Error: ${response.status} (${requestLabel}) - ${error}`);
      }

      return response.json();
    } catch (err) {
      // Annotate ANY thrown error (including AbortError from non-timeout
      // sources) with the request label so it surfaces in the UI toast
      // / console rather than appearing as a bare "AbortError".
      if (err instanceof Error && !err.message.includes(requestLabel)) {
        const annotated = new Error(`${err.message} — ${requestLabel}`);
        annotated.stack = err.stack;
        (annotated as Error & { cause?: unknown }).cause = err;
        throw annotated;
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
