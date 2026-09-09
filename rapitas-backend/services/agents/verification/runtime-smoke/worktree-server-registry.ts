/**
 * runtime-smoke/worktree-server-registry
 *
 * Workdir-scoped ownership registry for the Next.js (or other) dev servers
 * launched by runtime-smoke verification and live preview. Both features used
 * to call app-launcher.launchApp() directly and independently, so two
 * concurrent requests against the SAME worktree raced Next's own
 * single-instance directory lock ("Another next dev server is already
 * running") — task 906 observed a fresh runtime-smoke job losing that race
 * against a leftover verification server from moments earlier.
 *
 * This module is the single chokepoint: callers ask for a server via
 * acquireRuntimeServer() and get back either a reused/newly-launched server
 * (with a lease they must releaseRuntimeServer()) or a bounded
 * wait-then-fail result. It never spawns a second process for a workdir that
 * already has one starting/active, and it never kills a process it cannot
 * positively re-identify as its own (see runtime-server-registry-lifecycle's
 * stopOwnedAndVerify). Recovery uses persisted OS birth identities;
 * termination independently protects port 3001.
 *
 * State machine (spawn/stop) lives in runtime-server-registry-lifecycle.ts;
 * durable state lives in runtime-server-registry-persistence.ts; shared types
 * and the registry Map live in runtime-server-registry-types.ts — this file
 * is the public entry point (acquire/release/recover) that composes them.
 */
import { randomUUID } from 'crypto';
import { createLogger } from '../../../../config/logger';
import { extendOwnedRuntimeTree, inspectOwnedRuntimeTree } from './runtime-process-identity';
import { readRuntimeProcessSnapshot, ownsRuntimePort } from './runtime-process-snapshot';
import type { RuntimeConfig } from './runtime-config';
import {
  cancelIdleTimer,
  delay,
  DEFAULT_WAIT_TIMEOUT_MS,
  failure,
  fingerprintConfig,
  nextGeneration,
  normalizeWorkdirKey,
  POLL_INTERVAL_MS,
  registry,
  resetGenerationCounter,
  type AcquireOptions,
  type AcquireResult,
  type RegistryEntry,
  type RegistryState,
} from './runtime-server-registry-types';
import {
  ownershipStore,
  persistActive,
  persistQuarantine,
} from './runtime-server-registry-persistence';
import {
  scheduleIdleStop,
  spawnNewEntry,
  stopOwnedAndVerify,
} from './runtime-server-registry-lifecycle';

const log = createLogger('runtime-smoke:registry');

export { DEFAULT_WAIT_TIMEOUT_MS, normalizeWorkdirKey };
export type {
  AcquireOptions,
  AcquireResult,
  AcquireSuccess,
  AcquireFailure,
} from './runtime-server-registry-types';

/**
 * Wait for `key`'s entry to change state (or disappear), bounded by
 * `deadline`/`signal`. Prefers awaiting the entry's own start/stop promise
 * (resolves immediately on completion); falls back to a short poll for the
 * "active but occupied by an incompatible config" drain-wait, since that has
 * no single promise to await (its end is simply the entry disappearing).
 */
