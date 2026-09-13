/**
 * DbWriteFaultInjector
 *
 * Wraps the eval Prisma client so a chosen write throws, reproducing the
 * "database rejected the write" scenario deterministically. A retry-count
 * knob is used rather than a real outage because the measurement wanted is
 * "does the orchestrator lose or duplicate state when a write fails", not
 * "how does Postgres fail".
 *
 * Reads are never faulted: a run that could not read its own corpus row would
 * fail for an uninteresting reason.
 */
import type { EvalPrismaClient } from './eval-prisma-client';

/** Delegates the injector can fault. */
export const FAULTABLE_DELEGATES = ['evalCorpusTask', 'evalRun', 'evalMetricSnapshot'] as const;

/** Write methods the injector counts and can fault. */
export const FAULTED_METHODS = ['create', 'update', 'upsert'] as const;

/** Error thrown in place of a real database write. */
export class InjectedDbWriteError extends Error {
  constructor(delegate: string, method: string, attempt: number) {
    super(`Injected database write failure on ${delegate}.${method} (write #${attempt})`);
    this.name = 'InjectedDbWriteError';
  }
}

/** Injector configuration. */
export interface DbWriteFaultOptions {
  /** 1-based index of the write that throws. */
  failOnWriteNumber: number;
  /** How many writes fail from that point. Default 1. */
  failCount?: number;
}

/** A wrapped client plus the counters the runner reports on. */
export interface FaultInjectedClient {
  client: EvalPrismaClient;
  /** Writes attempted through the wrapper so far. */
  writeCount(): number;
  /** Writes that were turned into an injected failure. */
  injectedFailureCount(): number;
}

/**
 * Wraps a client so the Nth write (and the next `failCount - 1` writes) throw.
 *
 * @param client - Client to wrap / ラップ対象のクライアント
 * @param options - Which write should fail / どの書き込みを失敗させるか
 * @returns The wrapped client and its counters / ラップ済みクライアントとカウンタ
 */
export function injectDbWriteFault(
  client: EvalPrismaClient,
  options: DbWriteFaultOptions,
): FaultInjectedClient {
  const failCount = options.failCount ?? 1;
  let writes = 0;
  let injected = 0;

  const wrapDelegate = (name: string, delegate: Record<string, unknown>): Record<string, unknown> =>
    new Proxy(delegate, {
      get(target, prop, receiver) {
        const key = String(prop);
        const original = Reflect.get(target, prop, receiver);
        if (!(FAULTED_METHODS as readonly string[]).includes(key)) return original;
        if (typeof original !== 'function') return original;

        return (...args: unknown[]) => {
          writes += 1;
          const withinFailWindow =
            writes >= options.failOnWriteNumber && writes < options.failOnWriteNumber + failCount;
          if (withinFailWindow) {
            injected += 1;
            // Rejected promise, not a synchronous throw: Prisma delegates are
            // async, so a sync throw would bypass the caller's `.catch`/`await`
            // path and test a code path that cannot happen in production.
            return Promise.reject(new InjectedDbWriteError(name, key, writes));
          }
          return (original as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });

  const wrapped = new Proxy(client as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      const key = String(prop);
      const original = Reflect.get(target, prop, receiver);
      if (!(FAULTABLE_DELEGATES as readonly string[]).includes(key)) return original;
      if (typeof original !== 'object' || original === null) return original;
      return wrapDelegate(key, original as Record<string, unknown>);
    },
  }) as unknown as EvalPrismaClient;

  return {
    client: wrapped,
    writeCount: () => writes,
    injectedFailureCount: () => injected,
  };
}
