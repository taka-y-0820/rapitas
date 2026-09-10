import { test, expect } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { allocateFreePort } from './app-launcher';
import { withRuntimeLaunchLock } from './runtime-launch-lock';
const exec = promisify(execFile);

test('parallel launches do not inherit another launch temporary listener', async () => {
  for (let round = 0; round < 3; round++) {
    const launched = await Promise.all(
      [0, 1].map(() =>
        withRuntimeLaunchLock(async () => {
          const port = await allocateFreePort();
          const process = exec(
            'node',
            [
              '-e',
              `const s=require('net').createServer();s.on('error',e=>{console.error(e.code);process.exitCode=1});s.listen(${port},'127.0.0.1',()=>{console.log('ready');setTimeout(()=>s.close(),300)});`,
            ],
            { timeout: 5000, windowsHide: true },
          );
          return { port, process };
        }),
      ),
    );
    expect(launched[0].port).not.toBe(launched[1].port);
    const results = await Promise.all(launched.map((item) => item.process));
    expect(results.map((item) => item.stdout.trim())).toEqual(['ready', 'ready']);
  }
}, 20000);

test('a rejected launch does not block the next reservation', async () => {
  await expect(
    withRuntimeLaunchLock(async () => {
      throw new Error('cancelled');
    }),
  ).rejects.toThrow('cancelled');
  expect(await withRuntimeLaunchLock(async () => 42)).toBe(42);
});
