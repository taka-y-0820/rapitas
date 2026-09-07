/** Kill a dedicated writer after temp-file sync, before replacement. */
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

test('process death before replacement preserves the previous complete log', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'atomic-log-crash-'));
  const file = join(directory, 'execution.log');
  const ready = join(directory, 'ready');
  writeFileSync(file, 'previous complete log');
  const modulePath = join(import.meta.dir, 'atomic-text-file.ts');
  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `
    const {mock} = await import('bun:test');
    const fs = await import('fs/promises');
    const {writeFileSync} = await import('fs');
    mock.module('fs/promises', () => ({...fs, rename: async () => {
      writeFileSync(${JSON.stringify(ready)}, 'temp synced');
      await Bun.sleep(60000);
    }}));
    const {writeAtomicTextFile} = await import(${JSON.stringify(modulePath)});
    await writeAtomicTextFile(${JSON.stringify(file)}, 'next complete log');
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(ready)) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error('writer did not reach replacement');
      await Bun.sleep(10);
    }
    expect(child.exitCode).toBeNull();
    const temporary = readdirSync(directory).find((name) => name.endsWith('.tmp'))!;
    expect(readFileSync(join(directory, temporary), 'utf8')).toBe('next complete log');
    child.kill();
    await child.exited;
    expect(readFileSync(file, 'utf8')).toBe('previous complete log');
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
