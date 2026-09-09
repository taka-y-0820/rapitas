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
 * positively re-identify as its own (see stopOwnedAndVerify). Recovery uses
 * persisted OS birth identities; termination independently protects port 3001.
 */
import { realpathSync } from 'fs';
import { RuntimeRegistryStore } from './runtime-registry-store';
import { inspectRuntimeDirectory } from './runtime-directory-occupancy';
import { stopRuntimeProcesses } from './runtime-process-stop';
import {
  extendOwnedRuntimeTree,
  inspectOwnedRuntimeTree,
  isRuntimeProcessIdentity,
  type RuntimeProcessIdentity,
} from './runtime-process-identity';
import { readRuntimeProcessSnapshot, ownsRuntimePort } from './runtime-process-snapshot';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createLogger } from '../../../../config/logger';
import { allocateFreePort, launchApp, waitForHealthy, type LaunchedApp } from './app-launcher';
import { substitutePort, type RuntimeConfig } from './runtime-config';

const log = createLogger('runtime-smoke:registry');

const PERSIST_DIR = join(process.cwd(), '.agent-pids');
const PERSIST_PATH = join(PERSIST_DIR, 'runtime-servers.json');

/** How long an owned, zero-lease server stays up before being stopped. */
const IDLE_STOP_MS = 20_000;
/** Bound on waiting for a stop signal to actually take effect. */
const STOP_VERIFY_TIMEOUT_MS = 20_000;
/** Default bound on waiting for another caller's start/stop/drain. */
export const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
/** Poll granularity while waiting for a state we don't hold a promise for. */
const POLL_INTERVAL_MS = 250;

type RegistryState = 'starting' | 'active' | 'stopping' | 'quarantined';

interface RegistryEntry {
  key: string;
  workdir: string;
  state: RegistryState;
  configFingerprint: string;
  port?: number;
  baseUrl?: string;
  /** Undefined for entries recovered from a previous backend process. */
  app?: LaunchedApp;
  leases: Set<string>;
  generation: number;
  startPromise?: Promise<AcquireResult>;
  stopPromise?: Promise<void>;
  validationPromise?: Promise<void>;
  startCancelled?: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  quarantineReason?: string;
  identities?: RuntimeProcessIdentity[];
}

const registry = new Map<string, RegistryEntry>();
let generationCounter = 0;

export interface AcquireSuccess {
  ok: true;
  baseUrl: string;
  port: number;
  /** Pass to releaseRuntimeServer() when done. Double-release is a no-op. */
  lease: string;
  logs: () => string[];
}
export interface AcquireFailure {
  ok: false;
  reason: string;
  logs: string[];
  exitCode: number | null;
  hasExited: boolean;
  /**
   * True when this failure is NOT evidence about the app under test — e.g. a
   * bounded wait for another caller timed out, or the workdir is quarantined
   * pending stop confirmation. Callers should hold completion rather than
   * treat it as a hard verification failure.
   */
  unverifiable?: boolean;
}
export type AcquireResult = AcquireSuccess | AcquireFailure;

export interface AcquireOptions {
  /** Log-correlation label only. */
  label?: string;
  /** Aborts an in-progress WAIT for another caller (not a spawn this call owns). */
  signal?: AbortSignal;
  /** Bound on waiting for another caller's occupancy to resolve. */
  waitTimeoutMs?: number;
}

function fingerprintConfig(cfg: RuntimeConfig): string {
  return `${cfg.start}\u0000${cfg.url}\u0000${cfg.healthPath}`;
}

/**
 * Normalize a workdir to a stable registry key: resolve symlinks/junctions to
 * their real target, and case-fold on win32 (NTFS paths are case-insensitive —
 * two differently-cased spellings of the same worktree must collide to one
 * entry, or the dedup this module exists for silently fails).
 *
 * @param workdir - Candidate worktree/working directory. / 対象ディレクトリ
 * @returns Normalized key, or null when the path cannot be resolved. / 正規化キー
 */
