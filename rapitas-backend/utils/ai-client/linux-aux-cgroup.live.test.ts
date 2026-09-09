/** Requires a delegated cgroup-v2 parent; runs only disposable processes. */
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmdir, mkdtemp, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createLinuxAuxScope,
  linuxAuxLauncher,
  observeLinuxAuxScope,
  requestLinuxAuxScopeStop,
} from './linux-aux-cgroup';
import { observeProcess, createOwnershipRegistry } from './aux-cli-ownership';
import { createAuxCliRecovery } from './aux-cli-recovery';

for (const mode of ['tree-stop', 'root-exit'] as const) {
  test.skipIf(process.platform !== 'linux' || !process.env.RAPITAS_AUX_CGROUP_ROOT)(
    `cgroup contains a detached child after ${mode}`,
    async () => {
      const token = randomUUID();
      const scope = await createLinuxAuxScope(process.env.RAPITAS_AUX_CGROUP_ROOT!, token);
      const evidenceDirectory = await mkdtemp(join(tmpdir(), 'rapitas-linux-ownership-'));
      const registryPath = join(evidenceDirectory, 'registry.json');
      const registry = createOwnershipRegistry(registryPath);
      await registry.recordLaunchIntent(token, 'linux-cgroup', scope);
      const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: 'ignore',
      });
      const launch = linuxAuxLauncher(scope, process.execPath, [
        '-e',
        `
        const {spawn}=require('node:child_process');
        const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});
        console.log(JSON.stringify({root:process.pid,child:child.pid}));
        process.stdin.once('data',()=>process.exit(7));
        setInterval(()=>{},1000);
      `,
      ]);
      const root = spawn(launch.command, launch.args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const closed = new Promise((resolve, reject) => {
        root.once('close', resolve);
        root.once('error', reject);
      });
      try {
        const pids = await new Promise<{ root: number; child: number }>((resolve, reject) => {
          let stdout = '',
            stderr = '';
          const timer = setTimeout(
            () => reject(new Error(`Fixture readiness failed: ${stderr}`)),
            4000,
          );
          root.stderr.on('data', (data) => {
            stderr += data;
          });
          root.stdout.on('data', (data) => {
            stdout += data;
            if (stdout.includes('\n')) {
              clearTimeout(timer);
              resolve(JSON.parse(stdout.split('\n')[0]));
            }
          });
          void closed.then(() => {
            clearTimeout(timer);
            reject(new Error(stderr || 'Early fixture exit'));
          }, reject);
        });
        const child = await observeProcess(pids.child);
        const rootIdentity = await observeProcess(pids.root);
        if (rootIdentity.kind !== 'present' || child.kind !== 'present')
          throw new Error('Fixture identities unavailable');
        await registry.confirmOwnership(token, rootIdentity.identity);
        await registry.recordDescendants(token, [child.identity], true);
        const reloaded = createOwnershipRegistry(registryPath);
        const recovery = createAuxCliRecovery(reloaded);
        await expect(recovery.assertReady()).rejects.toThrow('recovery pending');
        expect((await reloaded.snapshot())[0].linuxScope).toEqual(scope);
        expect(child.kind).toBe('present');
        if (child.kind === 'present') expect(child.identity.pgid).toBe(pids.child);
        expect(await observeLinuxAuxScope(scope)).toEqual({ kind: 'present', populated: true });
        await expect(
          requestLinuxAuxScopeStop({ ...scope, inode: (BigInt(scope.inode) + 1n).toString() }),
        ).rejects.toThrow('identity changed');
        expect(await observeLinuxAuxScope(scope)).toEqual({ kind: 'present', populated: true });
        if (mode === 'root-exit') {
          root.stdin.end('exit');
          // close waits for inherited grandchild pipes, so observe exit instead.
          await new Promise((resolve) => {
            if (root.exitCode !== null) resolve(null);
            else root.once('exit', resolve);
          });
          expect(root.exitCode).toBe(7);
          expect(await observeLinuxAuxScope(scope)).toEqual({ kind: 'present', populated: true });
        }
        await requestLinuxAuxScopeStop(scope);
        await closed;
        for (let i = 0; i < 50; i++) {
          const state = await observeLinuxAuxScope(scope);
          if (state.kind === 'present' && !state.populated) break;
          await Bun.sleep(20);
        }
        expect(await observeLinuxAuxScope(scope)).toEqual({ kind: 'present', populated: false });
        expect((await observeProcess(sentinel.pid!)).kind).toBe('present');
        for (let i = 0; i < 50; i++) {
          try {
            await recovery.assertReady();
            break;
          } catch {
            await Bun.sleep(20);
          }
        }
        await recovery.assertReady();
        expect(await reloaded.snapshot()).toEqual([]);
      } finally {
        try {
          await requestLinuxAuxScopeStop(scope);
          await closed;
        } finally {
          sentinel.kill();
          await new Promise((resolve) => {
            if (sentinel.exitCode !== null || sentinel.signalCode !== null) resolve(null);
            else sentinel.once('close', resolve);
          });
        }
        if ((await registry.snapshot()).length === 0) {
          await rmdir(scope.path);
          for (const name of await readdir(evidenceDirectory))
            await unlink(join(evidenceDirectory, name));
          await rmdir(evidenceDirectory);
        }
      }
    },
    12000,
  );
}
