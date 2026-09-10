/** Durable admission and lifetime for a dedicated Windows auxiliary job launcher. */
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  observeProcess,
  type createOwnershipRegistry,
  type ProcessObservation,
  type OwnershipRecord,
  type OwnershipEvidence,
} from './aux-cli-ownership';
import { createAuxCliRecovery, inspectAuxCliRecovery } from './aux-cli-recovery';
import { requestWindowsAuxJobStop } from './windows-aux-job';
import { createLogger } from '../../config/logger';

const log = createLogger('aux-cli:lifecycle');

type Dependencies = {
  observe(pid: number): Promise<ProcessObservation>;
  inspect(record: OwnershipRecord): Promise<OwnershipEvidence>;
  stopJob(token: string): Promise<void>;
};
const defaults: Dependencies = {
  observe: observeProcess,
  inspect: inspectAuxCliRecovery,
  stopJob: requestWindowsAuxJobStop,
};

export function createWindowsAuxExecutionManager(
  registry: ReturnType<typeof createOwnershipRegistry>,
  deps: Dependencies = defaults,
) {
  const liveTokens = new Set<string>();
  const recovery = createAuxCliRecovery(registry, deps.inspect, liveTokens);
  return {
    async reserve(command: string, directory: string, env: NodeJS.ProcessEnv) {
      await recovery.assertReady();
      const token = randomUUID();
      liveTokens.add(token);
      try {
        await registry.recordLaunchIntent(token, 'windows-job');
      } catch (error) {
        liveTokens.delete(token);
        throw error;
      }
      let child: ChildProcess | undefined;
      let confirmation: Promise<void> | undefined;
      let completion: Promise<void> | undefined;
      const finish = (stop: boolean): Promise<void> => {
        liveTokens.delete(token);
        if (stop) log.info({ executionToken: token }, 'Auxiliary CLI stop requested');
        // The exact launcher handle also covers cancellation before job assignment.
        // Never resolve a discovered PID to send this signal.
        if (stop && child && child.exitCode === null && child.signalCode === null) child.kill();
        if (completion) return completion;
        completion = (async () => {
          let failure: unknown;
          try {
            if (confirmation) await confirmation;
            await registry.markStopping(token);
          } catch (error) {
            failure = error;
          }
          // Even persistence failure must not skip the owned containment stop.
          if (stop) {
            try {
              await deps.stopJob(token);
            } catch (error) {
              failure ??= error;
            }
          }
          if (failure) throw failure;
          if (!(await registry.reconcile(token, deps.inspect)))
            throw new Error(`Auxiliary CLI cleanup remains unresolved: ${token}`);
          log.info(
            { executionToken: token, stopped: stop },
            'Auxiliary CLI ownership scope verified empty; hold released',
          );
        })();
        return completion;
      };
      return {
        token,
        command: 'powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          join(import.meta.dir, 'windows-aux-job.ps1'),
        ],
        options: {
          cwd: directory,
          shell: false as const,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
          env: {
            ...env,
            RAPITAS_AUX_JOB_TOKEN: token,
            RAPITAS_AUX_JOB_COMMAND: command,
            RAPITAS_AUX_JOB_DIRECTORY: directory,
          },
        },
        /** Attach synchronously, then install process listeners before awaiting this promise. */
        attach(spawned: ChildProcess): Promise<void> {
          if (child || completion)
            return Promise.reject(new Error('Auxiliary launch already attached or stopped'));
          child = spawned;
          confirmation = (async () => {
            if (!child?.pid) throw new Error('Auxiliary launcher has no PID');
            const observed = await deps.observe(child.pid);
            if (observed.kind !== 'present')
              throw new Error('Auxiliary launcher identity unavailable');
            await registry.confirmOwnership(token, observed.identity);
          })();
          return confirmation;
        },
        finish: () => finish(false),
        stop: () => finish(true),
      };
    },
  };
}