export function normalizeWorkdirKey(workdir: string): string | null {
  try {
    const real = realpathSync(workdir);
    return process.platform === 'win32' ? real.toLowerCase() : real;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function failure(
  reason: string,
  opts: {
    unverifiable?: boolean;
    logs?: string[];
    exitCode?: number | null;
    hasExited?: boolean;
  } = {},
): AcquireFailure {
  return {
    ok: false,
    reason,
    logs: opts.logs ?? [],
    exitCode: opts.exitCode ?? null,
    hasExited: opts.hasExited ?? false,
    unverifiable: opts.unverifiable,
  };
}

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

function cancelIdleTimer(entry: RegistryEntry): void {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
}

function scheduleIdleStop(entry: RegistryEntry): void {
  cancelIdleTimer(entry);
  const timer = setTimeout(() => {
    if (entry.leases.size === 0 && entry.state === 'active') {
      void stopOwnedAndVerify(entry, 'idle-timeout');
    }
  }, IDLE_STOP_MS);
  timer.unref?.();
  entry.idleTimer = timer;
}

/**
 * Stop an entry with recorded OS identities and verify the
 * process actually exited before dropping the registry record. A stop signal
 * that we cannot confirm took effect leaves the entry `quarantined` — future
 * acquireRuntimeServer() calls for the same workdir fail closed (bounded
 * wait, never a duplicate spawn) instead of assuming the workdir is free.
 *
 * @param entry - Entry whose owned processes must be verified. / 対象エントリ
 * @param reasonLabel - Short cause, for logs/quarantine diagnostics. / 停止理由
 * @returns True once verified stopped (registry entry removed). / 停止確認できたか
 */
async function stopOwnedAndVerify(entry: RegistryEntry, reasonLabel: string): Promise<boolean> {
  if (!entry.identities?.length) {
    entry.state = 'quarantined';
    entry.quarantineReason = '停止対象の所有情報がありません';
    return false;
  }
  if (entry.state === 'stopping' && entry.stopPromise) {
    await entry.stopPromise;
    return !registry.has(entry.key) || registry.get(entry.key)?.state !== 'quarantined';
  }
  entry.state = 'stopping';

  const run = (async (): Promise<void> => {
    entry.app?.markStopRequested?.();
    const result = await stopRuntimeProcesses(
      entry.identities ?? [],
      async (identities) => {
        entry.identities = identities;
        await persistQuarantine(entry);
      },
      STOP_VERIFY_TIMEOUT_MS,
    );
    entry.identities = result.identities;
    if (!result.stopped) {
      entry.state = 'quarantined';
      entry.quarantineReason = `${reasonLabel}: ${result.reason}`;
      log.warn(
        { key: entry.key, reason: result.reason },
        '[registry] stop unconfirmed; spawn remains prohibited',
      );
      await persistQuarantine(entry);
      return;
    }
    const afterStop = await readRuntimeProcessSnapshot();
    if (
      !afterStop.listeners ||
      afterStop.listeners.some((listener) => listener.port === entry.port)
    ) {
      entry.state = 'quarantined';
      entry.quarantineReason = '停止後のポート解放を確認できません';
      await persistQuarantine(entry);
      return;
    }
    const directory = await inspectRuntimeDirectory(entry.workdir, afterStop.processes);
    if (!directory.free) {
      entry.state = 'quarantined';
      entry.quarantineReason = directory.reason;
      await persistQuarantine(entry);
      return;
    }
    // Persist removal before relinquishing the in-memory exclusion.
    await persistRemoval(entry.key);
    if (registry.get(entry.key) === entry) registry.delete(entry.key);
    log.info({ key: entry.key, reasonLabel }, '[registry] server stopped and verified');
  })();
  const guardedStop = run.catch((error) => {
    entry.state = 'quarantined';
    entry.quarantineReason = `停止後の所有情報を確定できません: ${String(error)}`;
    log.error(
      { err: error, key: entry.key },
      '[registry] stop cleanup failed; ownership remains held',
    );
  });
  entry.stopPromise = guardedStop;
  await guardedStop;
  return registry.get(entry.key)?.state !== 'quarantined';
}

/**
 * Spawn a brand-new server for a workdir with no existing entry. Registers a
 * `starting` entry FIRST (before any await) so every concurrent caller for
 * the same key sees it and awaits this same promise instead of racing a
 * second spawn — the core fix for task 906's duplicate-launch failure.
 */
async function spawnNewEntry(
  key: string,
  workdir: string,
  cfg: RuntimeConfig,
  fp: string,
  label?: string,
): Promise<AcquireResult> {
  const entry: RegistryEntry = {
    key,
    workdir,
    state: 'starting',
    configFingerprint: fp,
    leases: new Set(),
    generation: ++generationCounter,
  };
  registry.set(key, entry);
  const myGeneration = entry.generation;
  let launchAttempted = false;

  const run = (async (): Promise<AcquireResult> => {
    await persistStartingIntent(key, workdir, fp);
    const beforeStart = await readRuntimeProcessSnapshot();
    const directory = await inspectRuntimeDirectory(workdir, beforeStart.processes);
    if (!directory.free) throw new Error(directory.reason);
    if (entry.startCancelled) throw new Error('Startup cancelled before spawn');
    const port = await allocateFreePort();
    if (entry.startCancelled) throw new Error('Startup cancelled during port allocation');
    const parsedUrl = new URL(substitutePort(cfg.url, port));
    if (parsedUrl.hostname === 'localhost') parsedUrl.hostname = '127.0.0.1';
    const baseUrl = parsedUrl.toString().replace(/\/$/, '');
    launchAttempted = true;
    const app = launchApp(substitutePort(cfg.start, port), workdir, port);
    entry.app = app;
    entry.port = port;
    entry.baseUrl = baseUrl;
    const snapshot = await readRuntimeProcessSnapshot();
    const root = snapshot.processes.find((p) => p.pid === app.pid);
    if (!root || app.hasExited() || !root.birth || !root.command) {
      throw new Error('Spawned process identity cannot be confirmed');
    }
    entry.identities = extendOwnedRuntimeTree([root], snapshot.processes);
    await persistActive(entry, app.pid);

    log.info({ key, workdir, port, label }, '[registry] spawning new server for workdir');
    let trackingError: unknown;
    let tracking: Promise<void> | undefined;
    const tracker = setInterval(() => {
      if (tracking) return;
      tracking = (async () => {
        const current = await readRuntimeProcessSnapshot();
        const identities = extendOwnedRuntimeTree(entry.identities ?? [], current.processes);
        const inspected = inspectOwnedRuntimeTree(
          identities,
          current.processes,
          current.protectedPids,
        );
        if (!inspected.safe)
          throw new Error(`Startup process tracking failed: ${inspected.reason}`);
        if (identities.length !== entry.identities?.length) {
          entry.identities = identities;
          await persistActive(entry, app.pid);
        }
      })()
        .catch((error) => {
          trackingError = error;
        })
        .finally(() => {
          tracking = undefined;
        });
    }, 2500);
    tracker.unref?.();
    let healthy: boolean;
    try {
      healthy = await waitForHealthy(
        `${baseUrl}${cfg.healthPath}`,
        cfg.readyTimeoutMs,
        { workdir, label },
        () => app.hasExited() || entry.startCancelled === true || trackingError !== undefined,
      );
    } finally {
      clearInterval(tracker);
      await tracking;
    }
    if (trackingError) throw trackingError;
    if (registry.get(key)?.generation !== myGeneration) {
      // Nothing else in this module removes/replaces a 'starting' entry, but
      // guard the invariant anyway rather than silently leak app's process.
      await stopOwnedAndVerify(entry, 'startup-failure');
      return failure('内部状態が更新されたため中断しました', {
        logs: app.logs(),
        exitCode: app.exitCode(),
        hasExited: app.hasExited(),
      });
    }

    if (!healthy || entry.startCancelled) {
      const result = failure(
        `アプリが ${cfg.readyTimeoutMs / 1_000}s 以内に起動しませんでした (${baseUrl}${cfg.healthPath} 無応答)`,
        { logs: app.logs(), exitCode: app.exitCode(), hasExited: app.hasExited() },
      );
      await stopOwnedAndVerify(entry, 'startup-failure');
      return result;
    }

    const readySnapshot = await readRuntimeProcessSnapshot();
    entry.identities = extendOwnedRuntimeTree(entry.identities ?? [], readySnapshot.processes);
    const readyIdentity = inspectOwnedRuntimeTree(
      entry.identities,
      readySnapshot.processes,
      readySnapshot.protectedPids,
    );
    if (!readyIdentity.safe || readyIdentity.alive.length === 0)
      throw new Error('Server ownership changed during start');
    if (!ownsRuntimePort(readySnapshot, readyIdentity.alive, port))
      throw new Error('Listener ownership is unconfirmed');
    entry.state = 'active';
    const lease = randomUUID();
    entry.leases.add(lease);
    await persistActive(entry, app.pid);
    return { ok: true, baseUrl, port, lease, logs: () => app.logs() };
  })();

  const guardedRun = run.catch(async (error) => {
    if (!launchAttempted) {
      // No process was created. Releasing a cancelled reservation needs only
      // durable removal; treating it as an unknown process would block every
      // later request for this worktree after an ordinary cancellation.
      try {
        await persistRemoval(key);
        if (registry.get(key) === entry) registry.delete(key);
        return failure(String(error), { unverifiable: true });
      } catch (cleanupError) {
        log.error({ err: cleanupError, key }, '[registry] reservation removal failed');
      }
    }
    // Persistence failure must never turn into a success lease or an empty
    // workdir. Retain the process handle for identity-aware cleanup/recovery.
    entry.state = 'quarantined';
    entry.leases.clear();
    entry.quarantineReason = `起動または所有情報保存に失敗: ${String(error)}`;
    log.error({ err: error, key }, '[registry] start failed — workdir quarantined');
    if (entry.identities?.length) await stopOwnedAndVerify(entry, 'start-error');
    return failure(entry.quarantineReason, {
      unverifiable: true,
      logs: entry.app?.logs(),
      exitCode: entry.app?.exitCode(),
      hasExited: entry.app?.hasExited(),
    });
  });
  entry.startPromise = guardedRun;
  return guardedRun;
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

// ---------------------------------------------------------------------------
// Persistence — `.agent-pids/runtime-servers.json`. A single write chain
// serializes concurrent updates (temp+rename keeps each individual write
// atomic; the chain keeps the SEQUENCE of writes ordered so a fast second
// update can never be clobbered by a slower first one finishing later).
// ---------------------------------------------------------------------------

interface PersistedEntry {
  key: string;
  workdir: string;
  state: 'starting' | 'active' | 'quarantined';
  configFingerprint: string;
  port?: number;
  baseUrl?: string;
  pid?: number;
  startedAt: string;
  identities?: RuntimeProcessIdentity[];
}
function validPersistedEntry(value: unknown): value is PersistedEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as PersistedEntry;
  return (
    typeof v.key === 'string' &&
    v.key.length > 0 &&
    typeof v.workdir === 'string' &&
    typeof v.configFingerprint === 'string' &&
    ['starting', 'active', 'quarantined'].includes(v.state) &&
    typeof v.startedAt === 'string' &&
    Number.isFinite(Date.parse(v.startedAt)) &&
    (v.pid === undefined || (Number.isInteger(v.pid) && v.pid > 0)) &&
    (v.port === undefined || (Number.isInteger(v.port) && v.port > 0 && v.port < 65536)) &&
    (v.baseUrl === undefined || typeof v.baseUrl === 'string') &&
    (v.identities === undefined ||
      (Array.isArray(v.identities) && v.identities.every(isRuntimeProcessIdentity)))
  );
}
const ownershipStore = new RuntimeRegistryStore<PersistedEntry>(PERSIST_PATH, validPersistedEntry);
function upsertPersisted(entryData: PersistedEntry): Promise<void> {
  return ownershipStore.update((entries) => [
    ...entries.filter((entry) => entry.key !== entryData.key),
    entryData,
  ]);
}
function removePersisted(key: string): Promise<void> {
  return ownershipStore.update((entries) => entries.filter((entry) => entry.key !== key));
}
function persistStartingIntent(key: string, workdir: string, fp: string): Promise<void> {
  return upsertPersisted({
    key,
    workdir,
    state: 'starting',
    configFingerprint: fp,
    startedAt: new Date().toISOString(),
  });
}
function persistActive(entry: RegistryEntry, pid: number | undefined): Promise<void> {
  return upsertPersisted({
    key: entry.key,
    workdir: entry.workdir,
    state: entry.state === 'stopping' ? 'quarantined' : entry.state,
    configFingerprint: entry.configFingerprint,
    port: entry.port,
    baseUrl: entry.baseUrl,
    pid,
    identities: entry.identities,
    startedAt: new Date().toISOString(),
  });
}
function persistQuarantine(entry: RegistryEntry): Promise<void> {
  return upsertPersisted({
    key: entry.key,
    workdir: entry.workdir,
    state: 'quarantined',
    configFingerprint: entry.configFingerprint,
    port: entry.port,
    baseUrl: entry.baseUrl,
    pid: entry.app?.pid,
    identities: entry.identities,
    startedAt: new Date().toISOString(),
  });
}
function persistRemoval(key: string): Promise<void> {
  return removePersisted(key);
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
      generation: ++generationCounter,
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
  generationCounter = 0;
  initPromise = null;
}
