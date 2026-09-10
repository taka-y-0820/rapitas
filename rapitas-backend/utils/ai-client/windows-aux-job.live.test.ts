/** Real disposable process trees; no backend, DB, or unrelated PID is touched. */
import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { observeProcess, createOwnershipRegistry } from './aux-cli-ownership';
import { createAuxCliRecovery } from './aux-cli-recovery';
import { observeWindowsAuxJob, requestWindowsAuxJobStop } from './windows-aux-job';
import { createWindowsAuxExecutionManager } from './windows-aux-execution';

for (const mode of ['root-exit', 'launcher-stop', 'recovered-job-stop', 'own-deadline'] as const) {
  test.skipIf(process.platform !== 'win32')(
    `private Windows job closes descendants: ${mode}`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'rapitas-aux-job-'));
      const fixture = join(directory, 'tree.cjs');
      const registryPath = join(directory, 'ownership.json');
      const registry = createOwnershipRegistry(registryPath);
      await writeFile(
        fixture,
        `
const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
process.stdout.write(JSON.stringify({root:process.pid, child:child.pid})+'\\n');
process.stdin.once('data',()=>{ if(process.argv[2]==='root-exit') process.exit(7); });
setInterval(()=>{},1000);
`,
      );
      const manager = createWindowsAuxExecutionManager(registry);
      const launch = await manager.reserve(
        `"${process.execPath}" "${fixture}" ${mode}`,
        directory,
        {
          ...process.env,
          RAPITAS_AUX_AI_CLI_TIMEOUT_MS: mode === 'own-deadline' ? '12000' : '120000',
        },
      );
      const token = launch.token;
      expect((await registry.snapshot())[0].status).toBe('intent');
      const launcher = spawn(launch.command, launch.args, launch.options);
      const attached = launch.attach(launcher);
      void attached.catch(() => {}); // Awaited below after all event handlers have been installed.
      let errors = '';
      launcher.stderr.setEncoding('utf8');
      launcher.stderr.on('data', (chunk) => {
        errors += chunk;
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        launcher.once('close', resolve);
        launcher.once('error', reject);
      });
      try {
        const pids = await new Promise<{ root: number; child: number }>((resolve, reject) => {
          let output = '';
          const timer = setTimeout(
            () => reject(new Error(`Launcher readiness timeout: ${errors}`)),
            12000,
          );
          launcher.stdout.setEncoding('utf8');
          launcher.stdout.on('data', (chunk) => {
            output += chunk;
            if (output.includes('\n')) {
              clearTimeout(timer);
              try {
                resolve(JSON.parse(output.split('\n')[0]));
              } catch (error) {
                reject(error);
              }
            }
          });
          void closed.then((code) => {
            clearTimeout(timer);
            reject(new Error(`Early exit ${code}: ${errors}`));
          }, reject);
        });
        const scope = await observeWindowsAuxJob(token);
        expect(scope.kind).toBe('present');
        if (scope.kind === 'present') expect(scope.activeProcesses).toBeGreaterThanOrEqual(3);
        expect(await observeProcess(pids.root)).toMatchObject({ kind: 'present' });
        expect(await observeProcess(pids.child)).toMatchObject({ kind: 'present' });
        await attached;
        // A new registry/recovery instance represents a backend restart: a live job blocks it.
        const reloaded = createOwnershipRegistry(registryPath);
        const recovery = createAuxCliRecovery(reloaded);
        await expect(recovery.assertReady()).rejects.toThrow('recovery pending');
        expect(await reloaded.snapshot()).toHaveLength(1);
        if (mode === 'root-exit') launcher.stdin.end('finish\n');
        else if (mode === 'launcher-stop') await launch.stop();
        else if (mode === 'recovered-job-stop')
          await requestWindowsAuxJobStop((await reloaded.snapshot())[0].executionToken);
        const code = await closed;
        if (mode === 'root-exit') expect(code).toBe(7);
        if (mode === 'own-deadline') expect(code).toBe(124);
        if (mode === 'root-exit') await launch.finish();
        expect(await observeProcess(pids.root)).toEqual({ kind: 'absent' });
        expect(await observeProcess(pids.child)).toEqual({ kind: 'absent' });
        expect(await observeWindowsAuxJob(token)).toEqual({ kind: 'absent' });
        await recovery.assertReady();
        expect(await reloaded.snapshot()).toEqual([]);
        if (mode === 'own-deadline') expect(errors).toContain('launcher deadline exceeded');
        else expect(errors).toBe('');
      } finally {
        if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill();
        await closed.catch(() => {});
        const cleanupDirectory = resolve(directory);
        if (
          dirname(cleanupDirectory) !== resolve(tmpdir()) ||
          !basename(cleanupDirectory).startsWith('rapitas-aux-job-')
        )
          throw new Error('Refusing cleanup outside this test temporary directory');
        await rm(cleanupDirectory, { recursive: true, force: true });
      }
    },
    25000,
  );
}
