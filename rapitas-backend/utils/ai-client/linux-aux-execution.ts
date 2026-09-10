/** Durable admission for Linux cgroup-contained auxiliary calls. */
import { randomUUID } from 'node:crypto';
import { readFile, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { createLinuxAuxScope, requestLinuxAuxScopeStop } from './linux-aux-cgroup';
import { observeProcess, type createOwnershipRegistry } from './aux-cli-ownership';
import { createAuxCliRecovery, inspectAuxCliRecovery } from './aux-cli-recovery';
import { createLogger } from '../../config/logger';

const log = createLogger('aux-cli:linux-lifecycle');

export function createLinuxAuxExecutionManager(
  registry: ReturnType<typeof createOwnershipRegistry>,
) {
  const live = new Set<string>();
  const recovery = createAuxCliRecovery(registry, inspectAuxCliRecovery, live);
  return {
    async reserve(command: string, args: string[], directory: string, env: NodeJS.ProcessEnv) {
      await recovery.assertReady();
      const token = randomUUID();
      const uid = process.getuid!();
      const parent =
        env.RAPITAS_AUX_CGROUP_ROOT ||
        `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service`;
      const self = (await readFile('/proc/self/cgroup', 'utf8'))
        .split('\n')
        .find((line) => line.startsWith('0::'))
        ?.slice(3);
      const scope = await createLinuxAuxScope(parent, token);
      live.add(token);
      try {
        await registry.recordLaunchIntent(token, 'linux-cgroup', scope);
      } catch (error) {
        live.delete(token);
        await rmdir(scope.path).catch(() => {});
        throw error;
      }
      let child: ChildProcess | undefined;
      let confirmation: Promise<void> | undefined;
      let completion: Promise<void> | undefined;
      const finish = (stop: boolean) => {
        if (stop) log.info({ executionToken: token }, 'Auxiliary CLI stop requested');
        if (stop && child && child.exitCode === null && child.signalCode === null) child.kill();
        completion ??= (async () => {
          let failure: unknown;
          try {
            await confirmation;
            await registry.markStopping(token);
          } catch (error) {
            failure = error;
          }
          try {
            await requestLinuxAuxScopeStop(scope);
          } catch (error) {
            failure ??= error;
          }
          if (failure) throw failure;
          for (let attempt = 0; attempt < 50; attempt++) {
            if (await registry.reconcile(token, inspectAuxCliRecovery)) {
              await rmdir(scope.path);
              log.info(
                { executionToken: token },
                'Auxiliary CLI ownership scope verified empty; hold released',
              );
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          throw new Error(`Auxiliary Linux cleanup remains unresolved: ${token}`);
        })().finally(() => {
          // Keep local ownership through final reconciliation, including failure.
          live.delete(token);
        });
        return completion;
      };
      const helperArgs = [join(import.meta.dir, 'linux-aux-launcher.ts')];
      const needsUserScope =
        uid !== 0 && (!self || !join('/sys/fs/cgroup', self).startsWith(parent + '/'));
      return {
        token,
        command: needsUserScope ? 'systemd-run' : process.execPath,
        args: needsUserScope
          ? ['--user', '--scope', '--quiet', process.execPath, ...helperArgs]
          : helperArgs,
        options: {
          cwd: directory,
          shell: false as const,
          stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
          env: {
            ...env,
            XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
            RAPITAS_AUX_LINUX_SCOPE: JSON.stringify(scope),
            RAPITAS_AUX_LINUX_COMMAND: JSON.stringify([command, ...args]),
          },
        },
        attach(spawned: ChildProcess) {
          if (child || completion)
            return Promise.reject(new Error('Auxiliary launch already attached or stopped'));
          child = spawned;
          confirmation = (async () => {
            if (!child?.pid) throw new Error('Auxiliary launcher has no PID');
            const identity = await observeProcess(child.pid);
            if (identity.kind !== 'present')
              throw new Error('Auxiliary launcher identity unavailable');
            await registry.confirmOwnership(token, identity.identity);
          })();
          return confirmation;
        },
        finish: () => finish(false),
        stop: () => finish(true),
      };
    },
  };
}
