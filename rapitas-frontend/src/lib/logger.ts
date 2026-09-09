import { isServerRestarting } from '@/stores/server-restart-store';

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

const current: LogLevel =
  (process.env.NEXT_PUBLIC_LOG_LEVEL as LogLevel) ??
  (process.env.NODE_ENV === 'production' ? 'warn' : 'debug');

/**
 * Throttling final output timestamp management
 * key: "prefix|first 80 chars of message" → last output time
 */
const throttleMap = new Map<string, number>();
const THROTTLE_WINDOW_MS = 5_000;

function shouldThrottle(key: string, windowMs = THROTTLE_WINDOW_MS): boolean {
  const now = Date.now();
  const last = throttleMap.get(key);
  if (last !== undefined && now - last < windowMs) {
    return true;
  }
  throttleMap.set(key, now);
  return false;
}

function makeThrottleKey(prefix: string, args: unknown[]): string {
  const msg = typeof args[0] === 'string' ? args[0].slice(0, 80) : '';
  return `${prefix}|${msg}`;
}

/**
 * Determine if error is transient network error
 */
export function isTransientError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false;
  const err = error as { name?: string; message?: string; cause?: unknown };
  if (!err.name && !err.message) return false;
  const name = err.name ?? '';
  const message = err.message ?? '';
  // TypeError: Failed to fetch (network disconnection)
  if (name === 'TypeError' && message.includes('Failed to fetch')) return true;
  // AbortError (timeout)
  if (name === 'AbortError' || message.includes('aborted')) return true;
  // If cause exists, check recursively
  if (err.cause != null) return isTransientError(err.cause);
  // Message contains network-related keywords
  if (/network|timeout|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(message)) return true;
  return false;
}

export function createLogger(name: string) {
  const p = `[${name}]`;
  const ok = (l: LogLevel) => LEVELS[l] >= LEVELS[current];
  return {
    debug: (...a: unknown[]) => ok('debug') && console.debug(p, ...a),
    info: (...a: unknown[]) => ok('info') && console.info(p, ...a),
    // warn/error are silenced during an intentional backend restart: the
    // frontend's pollers all fail for the ~15s the server is down, producing
    // an expected flood of network errors that should not surface as noise.
    warn: (...a: unknown[]) => !isServerRestarting() && ok('warn') && console.warn(p, ...a),
    error: (...a: unknown[]) => !isServerRestarting() && ok('error') && console.error(p, ...a),

    /** Transient warning: emit at most once per message per minute. */
    warnThrottled: (...a: unknown[]) => {
      if (isServerRestarting() || !ok('warn')) return;
      if (shouldThrottle(`warn|${makeThrottleKey(p, a)}`, 60_000)) return;
      console.warn(p, ...a);
    },

    /**
     * Error log with throttling
     * Same message output only once within THROTTLE_WINDOW_MS (5 sec)
     * Duplicates demoted to debug level
     */
    errorThrottled: (...a: unknown[]) => {
      if (isServerRestarting()) return;
      if (!ok('warn')) return;
      const key = makeThrottleKey(p, a);
      if (shouldThrottle(key)) {
        if (ok('debug')) console.debug(p, '[throttled]', ...a);
        return;
      }
      if (ok('error')) console.error(p, ...a);
    },

    /**
     * Log for transient errors (NetworkError, Timeout, etc.)
     * Output transient errors at warn level, others at error level
     */
    transientError: (message: string, error?: unknown, ...rest: unknown[]) => {
      if (isServerRestarting()) return;
      if (isTransientError(error)) {
        if (ok('warn')) console.warn(p, message, error, ...rest);
      } else {
        if (ok('error')) console.error(p, message, error, ...rest);
      }
    },
  };
}