async function waitForStateChange(
  key: string,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<void> {
  const entry = registry.get(key);
  const remaining = Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
  let onAbort: (() => void) | undefined;
  const abortWait = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    if (signal?.aborted) resolve();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const progress = entry?.state === 'starting' ? entry.startPromise : entry?.stopPromise;
    await Promise.race([...(progress ? [progress] : []), abortWait, delay(remaining)]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Acquire ownership of the workdir's runtime server: reuse an active,
 * config-compatible server (issuing a new lease), await another caller's
 * in-flight start/stop, wait for an incompatible-config occupant to drain, or
 * spawn a fresh one when the workdir is free. Never spawns a second process
 * for a workdir with a `starting`/`active` entry already present.
 *
 * @param workdir - Worktree/working directory to run the app in. / 作業ディレクトリ
 * @param cfg - Resolved runtime config (start/url/healthPath/readyTimeoutMs). / 起動設定
 * @param opts - Wait bound, abort signal, log label. / 追加オプション
 * @returns Success with a lease to release when done, or a bounded failure. / 取得結果
 */
const acquiring = new Map<string, Set<symbol>>();

/** Each borrower cancels its own wait; only the last departure cancels startup. */
export async function acquireRuntimeServer(
  workdir: string,
  cfg: RuntimeConfig,
  opts: AcquireOptions = {},
): Promise<AcquireResult> {
  const key = normalizeWorkdirKey(workdir);
  if (!key) return failure(`worktreeパスを解決できません: ${workdir}`);
  if (opts.signal?.aborted) return failure('待機が中断されました', { unverifiable: true });
  const token = Symbol('acquire');
  const consumers = acquiring.get(key) ?? new Set<symbol>();
  consumers.add(token);
  acquiring.set(key, consumers);
  let aborted = false;
  let onAbort: (() => void) | undefined;
  const operation = acquireRuntimeServerInternal(workdir, cfg, opts);
  const abortResult = new Promise<AcquireResult>((resolve) => {
    onAbort = () => {
      aborted = true;
      resolve(failure('待機が中断されました', { unverifiable: true }));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
  });
  // If cancellation wins, the underlying startup still owns cleanup. Release
  // any lease it returns later instead of leaking an invisible consumer.
  void operation
    .then((result) => {
      if (aborted && result.ok) releaseRuntimeServer(result.lease);
    })
    .catch(() => {});
  try {
    return await Promise.race([operation, abortResult]);
  } finally {
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
    consumers.delete(token);
    if (consumers.size === 0) {
      if (acquiring.get(key) === consumers) acquiring.delete(key);
      const entry = registry.get(key);
      if (aborted && entry?.state === 'starting' && entry.leases.size === 0)
        entry.startCancelled = true;
    }
  }
}
async function acquireRuntimeServerInternal(
  workdir: string,
  cfg: RuntimeConfig,
  opts: AcquireOptions = {},
): Promise<AcquireResult> {
  try {
    await ensureRuntimeServerRegistryInitialized();
  } catch (error) {
    return failure(`所有情報の復旧を確認できません: ${String(error)}`, { unverifiable: true });
  }

  const key = normalizeWorkdirKey(workdir);
  if (!key) {
    return failure(`worktreeパスを解決できません: ${workdir}`);
  }
  const fp = fingerprintConfig(cfg);
  const deadline = Date.now() + (opts.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);

  while (true) {
    if (opts.signal?.aborted) return failure('待機が中断されました', { unverifiable: true });

    const entry = registry.get(key);
    if (!entry) {
      return spawnNewEntry(key, workdir, cfg, fp, opts.label);
    }

    if (entry.state === 'quarantined') {
      return failure(
        `worktree ${workdir} は前回の停止確認が取れず隔離中です: ${entry.quarantineReason}`,
        { unverifiable: true },
      );
    }

    if (entry.state === 'active' && entry.configFingerprint === fp) {
      // Reserve a lease before awaiting OS/HTTP checks so idle cleanup cannot
      // stop the process underneath an in-progress borrower.
      const lease = randomUUID();
      entry.leases.add(lease);
      cancelIdleTimer(entry);
      let validation: Promise<void> | undefined;
      try {
        if (!entry.validationPromise) {
          entry.validationPromise = (async () => {
            const snapshot = await readRuntimeProcessSnapshot();
            const identities = extendOwnedRuntimeTree(entry.identities ?? [], snapshot.processes);
            const inspected = inspectOwnedRuntimeTree(
              identities,
              snapshot.processes,
              snapshot.protectedPids,
            );
            if (!inspected.safe || inspected.alive.length === 0)
              throw new Error('Server identity is unavailable');
            if (!ownsRuntimePort(snapshot, inspected.alive, entry.port!))
              throw new Error('Listener ownership is unconfirmed');
            const response = await fetch(`${entry.baseUrl}${cfg.healthPath}`, {
              signal: AbortSignal.timeout(3000),
            });
            const healthy = response.status < 500;
            await response.body?.cancel();
            if (!healthy) throw new Error('Server health check failed');
            entry.identities = identities;
            await persistActive(entry, entry.app?.pid ?? identities[0]?.pid);
          })();
        }
        validation = entry.validationPromise;
        await validation;
        if (opts.signal?.aborted) throw new Error('Acquisition cancelled');
        if (registry.get(key) !== entry || entry.state !== 'active')
          throw new Error('Server ownership changed');
        return {
          ok: true,
          baseUrl: entry.baseUrl!,
          port: entry.port!,
          lease,
          logs: () => entry.app?.logs() ?? [],
        };
      } catch (error) {
        entry.leases.delete(lease);
        // A caller cancellation does not invalidate other consumers.
        if (!opts.signal?.aborted) {
          entry.state = 'quarantined';
          entry.quarantineReason = `再利用前の所有・稼働確認に失敗: ${String(error)}`;
          await persistQuarantine(entry).catch((err) =>
            log.error({ err, key }, '[registry] quarantine persistence failed'),
          );
        } else if (entry.leases.size === 0 && entry.state === 'active') {
          scheduleIdleStop(entry);
        }
        return failure(String(error), { unverifiable: true });
      } finally {
        if (entry.validationPromise === validation) entry.validationPromise = undefined;
      }
    }
    if (Date.now() >= deadline) {
      const reason =
        entry.state === 'active'
          ? `worktree ${workdir} は互換性のない設定で稼働中のサーバーに占有されており、待機がタイムアウトしました`
          : `worktree ${workdir} は他の起動処理により占有されており、待機がタイムアウトしました`;
      return failure(reason, { unverifiable: true });
    }

    await waitForStateChange(key, opts.signal, deadline);
  }
}

/**
 * Release a lease obtained from acquireRuntimeServer(). Idempotent — a
 * double release is a no-op. Once the last lease on an active, owned entry is
 * released, an idle timer schedules the server's stop (cancelled if a new
 * lease arrives first). Recovered entries require the same identity checks.
 *
 * @param lease - Lease id returned by a successful acquire. / 対象リース
 */
export function releaseRuntimeServer(lease: string): void {
  for (const entry of registry.values()) {
    if (entry.leases.delete(lease)) {
      if (entry.leases.size === 0 && entry.state === 'active') {
        scheduleIdleStop(entry);
      }
      return;
    }
  }
}

let initPromise: Promise<void> | null = null;

/**
 * Idempotent registry initialization: reconciles persisted state against
 * live processes exactly once. The HTTP listener opens before startup
 * warm-up runs (index.ts), so an early acquireRuntimeServer() call could
 * otherwise race a not-yet-run recovery pass and spawn a duplicate against an
 * orphan the persisted file already knows about — every acquire call awaits
 * this same promise first, and warm-up calling it again is a no-op.
 *
 * @returns Resolves after recovery; rejects on unreadable ownership state so
 *          callers cannot start over an unexamined server. / 初期化完了
 */
export function ensureRuntimeServerRegistryInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = recoverRegistryInternal().catch((err) => {
      log.error({ err }, '[registry] recovery failed — refusing new starts');
      throw err;
    });
  }
  return initPromise;
}

/** Alias for index.ts's startup warm-up sequence — same underlying promise. */
export const recoverRuntimeServerRegistry = ensureRuntimeServerRegistryInitialized;

async function recoverRegistryInternal(): Promise<void> {
  const entries = await ownershipStore.read();
  if (entries.length === 0) return;
  const snapshot = await readRuntimeProcessSnapshot();
  for (const persisted of entries) {
    const identities = extendOwnedRuntimeTree(persisted.identities ?? [], snapshot.processes);
    const inspected = inspectOwnedRuntimeTree(
      identities,
      snapshot.processes,
      snapshot.protectedPids,
    );
    let healthy = false;
    if (
      inspected.safe &&
      inspected.alive.length > 0 &&
      persisted.state === 'active' &&
      persisted.baseUrl &&
      ownsRuntimePort(snapshot, inspected.alive, persisted.port!)
    ) {
      try {
        const healthPath = persisted.configFingerprint.split('\u0000')[2];
        if (healthPath === undefined) throw new Error('Missing health path');
        const response = await fetch(`${persisted.baseUrl}${healthPath}`, {
          signal: AbortSignal.timeout(3000),
        });
        healthy = response.status < 500;
        await response.body?.cancel();
      } catch {
        healthy = false;
      }
    }
    // Missing root identity (including a crash before capture) is not absence.
    // Retain failed/unhealthy records; never start over a possible survivor.
    const entry: RegistryEntry = {
      key: persisted.key,
      workdir: persisted.workdir,
      state: healthy ? 'active' : 'quarantined',
      configFingerprint: persisted.configFingerprint,
      port: persisted.port,
      baseUrl: persisted.baseUrl,
      identities,
      leases: new Set(),
      generation: nextGeneration(),
      quarantineReason: healthy ? undefined : '再起動後の所有・稼働状態を確認できません',
    };
    registry.set(entry.key, entry);
    // Save newly discovered descendants and the reconciled state before
    // making the recovered entry available to callers behind the barrier.
    await persistActive(entry, persisted.pid);
    if (healthy) {
      scheduleIdleStop(entry);
    } else if (inspected.safe) {
      // No leases survive a backend restart. An identified unhealthy tree
      // can be stopped; a proven absent tree can release its durable record.
      // Unknown identities and occupied ports remain quarantined.
      await stopOwnedAndVerify(entry, 'startup-recovery');
    }
  }
}

/**
 * Test-only introspection: current in-memory entry count and states, without
 * exposing internal handles. Not used by production code paths.
 *
 * @returns Snapshot of registry keys and their state. / テスト用スナップショット
 */
export function _debugSnapshotForTests(): Array<{
  key: string;
  state: RegistryState;
  leases: number;
}> {
  return [...registry.entries()].map(([key, e]) => ({
    key,
    state: e.state,
    leases: e.leases.size,
  }));
}

/**
 * Test-only reset: clears in-memory state and initialization latch so each
 * test file starts from a clean slate. Never called from production code.
 */
export function _resetForTests(): void {
  for (const entry of registry.values()) cancelIdleTimer(entry);
  registry.clear();
  acquiring.clear();
  resetGenerationCounter();
  initPromise = null;
}
