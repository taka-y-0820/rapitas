import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withOwnershipFileLock } from './ownership-file-lock';

test('waiting remains responsive and a crashed lock owner cannot pin recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rapitas-lock-crash-'));
  const path = join(directory, 'ownership.json');
  const fixture = join(directory, 'holder.ts');
  await writeFile(
    fixture,
    `
import { withOwnershipFileLock } from ${JSON.stringify(join(import.meta.dir, 'ownership-file-lock.ts'))};
setTimeout(()=>process.exit(124),15000);
await withOwnershipFileLock(process.argv[2],async()=>{ console.log('locked'); await new Promise(()=>{setInterval(()=>{},1000)}); });
`,
  );
  const holder = spawn(process.execPath, [fixture, path], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const closed = new Promise((resolve, reject) => {
    holder.once('close', resolve);
    holder.once('error', reject);
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      holder.stdout.once('data', () => resolve());
      void closed.then(() => reject(new Error('holder exited before acquiring')), reject);
    });
    let ticks = 0,
      released = false;
    timer = setInterval(() => {
      ticks++;
    }, 10);
    const pending = withOwnershipFileLock(path, async () => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(released).toBe(false);
    expect(ticks).toBeGreaterThanOrEqual(3);
    holder.kill(); // Exact disposable child handle, simulating backend crash.
    await closed;
    await pending;
    expect(released).toBe(true);
  } finally {
    clearInterval(timer);
    if (holder.exitCode === null && holder.signalCode === null) holder.kill();
    await closed;
    for (const file of await readdir(directory)) await unlink(join(directory, file));
    await rmdir(directory);
  }
}, 10000);
