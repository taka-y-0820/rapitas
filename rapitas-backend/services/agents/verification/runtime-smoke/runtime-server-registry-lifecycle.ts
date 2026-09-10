/**
 * runtime-smoke/runtime-server-registry-lifecycle
 *
 * Spawn and stop/verify logic for the workdir-scoped runtime server registry.
 * Split out of worktree-server-registry.ts so the state machine's two most
 * complex operations — bringing a server up and confirming it is actually
 * down before releasing the workdir — live in one focused module.
 */
import { inspectRuntimeDirectory } from './runtime-directory-occupancy';
import { withRuntimeLaunchLock } from './runtime-launch-lock';
import { stopRuntimeProcesses } from './runtime-process-stop';
import { extendOwnedRuntimeTree, inspectOwnedRuntimeTree } from './runtime-process-identity';
import { readRuntimeProcessSnapshot, ownsRuntimePort } from './runtime-process-snapshot';
import { randomUUID } from 'crypto';
import { createLogger } from '../../../../config/logger';
import { allocateFreePort, launchApp, waitForHealthy } from './app-launcher';
import { substitutePort, type RuntimeConfig } from './runtime-config';
import {
  cancelIdleTimer,
  failure,
  IDLE_STOP_MS,
  nextGeneration,
  registry,
  STOP_VERIFY_TIMEOUT_MS,
  type AcquireResult,
  type RegistryEntry,
} from './runtime-server-registry-types';
import {
  persistActive,
  persistQuarantine,
  persistRemoval,
  persistStartingIntent,
} from './runtime-server-registry-persistence';

const log = createLogger('runtime-smoke:registry');

export function scheduleIdleStop(entry: RegistryEntry): void {
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
export async function stopOwnedAndVerify(
  entry: RegistryEntry,
  reasonLabel: string,
): Promise<boolean> {
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
export async function spawnNewEntry(
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
    generation: nextGeneration(),
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
    const { app, port, baseUrl } = await withRuntimeLaunchLock(async () => {
      if (entry.startCancelled) throw new Error('Startup cancelled before port allocation');
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
      return { app, port, baseUrl };
    });
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
